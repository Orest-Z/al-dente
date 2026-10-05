// @ts-check
// Local live-map server: keeps the import graph in memory, watches the project,
// takes "an agent just edited X" pings from the hook, and streams updates over SSE.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_FILE, buildGraph, createResolver, isResolverConfig, isSource, listSources, partOf, readRules, toRel, violationsIn } from './core.js';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
});
const GRACE_MS = 1500; // how long a file change waits for the agent hook to claim it before it counts as yours
const FEED_SIZE = 60;

/** @typedef {import('./core.js').Import} Import */

/** @param {{ root: string, port: number }} opts */
export function startServer({ root, port }) {
  let resolver = createResolver(root);
  /** @type {import('./core.js').Rules | null} */
  let rules = null;
  /** @type {string | null} */
  let rulesError = null;
  /** @type {Map<string, { imports: Import[], sig: string }>} */
  const files = new Map();
  /** @type {any[]} */
  const feed = [];
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  /** @type {Map<string, NodeJS.Timeout>} */
  const pending = new Map();
  let nextId = 1;

  const sigOf = (/** @type {string} */ abs) => {
    try { const s = fs.statSync(abs); return `${s.mtimeMs}:${s.size}`; } catch { return null; }
  };

  function loadRules() {
    try { rules = readRules(root); rulesError = null; }
    catch (e) { rules = null; rulesError = /** @type {Error} */ (e).message; }
  }

  function analyze(/** @type {string} */ rel) {
    const sig = sigOf(path.join(root, rel));
    try { if (sig) return void files.set(rel, { imports: resolver.importsOf(rel), sig }); }
    catch { /* deleted or unreadable mid-write */ }
    files.delete(rel);
  }

  function scanAll() {
    files.clear();
    for (const rel of listSources(root)) analyze(rel);
  }

  function state() {
    const base = { project: path.basename(root) };
    if (!rules) return { ...base, missing: !rulesError, error: rulesError };
    return { ...base, ...buildGraph(rules, new Map([...files].map(([rel, f]) => [rel, f.imports]))) };
  }

  const send = (/** @type {http.ServerResponse} */ res, /** @type {string} */ event, /** @type {unknown} */ data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (/** @type {string} */ event, /** @type {unknown} */ data) => { for (const res of clients) send(res, event, data); };

  /** Send the new graph first, then the activity entry that explains it. */
  function publish(/** @type {any} */ entry) {
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
      return publish({ id: nextId++, time: Date.now(), actor, tool, kind: 'rules', file: rel, error: rulesError, parts: rules?.parts.length ?? 0 });
    }
    if (isResolverConfig(rel)) {
      resolver = createResolver(root);
      scanAll();
      return publish(null);
    }
    if (!isSource(rel)) return;

    const prev = files.get(rel);
    const sig = sigOf(path.join(root, rel));
    if (prev && sig === prev.sig) return actor === 'agent' && tool ? claim(rel, tool) : undefined;
    if (!prev && !sig) return;
    const kind = !sig ? 'deleted' : prev ? 'changed' : 'created';

    // Blast radius: the files that import this one, collected before anything moves.
    const importers = [...files].filter(([f, { imports }]) => f !== rel && imports.some((i) => i.target === rel)).map(([f]) => f);
    const before = prev?.imports ?? [];
    if (kind === 'changed') analyze(rel);
    else { resolver.reset(); scanAll(); } // ponytail: full rescan on create/delete; track unresolved specifiers if big repos feel slow
    const after = files.get(rel)?.imports ?? [];
    publish(rules ? describe(rel, actor, tool, kind, before, after, importers) : null);
  }

  function describe(
    /** @type {string} */ rel, /** @type {string} */ actor, /** @type {string=} */ tool, /** @type {string} */ kind,
    /** @type {Import[]} */ before, /** @type {Import[]} */ after, /** @type {string[]} */ importers,
  ) {
    const r = /** @type {import('./core.js').Rules} */ (rules);
    const part = partOf(r, rel);
    const key = (/** @type {Import} */ v) => `${v.target}|${v.spec}`;
    const was = violationsIn(r, rel, before), now = violationsIn(r, rel, after);
    const slim = (/** @type {Import & { to: string }} */ v) => ({ line: v.line, spec: v.spec, target: v.target, to: v.to });
    const uniq = (/** @type {(string | null)[]} */ ids) => [...new Set(ids.filter((p) => p && p !== part))];
    return {
      id: nextId++, time: Date.now(), actor, tool, kind, file: rel, part,
      links: uniq(after.map((i) => partOf(r, i.target))),
      broke: now.filter((v) => !was.some((w) => key(w) === key(v))).map(slim),
      fixed: was.filter((v) => !now.some((w) => key(w) === key(v))).map(slim),
      affected: uniq(importers.map((f) => partOf(r, f))),
      importers: importers.length,
      violations: now.length,
    };
  }

  function watch() {
    try {
      fs.watch(root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const rel = name.split(path.sep).join('/');
        if (rel !== RULES_FILE && !isResolverConfig(rel) && !isSource(rel)) return;
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

  const sameDir = (/** @type {string} */ a, /** @type {string} */ b) =>
    process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

  const server = http.createServer(async (req, res) => {
    // Only answer to our own origin, so other websites can't read the project through DNS rebinding.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return void res.writeHead(403).end();
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      send(res, 'state', state());
      send(res, 'feed', feed);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      return void req.on('close', () => { clearInterval(ping); clients.delete(res); });
    }
    if (url.pathname === '/api/state') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state()));
    }
    if (url.pathname === '/api/agent-edit' && req.method === 'POST') {
      try {
        const body = /** @type {any} */ (await readBody(req));
        if (!body?.file || !sameDir(String(body.root ?? ''), root)) return void res.writeHead(409).end();
        const rel = toRel(root, String(body.file));
        clearTimeout(pending.get(rel));
        pending.delete(rel);
        apply(rel, 'agent', body.tool ? String(body.tool) : undefined);
        return void res.writeHead(204).end();
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
  watch();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://localhost:${port}`, server }));
  });
}
