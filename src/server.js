// @ts-check
// Local live-map server: keeps the import graph in memory, watches the project,
// takes "an agent just edited X" pings from the hook, and streams updates over SSE.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES_FILE, buildGraph, createResolver, describeFile, fileEntry, importDelta, importSpecs, isGitIgnored, isIgnored,
  isResolverConfig, isSource, listSources, partOf, readRules, skippedDir, toRel,
} from './core.js';
import { createHistory } from './history.js';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
});
const GRACE_MS = 1500; // how long a file change waits for the agent hook to claim it before it counts as yours
const FEED_SIZE = 60;

/** @typedef {import('./core.js').Import} Import */
/** @typedef {{ sig: string, specs: import('./core.js').Spec[], about: import('./core.js').About, imports: Import[] }} Analysed */

/**
 * Call `onChange(rel)` for changes under `root`. macOS and Windows watch a tree natively; Node's recursive
 * watch on Linux adds a watcher for every folder, node_modules included, which is slow and can run out of
 * inotify watches, so there we watch only the folders that can hold source.
 */
export function watchTree(/** @type {string} */ root, /** @type {(rel: string) => void} */ onChange, recursive = process.platform !== 'linux') {
  const emit = (/** @type {string} */ abs) => onChange(toRel(root, abs));
  if (recursive) return void fs.watch(root, { recursive: true }, (_e, name) => { if (name) emit(path.join(root, name.toString())); });
  /** @type {Map<string, fs.FSWatcher>} */
  const watched = new Map();
  const add = (/** @type {string} */ dir, /** @type {boolean} */ fresh) => {
    if (watched.has(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    try {
      const w = fs.watch(dir, (_e, name) => {
        if (!name) return;
        const abs = path.join(dir, name.toString());
        if (!skippedDir(name.toString()) && fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) add(abs, true);
        else emit(abs);
      });
      w.on('error', () => { w.close(); watched.delete(dir); });
      watched.set(dir, w);
    } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!skippedDir(e.name)) add(path.join(dir, e.name), fresh); }
      else if (fresh) emit(path.join(dir, e.name)); // files that landed in a new folder before we watched it
    }
  };
  add(root, false);
}

