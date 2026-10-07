// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Git history for the timeline: the list of commits (each merged PR is one step on the main line),
// the map as it was at any commit compared with its parent, and the "drift" of rule breaks over time.
// Everything is read from git objects (the working tree is never touched), in a worker thread so the
// live map never waits for git.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildGraph, createResolver, describeFile, diskIO, importDelta, importSpecs, isIgnored, isResolverConfig, isSource, toRel } from './core.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty tree: the "parent" of a root commit
const MAX_COMMITS = 500;
const MAX_SNAPSHOTS = 12;
const MAX_SCANS = 200_000;
const FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b%x1d';
/** Where a branch is compared from when no base is given: the main line, as GitHub's "Files changed" does. */
export const MAIN_REFS = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];

/** @typedef {import('./core.js').Rules} Rules */
/** @typedef {import('./core.js').Import} Import */
/** @typedef {import('./core.js').About} About */

/** "Merge pull request #12 from me/fix", "Fix the thing (#12)" or "Merge branch 'x'" -> what it was. */
function prInfo(/** @type {string} */ subject, /** @type {string} */ body) {
  let m = subject.match(/^Merge pull request #(\d+) from (\S+)/);
  if (m) return { pr: Number(m[1]), branch: m[2], title: body.split('\n').find((l) => l.trim())?.trim() || subject };
  m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (m) return { pr: null, branch: m[1], title: subject };
  m = subject.match(/^(.*\S)\s+\(#(\d+)\)$/);
  if (m) return { pr: Number(m[2]), branch: null, title: m[1] };
  return { pr: null, branch: null, title: subject };
}

function parseLog(/** @type {string} */ out) {
  return out.split('\x1e').slice(1).map((chunk) => {
    const [head, stat = ''] = chunk.split('\x1d');
    const [hash, parents, author, time, subject, body = ''] = head.split('\x1f');
    const num = (/** @type {RegExp} */ re) => Number(stat.match(re)?.[1] ?? 0);
    return {
      hash, parents: parents ? parents.split(' ') : [], author, time: Number(time) * 1000, subject, body: body.trim(),
      ...prInfo(subject, body.trim()),
      files: num(/(\d+) files? changed/), add: num(/(\d+) insertions?/), del: num(/(\d+) deletions?/),
    };
  });
}

const edgeKey = (/** @type {{ from: string, to: string }} */ e) => `${e.from}>${e.to}`;
/** Connections added, removed, or changed in count between two graphs. */
export function edgeDiff(/** @type {{ edges: any[] }} */ before, /** @type {{ edges: any[] }} */ after) {
  const slim = (/** @type {any} */ e) => ({ from: e.from, to: e.to, kind: e.kind, count: e.count });
  const was = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const is = new Map(after.edges.map((e) => [edgeKey(e), e]));
  return {
    added: [...is].filter(([k]) => !was.has(k)).map(([, e]) => slim(e)),
    removed: [...was].filter(([k]) => !is.has(k)).map(([, e]) => slim(e)),
    changed: [...is].filter(([k, e]) => was.has(k) && was.get(k).count !== e.count).map(([k, e]) => ({ ...slim(e), was: was.get(k).count })),
  };
}

/** The part of the history that does the work. Runs inside the worker (map server) or in-process (`al-dente diff`). */
export function createEngine(/** @type {string} */ root) {
  const git = (/** @type {string[]} */ args, /** @type {string=} */ input) =>
    execFileSync('git', ['-C', root, ...args], { input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const gitText = (/** @type {string[]} */ ...args) => git(args).toString('utf8');

  // Links for GitHub remotes. ponytail: GitHub only; add GitLab/Bitbucket URL shapes when someone asks.
  let web = null;
  try {
    const m = gitText('remote', 'get-url', 'origin').trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
    if (m) web = `https://github.com/${m[1]}`;
  } catch { /* no origin */ }

  /** @type {Map<string, string>} blob id -> text of a tsconfig/package.json (small; needed to resolve imports) */
  const configs = new Map();
  /** @type {Map<string, { specs: import('./core.js').Spec[], about: About }>} "blob:path" -> what's in that file. Blobs never change. */
  const scans = new Map();
  /** Imports resolved under one set of files + configs. Most commits only edit files, so this carries over. */
  let ctx = { sig: '', resolved: /** @type {Map<string, Import[]>} */ (new Map()) };
  let rulesKey = '';
  /** @type {Map<string, ReturnType<typeof buildGraph>>} */
  const snapshots = new Map();
  /** @type {Map<string, { violations: number, edges: { from: string, to: string, kind: string, count: number }[] }>} */
  const summaries = new Map();
  /** @type {{ key: string, commits: ReturnType<typeof parseLog>, points: Map<string, any>, done: boolean } | null} */
  let drift = null;
  /** @type {Map<string, { imports: Map<string, Import[]>, about: Map<string, About> }>} the last few loads (a commit view loads a rev several times) */
  const loads = new Map();

  /** Judgements depend on the plan: drop them when it changes. */
  function useRules(/** @type {Rules} */ rules) {
    const key = JSON.stringify([rules.parts.map((p) => [p.id, p.paths, p.uses]), rules.ignore]);
    if (key === rulesKey) return;
    rulesKey = key;
    snapshots.clear();
    summaries.clear();
    loads.clear();
    drift = null;
  }

  function treeAt(/** @type {string} */ rev) {
    /** @type {Map<string, string>} path -> blob id */
    const tree = new Map();
    if (rev === EMPTY_TREE) return tree;
    for (const entry of gitText('ls-tree', '-r', '-z', rev).split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab > 0) { const [, type, id] = entry.slice(0, tab).split(' '); if (type === 'blob') tree.set(entry.slice(tab + 1), id); }
    }
    return tree;
  }

  /** Read many blobs with one `git cat-file --batch`. */
  function readBlobs(/** @type {string[]} */ ids) {
    /** @type {Map<string, string>} */
    const out = new Map();
    const want = [...new Set(ids)];
    if (!want.length) return out;
    const buf = git(['cat-file', '--batch'], want.join('\n') + '\n');
    let i = 0;
    for (const id of want) {
      const nl = buf.indexOf(10, i);
      const [, type, size] = buf.toString('utf8', i, nl).split(' ');
      if (type !== 'blob') { i = nl + 1; continue; }
      out.set(id, buf.toString('utf8', nl + 1, nl + 1 + Number(size)));
      i = nl + 1 + Number(size) + 1;
    }
    return out;
  }

  /** Every checked source file at `rev`, with its resolved imports and description. */
  function load(/** @type {Rules} */ rules, /** @type {string} */ rev) {
    const hit = loads.get(rev);
    if (hit) return hit;
    const result = loadTree(rules, rev);
    loads.set(rev, result);
    if (loads.size > 6) loads.delete(/** @type {string} */ (loads.keys().next().value));
    return result;
  }

  function loadTree(/** @type {Rules} */ rules, /** @type {string} */ rev) {
    const tree = treeAt(rev);
    /** @type {string[]} */
    const all = [], cfgs = [];
    for (const rel of tree.keys()) {
      if (isSource(rel)) all.push(rel);
      else if (isResolverConfig(rel) || rel === 'pnpm-workspace.yaml') cfgs.push(rel);
    }
    const sources = all.filter((rel) => !isIgnored(rules, rel));
    const key = (/** @type {string} */ rel) => `${tree.get(rel)}:${rel}`;
    const missing = sources.filter((rel) => !scans.has(key(rel)));
    const missingCfg = cfgs.map((rel) => /** @type {string} */ (tree.get(rel))).filter((id) => !configs.has(id));
    const texts = readBlobs([...missing.map((rel) => /** @type {string} */ (tree.get(rel))), ...missingCfg]);
    for (const id of missingCfg) configs.set(id, texts.get(id) ?? '');
    if (scans.size + missing.length > MAX_SCANS) scans.clear(); // ponytail: crude cap; an LRU if very long histories thrash
    for (const rel of missing) {
      const text = texts.get(/** @type {string} */ (tree.get(rel))) ?? '';
      scans.set(key(rel), { specs: importSpecs(text, rel), about: describeFile(rel, text) });
    }

    // Resolution only depends on which files exist and on the configs, so reuse it while those stay the same.
    const sig = createHash('sha1').update(all.join('\n')).update('\0').update(cfgs.map((rel) => `${rel}:${tree.get(rel)}`).join('\n')).digest('hex');
    if (sig !== ctx.sig) ctx = { sig, resolved: new Map() };

    /** @type {Map<string, Set<string>>} */
    const dirs = new Map(), files = new Map();
    for (const rel of tree.keys()) {
      const segs = rel.split('/');
      for (let d = 1; d < segs.length; d++) {
        const parent = segs.slice(0, d - 1).join('/');
        if (!dirs.has(parent)) dirs.set(parent, new Set());
        /** @type {Set<string>} */ (dirs.get(parent)).add(segs[d - 1]);
      }
      const dir = segs.slice(0, -1).join('/');
      if (!files.has(dir)) files.set(dir, new Set());
      /** @type {Set<string>} */ (files.get(dir)).add(/** @type {string} */ (segs.at(-1)));
    }
    // Files inside the project come from the commit; anything outside (node_modules, a parent tsconfig) from disk.
    const inside = (/** @type {string} */ abs) => {
      const rel = toRel(root, abs);
      return rel.startsWith('..') || path.isAbsolute(rel) || rel.split('/').includes('node_modules') ? null : rel;
    };
    /** @type {import('./core.js').SourceIO} */
    const io = {
      isFile: (abs) => { const rel = inside(abs); return rel === null ? diskIO.isFile(abs) : tree.has(rel); },
      read: (abs) => {
        const rel = inside(abs);
        if (rel === null) return diskIO.read(abs);
        const text = configs.get(tree.get(rel) ?? '');
        if (text === undefined) throw new Error(`${rel} is not a config in ${rev}`);
        return text;
      },
      dirs: (abs) => { const rel = inside(abs); return rel === null ? diskIO.dirs(abs) : [...(dirs.get(rel) ?? [])]; },
      entries: (abs) => {
        const rel = inside(abs);
        return rel === null ? diskIO.entries(abs) : { dirs: [...(dirs.get(rel) ?? [])], files: [...(files.get(rel) ?? [])] };
      },
    };

    /** @type {ReturnType<typeof createResolver> | null} */
    let resolver = null;
    /** @type {Map<string, Import[]>} */
    const imports = new Map();
    /** @type {Map<string, About>} */
    const about = new Map();
    for (const rel of sources) {
      const k = key(rel);
      const scan = /** @type {{ specs: import('./core.js').Spec[], about: About }} */ (scans.get(k));
      let resolved = ctx.resolved.get(k);
      if (!resolved) {
        resolver ??= createResolver(root, io);
        resolved = resolver.resolveAll(rel, scan.specs);
        ctx.resolved.set(k, resolved);
      }
      imports.set(rel, resolved);
      about.set(rel, scan.about);
    }
    return { imports, about };
  }

  /** The full map at one commit (with the file index), judged by today's plan. */
  function snapshot(/** @type {Rules} */ rules, /** @type {string} */ rev) {
    const hit = snapshots.get(rev);
    if (hit) return hit;
    const { imports, about } = load(rules, rev);
    const graph = buildGraph(rules, imports, { index: true, about });
    snapshots.set(rev, graph);
    if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(/** @type {string} */ (snapshots.keys().next().value));
    return graph;
  }

  /** Just the numbers for one commit: rule breaks and connections. Cheap enough to do for the whole history. */
  function summary(/** @type {Rules} */ rules, /** @type {string} */ rev) {
    const hit = summaries.get(rev);
    if (hit) return hit;
    const g = buildGraph(rules, load(rules, rev).imports);
    const s = { violations: g.violations, edges: g.edges };
    summaries.set(rev, s);
    return s;
  }

  /** Files changed between two commits (no `to`: the working tree): status (A/M/D/R…), lines added/removed, old path for renames. */
  function changedFiles(/** @type {string} */ from, /** @type {string=} */ to) {
    const revs = to ? [from, to] : [from];
    /** @type {Map<string, { path: string, old: string | null, status: string, add: number | null, del: number | null }>} */
    const out = new Map();
    const st = gitText('diff', '--name-status', '-M', '-z', '--relative', ...revs).split('\0');
    for (let i = 0; i + 1 < st.length;) {
      const status = st[i][0];
      const renamed = status === 'R' || status === 'C';
      const old = renamed ? st[i + 1] : null, file = renamed ? st[i + 2] : st[i + 1];
      out.set(file, { path: file, old, status, add: null, del: null });
      i += renamed ? 3 : 2;
    }
    const ns = gitText('diff', '--numstat', '-M', '-z', '--relative', ...revs).split('\0');
    for (let i = 0; i < ns.length;) {
      const [a, d, file] = ns[i].split('\t');
      if (d === undefined) { i++; continue; }
      const name = file || ns[i + 2]; // renames: "a\td\t" then old\0new\0
      i += file ? 1 : 3;
      const entry = out.get(name);
      if (entry) Object.assign(entry, { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) });
    }
    return [...out.values()];
  }

  /** @type {Map<boolean, { ready: boolean, byHash: Record<string, [number, number, number]> }>} lines changed per commit */
  const stats = new Map();
  /**
   * Lines added/removed per commit come from `git log --shortstat`, which has to diff every commit (a big
   * first commit alone can take a second), so it runs asynchronously and arrives with the drift.
   */
  function startStats(/** @type {boolean} */ all) {
    const entry = { ready: false, byHash: /** @type {Record<string, [number, number, number]>} */ ({}) };
    stats.set(all, entry);
    execFile('git', ['-C', root, 'log', ...(all ? [] : ['--first-parent']), `-n${MAX_COMMITS}`, '--format=%x1e%H', '--shortstat', '--', '.'],
      { maxBuffer: 1 << 28, windowsHide: true }, (err, out) => {
        if (!err) {
          for (const chunk of out.split('\x1e').slice(1)) {
            const [hash, ...rest] = chunk.split('\n');
            const stat = rest.join(' ');
            const num = (/** @type {RegExp} */ re) => Number(stat.match(re)?.[1] ?? 0);
            entry.byHash[hash.trim()] = [num(/(\d+) files? changed/), num(/(\d+) insertions?/), num(/(\d+) deletions?/)];
          }
        }
        entry.ready = true;
      });
  }

  function log(/** @type {boolean} */ all) {
    const out = gitText('log', ...(all ? [] : ['--first-parent']), `-n${MAX_COMMITS}`, `--format=${FORMAT}`, '--', '.');
    let branch = null;
    try { branch = gitText('rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* no commits yet */ }
    startStats(all); // the history may have moved: count again
    return { commits: parseLog(out), branch, web };
  }

  const api = {
    web,
    changedFiles,
    /** Every checked source file at `rev`, with its resolved imports. */
    imports(/** @type {Rules} */ rules, /** @type {string} */ rev) { useRules(rules); return load(rules, rev).imports; },

    /** Newest first. `all` includes commits from merged branches; otherwise one step per merge/PR on this branch. */
    log,

    /** One commit: what it says, which files it changed, and how the map changed compared with its first parent (or `base`). */
    commit(/** @type {Rules} */ rules, /** @type {string} */ rev, /** @type {string=} */ base) {
      useRules(rules);
      const [meta] = parseLog(gitText('show', '-s', `--format=${FORMAT}`, rev));
      const parent = base ?? meta.parents[0] ?? EMPTY_TREE;
      const graph = snapshot(rules, meta.hash);
      const before = load(rules, parent).imports;
      const now = load(rules, meta.hash).imports;
      const changes = changedFiles(parent, meta.hash).map((f) => {
        const rel = f.path;
        const ignored = isIgnored(rules, rel);
        const source = !ignored && (isSource(rel) || (f.old !== null && isSource(f.old)));
        const delta = source ? importDelta(rules, rel, before.get(f.old ?? rel) ?? [], now.get(rel) ?? []) : null;
        return { ...f, part: delta?.part ?? null, source, ignored, delta };
      });
      return {
        commit: { ...meta, url: web ? `${web}/commit/${meta.hash}` : null, prUrl: web && meta.pr ? `${web}/pull/${meta.pr}` : null },
        graph,
        changes,
        edges: edgeDiff(summary(rules, parent), graph),
        violations: { before: summary(rules, parent).violations, after: graph.violations },
        range: { from: parent, to: meta.hash }, // for line diffs of its files
      };
    },

    /**
     * The checked-out branch against where it forked from the main line: everything merging it would bring,
     * like a PR's "Files changed" tab. Committed work only: uncommitted edits aren't part of a PR yet.
     */
    compare(/** @type {Rules} */ rules) {
      const head = gitText('rev-parse', 'HEAD').trim();
      for (const ref of MAIN_REFS) {
        let fork;
        try { fork = gitText('merge-base', ref, head).trim(); } catch { continue; }
        const base = gitText('rev-parse', '--abbrev-ref', ref).trim().replace(/^origin\//, '');
        const branch = gitText('rev-parse', '--abbrev-ref', 'HEAD').trim();
        const commits = parseLog(gitText('log', `--format=${FORMAT}`, `${fork}..${head}`, '--', '.'));
        const c = api.commit(rules, head, fork);
        return {
          ...c,
          commit: { ...c.commit, pr: null, parents: [], title: branch, url: web ? `${web}/compare/${base}...${branch}` : null },
          compare: { base, branch, commits: commits.map(({ hash, title, author, time }) => ({ hash, title, author, time })) },
        };
      }
      throw new Error('No main or master branch to compare with.');
    },

    /**
     * Rule breaks and connections for every commit in the log, newest first. Computed in the background;
     * call again to collect what's done so far.
     */
    drift(/** @type {Rules} */ rules, /** @type {boolean} */ all) {
      useRules(rules);
      const key = `${rulesKey}|${all}`;
      if (!drift || drift.key !== key) {
        const run = { key, commits: log(all).commits, points: new Map(), done: false };
        drift = run;
        (async () => {
          for (const c of run.commits) {
            if (drift !== run) return; // the plan or the mode changed: a newer run took over
            const s = summary(rules, c.hash);
            const p = c.parents[0] ? summary(rules, c.parents[0]) : { violations: 0, edges: [] };
            const d = edgeDiff(p, s);
            run.points.set(c.hash, {
              hash: c.hash, v: s.violations, dv: s.violations - p.violations,
              links: s.edges.filter((e) => e.kind !== 'unchecked').length, added: d.added.length, removed: d.removed.length,
            });
            await new Promise((r) => setImmediate(r)); // let commit requests in between
          }
          run.done = true;
        })().catch(() => { run.done = true; });
      }
      const lines = stats.get(all);
      return { points: [...drift.points.values()], total: drift.commits.length, stats: lines?.ready ? lines.byHash : null, done: drift.done && !!lines?.ready };
    },

    /** HEAD moved: the next drift call starts over (per-commit results stay cached, so only new commits cost). */
    headMoved() { drift = null; },
  };
  return api;
}

/** Runs the engine in a worker thread and talks to it with messages. */
export function createHistory(/** @type {string} */ root) {
  let available = false;
  try {
    available = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .toString().trim() === 'true';
  } catch { /* no git, or not a repo */ }

  /** @type {Worker | null} */
  let worker = null;
  let seq = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const waiting = new Map();
  const failAll = (/** @type {Error} */ e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); worker = null; };

  const call = (/** @type {string} */ method, /** @type {unknown[]} */ ...args) => new Promise((resolve, reject) => {
    if (!worker) {
      const w = new Worker(new URL(import.meta.url), { workerData: { alDenteHistory: root } });
      w.on('message', (/** @type {{ id: number, ok: boolean, result?: any, error?: string }} */ m) => {
        const p = waiting.get(m.id);
        if (!p) return;
        waiting.delete(m.id);
        if (!waiting.size) w.unref(); // an idle worker never keeps the process alive
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      });
      w.on('error', failAll);
      w.on('exit', () => failAll(new Error('history worker stopped')));
      worker = w;
    }
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.ref();
    worker.postMessage({ id, method, args });
  });

  /** HEAD moved: make the next drift include the new commits (messages to the worker stay in order). */
  const headMoved = () => (worker ? call('headMoved') : Promise.resolve());

  return {
    available,
    log: (/** @type {boolean} */ all) => call('log', all),
    commit: (/** @type {Rules} */ rules, /** @type {string} */ rev) => call('commit', rules, rev),
    compare: (/** @type {Rules} */ rules) => call('compare', rules),
    drift: (/** @type {Rules} */ rules, /** @type {boolean} */ all) => call('drift', rules, all),
    headMoved,
    /** Call `cb` when HEAD moves (commit, merge, pull, checkout, reset). */
    watch(/** @type {() => void} */ cb) {
      if (!available) return;
      try {
        const reflog = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'logs/HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
        fs.watchFile(path.resolve(root, reflog), { interval: 2000 }, () => { headMoved().catch(() => {}); cb(); });
      } catch { /* no reflog: the timeline still works, it just won't refresh by itself */ }
    },
    close: () => worker?.terminate(),
  };
}

if (!isMainThread && workerData?.alDenteHistory) {
  const engine = /** @type {Record<string, (...a: any[]) => any>} */ (createEngine(workerData.alDenteHistory));
  parentPort?.on('message', (/** @type {{ id: number, method: string, args: any[] }} */ { id, method, args }) => {
    try { parentPort?.postMessage({ id, ok: true, result: engine[method](...args) }); }
    catch (e) { parentPort?.postMessage({ id, ok: false, error: String(/** @type {Error} */ (e)?.message ?? e) }); }
  });
}