/** @param {{ root: string, port: number }} opts */
export function startServer({ root, port }) {
  let resolver = createResolver(root);
  /** @type {import('./core.js').Rules | null} */
  let rules = null;
  /** @type {string | null} */
  let rulesError = null;
  /** @type {Map<string, Analysed>} */
  const files = new Map();
  /** @type {Set<string>} source files git ignores (generated code): never analysed, never rescanned for */
  const gitIgnored = new Set();
  /** @type {Map<string, { key: string, json: string }>} the file index as the browsers have it */
  const sent = new Map();
  /** @type {any[]} */
  const feed = [];
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  /** @type {Map<string, NodeJS.Timeout>} */
  const pending = new Map();
  let nextId = 1;
  const history = createHistory(root);

  const sigOf = (/** @type {string} */ abs) => {
    try { const s = fs.statSync(abs); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
  };

  function loadRules() {
    try { rules = readRules(root); rulesError = null; }
    catch (e) { rules = null; rulesError = /** @type {Error} */ (e).message; }
  }

  /** Read and scan a file if it changed on disk; the scan is kept, so re-resolving later needs no reading. */
  function read(/** @type {string} */ rel) {
    const abs = path.join(root, rel);
    const sig = sigOf(abs);
    const prev = files.get(rel);
    if (prev && prev.sig === sig) return prev;
    try {
      if (!sig) throw new Error('gone');
      const text = fs.readFileSync(abs, 'utf8');
      /** @type {Analysed} */
      const entry = { sig, specs: importSpecs(text), about: describeFile(rel, text), imports: [] };
      files.set(rel, entry);
      return entry;
    } catch { files.delete(rel); return null; } // deleted or unreadable mid-write
  }

  /** Resolve every file again (cheap: the scans are cached). Needed when files appear or vanish, or configs change. */
  function resolveAll() {
    resolver.reset();
    for (const [rel, f] of files) f.imports = resolver.resolveAll(rel, f.specs);
  }

  function scanAll() {
    resolver = createResolver(root);
    const listed = new Set(listSources(root));
    for (const rel of files.keys()) if (!listed.has(rel)) files.delete(rel);
    for (const rel of listed) read(rel);
    resolveAll();
  }

  function state() {
    const base = { project: path.basename(root), git: history.available };
    if (!rules) return { ...base, missing: !rulesError, error: rulesError };
    return { ...base, ...buildGraph(rules, new Map([...files].map(([rel, f]) => [rel, f.imports]))) };
  }

  const send = (/** @type {http.ServerResponse} */ res, /** @type {string} */ event, /** @type {string} */ json) =>
    res.write(`event: ${event}\ndata: ${json}\n\n`);
  const broadcast = (/** @type {string} */ event, /** @type {unknown} */ data) => {
    const json = JSON.stringify(data);
    for (const res of clients) send(res, event, json);
  };

  /**
   * Bring the browsers' file index up to date. Only entries that really changed go out, so saving one file
   * sends one entry, not the whole repo. `only` limits the check to some files.
   */
  function syncIndex(/** @type {Iterable<string> | null} */ only) {
    /** @type {Record<string, unknown>} */
    const set = {};
    /** @type {string[]} */
    const del = [];
    const check = only ? [...only] : [...new Set([...files.keys(), ...sent.keys()])];
    for (const rel of check) {
      const f = files.get(rel);
      if (!f || !rules || isIgnored(rules, rel)) { if (sent.delete(rel)) del.push(rel); continue; }
      const entry = fileEntry(rules, rel, f.imports, f.about);
      const key = `${entry.part}|${entry.about?.text}|${entry.imports.map((i) => `${i.spec}>${i.target}:${i.line}:${i.to}`).join(',')}`;
      if (sent.get(rel)?.key === key) continue;
      const json = JSON.stringify(entry);
      sent.set(rel, { key, json });
      set[rel] = entry;
    }
    if (del.length || Object.keys(set).length) broadcast('patch', { set, del });
  }
  const fullIndex = () => `{${[...sent].map(([rel, { json }]) => `${JSON.stringify(rel)}:${json}`).join(',')}}`;

  /** Send the new graph and file changes first, then the activity entry that explains them. */
  function publish(/** @type {any} */ entry, /** @type {Iterable<string> | null} */ changed) {
    syncIndex(changed);
    broadcast('state', state());
    if (!entry) return;
    feed.unshift(entry);
    feed.length = Math.min(feed.length, FEED_SIZE);
    broadcast('activity', entry);
  }

  /** The hook arrived after the watcher already logged this change: re-label it as the agent's. */
  function claim(/** @type {string} */ rel, /** @type {string} */ tool) {
    const entry = feed.find((a) => a.file === rel);
    if (entry && entry.actor === 'you' && Date.now() - entry.time < 15_000) {
      Object.assign(entry, { actor: 'agent', tool });
      broadcast('activity', entry);
    }
  }

  function apply(/** @type {string} */ rel, /** @type {'agent' | 'you'} */ actor, /** @type {string=} */ tool) {
    if (rel === RULES_FILE) {
      loadRules();
      return publish({ id: nextId++, time: Date.now(), actor, tool, kind: 'rules', file: rel, error: rulesError, parts: rules?.parts.length ?? 0 }, null);
    }
    if (isResolverConfig(rel)) {
      resolver = createResolver(root);
      resolveAll();
      return publish(null, null);
    }
    if (path.posix.basename(rel) === '.gitignore') {
      gitIgnored.clear();
      scanAll();
      return publish(null, null);
    }
    if (!isSource(rel) || gitIgnored.has(rel)) return;

    const prev = files.get(rel);
    const sig = sigOf(path.join(root, rel));
    if (prev && sig === prev.sig) return actor === 'agent' && tool ? claim(rel, tool) : undefined;
    if (!prev && !sig) return;
    const kind = !sig ? 'deleted' : prev ? 'changed' : 'created';
    if (kind === 'created' && isGitIgnored(root, rel)) return void gitIgnored.add(rel);

    // Blast radius: the files that import this one, collected before anything moves.
    const importers = [...files].filter(([f, { imports }]) => f !== rel && imports.some((i) => i.target === rel)).map(([f]) => f);
    const before = prev?.imports ?? [];
    if (kind === 'deleted') files.delete(rel);
    else read(rel);
    if (kind === 'changed') {
      const f = files.get(rel);
      if (f) f.imports = resolver.resolveAll(rel, f.specs);
    } else resolveAll(); // a file appeared or vanished: other files' imports may now resolve differently
    const after = files.get(rel)?.imports ?? [];
    publish(rules ? describe(rel, actor, tool, kind, before, after, importers) : null, kind === 'changed' ? [rel] : null);
  }

  function describe(
    /** @type {string} */ rel, /** @type {string} */ actor, /** @type {string=} */ tool, /** @type {string} */ kind,
    /** @type {Import[]} */ before, /** @type {Import[]} */ after, /** @type {string[]} */ importers,
  ) {
    const r = /** @type {import('./core.js').Rules} */ (rules);
    const base = { id: nextId++, time: Date.now(), actor, tool, kind, file: rel };
    if (isIgnored(r, rel)) return { ...base, part: partOf(r, rel), ignored: true, links: [], broke: [], fixed: [], affected: [], importers: 0, violations: 0 };
    const { part, links, broke, fixed, violations } = importDelta(r, rel, before, after);
    const affected = [...new Set(importers.filter((f) => !isIgnored(r, f)).map((f) => partOf(r, f)).filter((p) => p && p !== part))];
    return { ...base, part, links, broke, fixed, affected, importers: importers.length, violations };
  }

  function watch() {
    try {
      watchTree(root, (rel) => {
        if (rel !== RULES_FILE && !isResolverConfig(rel) && !isSource(rel) && path.posix.basename(rel) !== '.gitignore') return;
        clearTimeout(pending.get(rel));
        pending.set(rel, setTimeout(() => { pending.delete(rel); apply(rel, 'you'); }, GRACE_MS));
      });
    } catch {
      console.warn('al-dente: file watching is not available here, so only agent edits will update the map.');
    }
  }

  const readBody = (/** @type {http.IncomingMessage} */ req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const json = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const sameDir = (/** @type {string} */ a, /** @type {string} */ b) =>
    process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

  const server = http.createServer(async (req, res) => {
    // Only answer to our own origin, so other websites can't read the project through DNS rebinding.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return void res.writeHead(403).end();
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      send(res, 'state', JSON.stringify(state()));
      send(res, 'files', fullIndex());
      send(res, 'feed', JSON.stringify(feed));
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      return void req.on('close', () => { clearInterval(ping); clients.delete(res); });
    }
    if (url.pathname === '/api/state') return void json(res, 200, state());
    if (url.pathname === '/api/history') {
      if (!history.available) return void json(res, 404, { error: 'This project is not in a git repository.' });
      try { return void json(res, 200, await history.log(url.searchParams.get('all') === '1')); }
      catch { return void json(res, 200, { commits: [], branch: null, web: null }); } // a repo with no commits yet
    }
    if (url.pathname === '/api/commit' || url.pathname === '/api/drift') {
      const rev = url.searchParams.get('rev') ?? '';
      if (!history.available) return void json(res, 404, { error: 'This project is not in a git repository.' });
      if (!rules) return void json(res, 409, { error: `Save ${RULES_FILE} first: history is drawn against the plan.` });
      if (url.pathname === '/api/drift') {
        try { return void json(res, 200, await history.drift(rules, url.searchParams.get('all') === '1')); }
        catch { return void json(res, 200, { points: [], total: 0, done: true }); }
      }
      if (!/^[0-9a-f]{4,64}$/i.test(rev)) return void json(res, 400, { error: 'Unknown commit.' });
      try { return void json(res, 200, await history.commit(rules, rev)); }
      catch { return void json(res, 404, { error: `Could not read commit ${rev}.` }); }
    }
    if (url.pathname === '/api/agent-edit' && req.method === 'POST') {
      try {
        const body = /** @type {any} */ (await readBody(req));
        if (!body?.file || !sameDir(String(body.root ?? ''), root)) return void res.writeHead(409).end();
        const rel = toRel(root, String(body.file));
        clearTimeout(pending.get(rel));
        pending.delete(rel);
        res.writeHead(204).end(); // answer first: the hook (and so Claude) never waits for the map
        setImmediate(() => apply(rel, 'agent', body.tool ? String(body.tool) : undefined));
        return;
      } catch { return void res.writeHead(400).end(); }
    }

    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const type = TYPES[path.extname(name)];
    const file = path.join(UI_DIR, name);
    if (!type || !fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(fs.readFileSync(file));
  });

  loadRules();
  scanAll();
  syncIndex(null);
  watch();
  history.watch(() => broadcast('history', {}));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://localhost:${port}`, server }));
  });
}
