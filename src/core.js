// @ts-check
// Core of al-dente: read the architecture rules, resolve each file's imports
// (no dependencies, any TypeScript version), and turn them into a part-level graph.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const RULES_FILE = 'al-dente.json';
export const UNMAPPED = '~unmapped';
const SOURCE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/** Project-relative path with forward slashes, e.g. "src/ui/Button.tsx". */
export const toRel = (/** @type {string} */ root, /** @type {string} */ file) =>
  path.relative(root, path.resolve(root, file)).split(path.sep).join('/');

const skippedDir = (/** @type {string} */ name) => SKIP_DIRS.has(name) || name.startsWith('.');

/** Is this a source file inside the project that we should analyse? */
export function isSource(/** @type {string} */ rel) {
  if (!SOURCE.test(rel) || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split('/').slice(0, -1).some(skippedDir);
}

/** A tsconfig/jsconfig/package.json whose change can alter how imports resolve. */
export const isResolverConfig = (/** @type {string} */ rel) =>
  /(?:^|\/)(?:[tj]sconfig[^/]*|package)\.json$/.test(rel) && !rel.split('/').slice(0, -1).some(skippedDir);

/** Every source file in the project, skipping dependencies, build output and dot-folders. */
export function listSources(/** @type {string} */ root) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!skippedDir(entry.name)) walk(path.join(dir, entry.name)); }
      else if (SOURCE.test(entry.name)) out.push(toRel(root, path.join(dir, entry.name)));
    }
  };
  walk(root);
  return out.sort();
}

// ---------------------------------------------------------------- rules

/**
 * @typedef {{ id: string, label: string, description: string, paths: string[], uses: string[] }} Part
 * @typedef {{ parts: Part[], byId: Map<string, Part>, prefixes: { prefix: string, id: string }[] }} Rules
 */

const normPath = (/** @type {unknown} */ p) =>
  String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Load al-dente.json. Returns null when the project has none; throws a readable error when it's invalid. */
export function readRules(/** @type {string} */ root) {
  const file = path.join(root, RULES_FILE);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${RULES_FILE} is not valid JSON (${/** @type {Error} */ (e).message})`); }
  const parts = raw?.parts;
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) throw new Error(`${RULES_FILE} needs a "parts" object`);

  const ids = Object.keys(parts);
  /** @type {Part[]} */
  const list = ids.map((id) => {
    const p = parts[id] ?? {};
    const paths = (Array.isArray(p.paths) ? p.paths : []).map(normPath).filter(Boolean);
    if (!paths.length) throw new Error(`part "${id}" needs at least one folder in "paths"`);
    const uses = Array.isArray(p.uses) ? p.uses.map(String) : [];
    for (const u of uses) if (!ids.includes(u)) throw new Error(`part "${id}" uses "${u}", which is not a part`);
    return { id, label: String(p.label || id), description: String(p.description || ''), paths, uses };
  });
  // Longest prefix wins, so "src/features/cart" can be its own part inside "src/features".
  const prefixes = list.flatMap((p) => p.paths.map((prefix) => ({ prefix, id: p.id })))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return { parts: list, byId: new Map(list.map((p) => [p.id, p])), prefixes };
}

/** Which part a file belongs to, or null if no part claims it. */
export function partOf(/** @type {Rules} */ rules, /** @type {string} */ rel) {
  for (const { prefix, id } of rules.prefixes) if (rel === prefix || rel.startsWith(prefix + '/')) return id;
  return null;
}

const allowed = (/** @type {Rules} */ rules, /** @type {string} */ from, /** @type {string} */ to) =>
  /** @type {Part} */ (rules.byId.get(from)).uses.includes(to);

// ---------------------------------------------------------------- imports

/** @typedef {{ spec: string, target: string, line: number }} Import */

/**
 * Blank out comments (keeping every newline, so positions and line numbers stay true)
 * while stepping over strings, so "//" inside a URL string isn't mistaken for a comment.
 * ponytail: regex literals and `${}` with nested backticks aren't lexed; they're rare around imports.
 */
export function stripComments(/** @type {string} */ src) {
  const out = [];
  let last = 0, i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const close = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : d === '/' ? close : close + 2;
      out.push(src.slice(last, i), src.slice(i, end).replace(/[^\n]/g, ' '));
      last = i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c && (c === '`' || src[i] !== '\n'); i++) if (src[i] === '\\') i++;
      i++;
    } else i++;
  }
  out.push(src.slice(last));
  return out.join('');
}

const IMPORT_PATTERNS = [
  /(?:^|[^\w$.])(?:import|export)\s*(?:type\s+)?(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g, // import x from 'y', import 'y', export * from 'y'
  /(?:^|[^\w$.])import\s*\(\s*(['"`])([^'"`\n$]+)\1/g, // import('y')
  /(?:^|[^\w$.])require\s*\(\s*(['"`])([^'"`\n$]+)\1\s*\)/g, // require('y'), import x = require('y')
];

/** Every module specifier in a file, with the position of the specifier. */
export function scanImports(/** @type {string} */ src) {
  const code = stripComments(src);
  /** @type {{ spec: string, pos: number }[]} */
  const found = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of code.matchAll(re)) found.push({ spec: m[2], pos: /** @type {number} */ (m.index) + m[0].lastIndexOf(m[1] + m[2]) });
  }
  return found.sort((a, b) => a.pos - b.pos);
}

const TS_FIRST = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_EXT = /\.(?:[cm]?js|jsx)$/;

const readJsonc = (/** @type {string} */ file) =>
  JSON.parse(stripComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1'));

/**
 * Resolves imports the way TypeScript and bundlers do, without needing TypeScript itself:
 * relative paths, index files, ".js -> .ts" ESM imports, tsconfig/jsconfig "paths" + "baseUrl"
 * (following "extends" and "references"), and monorepo workspace packages by name.
 */
export function createResolver(/** @type {string} */ root) {
  root = path.resolve(root);
  /** @type {Map<string, boolean>} */
  const isFileCache = new Map();
  /** @type {Map<string, any>} */
  const configCache = new Map();

  const isFile = (/** @type {string} */ p) => {
    let hit = isFileCache.get(p);
    if (hit === undefined) isFileCache.set(p, (hit = fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false));
    return hit;
  };

  /** "./x" -> the real file: exact .ts sibling of a .js import, then extensions, then index files. */
  const resolveFile = (/** @type {string} */ base) => {
    if (JS_EXT.test(base)) {
      const stem = base.replace(JS_EXT, '');
      for (const ext of TS_FIRST) if (isFile(stem + ext)) return stem + ext;
    }
    if (SOURCE.test(base) && isFile(base)) return base;
    for (const ext of TS_FIRST) if (isFile(base + ext)) return base + ext;
    for (const ext of TS_FIRST) if (isFile(path.join(base, 'index' + ext))) return path.join(base, 'index' + ext);
    return null;
  };

  // --- tsconfig / jsconfig

  const configFile = (/** @type {string} */ p) => (isFile(p) ? p : path.join(p, 'tsconfig.json'));

  const resolveExtends = (/** @type {string} */ ext, /** @type {string} */ dir) => {
    if (ext.startsWith('.') || path.isAbsolute(ext)) {
      const p = path.resolve(dir, ext);
      return isFile(p) ? p : isFile(p + '.json') ? p + '.json' : configFile(p);
    }
    const req = createRequire(path.join(dir, 'tsconfig.json'));
    for (const name of [ext, `${ext}.json`, `${ext}/tsconfig.json`]) {
      try { return req.resolve(name); } catch { /* next */ }
    }
    return null;
  };

  /** The settings that matter for resolution, after following "extends". */
  const readConfig = (/** @type {string} */ file, /** @type {Set<string>} */ seen = new Set()) => {
    if (seen.has(file) || !isFile(file)) return { refs: [] };
    seen.add(file);
    let json;
    try { json = readJsonc(file); } catch { return { refs: [] }; }
    const dir = path.dirname(file);
    /** @type {{ baseUrl?: string, paths?: Record<string, string[]>, pathsDir?: string, refs: string[] }} */
    let opts = { refs: [] };
    for (const parent of [json.extends].flat().filter(Boolean)) {
      const parentFile = resolveExtends(String(parent), dir);
      if (parentFile) opts = { ...opts, ...readConfig(parentFile, seen), refs: [] };
    }
    const co = json.compilerOptions ?? {};
    if (typeof co.baseUrl === 'string') opts.baseUrl = path.resolve(dir, co.baseUrl);
    if (co.paths && typeof co.paths === 'object') { opts.paths = co.paths; opts.pathsDir = dir; }
    opts.refs = (Array.isArray(json.references) ? json.references : [])
      .filter((r) => typeof r?.path === 'string').map((r) => configFile(path.resolve(dir, r.path)));
    return opts;
  };

  /** Aliases + baseUrls for the nearest tsconfig/jsconfig above a folder (plus the configs it references). */
  const settingsFor = (/** @type {string} */ dir) => {
    let hit = configCache.get(dir);
    if (hit) return hit;
    const file = ['tsconfig.json', 'jsconfig.json'].map((n) => path.join(dir, n)).find(isFile);
    const parent = path.dirname(dir);
    if (!file) {
      hit = dir === root || parent === dir || !(dir + path.sep).startsWith(root + path.sep) ? { aliases: [], baseUrls: [] } : settingsFor(parent);
    } else {
      const own = readConfig(file);
      const sets = [own, ...own.refs.map((r) => readConfig(r))];
      const aliases = sets.flatMap((s) => Object.entries(s.paths ?? {}).map(([pattern, targets]) => ({
        pattern, targets: Array.isArray(targets) ? targets.map(String) : [], base: /** @type {string} */ (s.baseUrl ?? s.pathsDir),
      })));
      // TypeScript picks the longest matching prefix; exact patterns beat wildcards.
      const prefixLen = (/** @type {string} */ p) => (p.includes('*') ? p.indexOf('*') : Infinity);
      aliases.sort((a, b) => prefixLen(b.pattern) - prefixLen(a.pattern));
      hit = { aliases, baseUrls: sets.map((s) => s.baseUrl).filter(Boolean) };
    }
    configCache.set(dir, hit);
    return hit;
  };

  // --- monorepo workspace packages

  const workspaces = (() => {
    /** @type {string[]} */
    let globs = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
    } catch { /* no package.json */ }
    try {
      const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
      for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) globs.push(m[1]);
    } catch { /* not pnpm */ }
    /** @type {{ name: string, dir: string, pkg: any }[]} */
    const list = [];
    // ponytail: supports "dir/*", "dir/**" and plain folders, the shapes nearly every monorepo uses.
    for (const glob of globs.filter((g) => typeof g === 'string' && !g.startsWith('!'))) {
      const wild = /\/\*\*?$/.test(glob);
      const base = path.join(root, glob.replace(/\/\*\*?$/, ''));
      let dirs = [base];
      if (wild) { try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name)); } catch { dirs = []; } }
      for (const dir of dirs) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
          if (pkg.name) list.push({ name: pkg.name, dir, pkg });
        } catch { /* not a package */ }
      }
    }
    return list.sort((a, b) => b.name.length - a.name.length);
  })();

  const pickExport = (/** @type {any} */ v) =>
    typeof v === 'string' ? v : v && typeof v === 'object' ? pickExport(v.source ?? v.types ?? v.import ?? v.default ?? v.require ?? Object.values(v)[0]) : null;

  /** "@app/protocol" or "@app/protocol/x" -> a source file in that workspace package (or its package.json). */
  const resolveWorkspace = (/** @type {string} */ spec) => {
    const ws = workspaces.find((w) => spec === w.name || spec.startsWith(w.name + '/'));
    if (!ws) return null;
    const sub = spec.slice(ws.name.length + 1);
    const exp = ws.pkg.exports;
    const subpath = sub ? `./${sub}` : '.';
    const fromExports = typeof exp === 'object' && exp && Object.keys(exp).some((k) => k.startsWith('.')) ? pickExport(exp[subpath]) : !sub ? pickExport(exp) : null;
    const candidates = sub
      ? [fromExports, sub, `src/${sub}`]
      : [fromExports, ws.pkg.source, 'src/index', 'index', ws.pkg.types ?? ws.pkg.typings, ws.pkg.module, ws.pkg.main];
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const file = resolveFile(path.resolve(ws.dir, c));
      if (file && isSource(toRel(root, file))) return file;
    }
    return path.join(ws.dir, 'package.json'); // still lands in the right part
  };

  const resolve = (/** @type {string} */ spec, /** @type {string} */ fromDir) => {
    if (spec.startsWith('.')) return resolveFile(path.resolve(fromDir, spec));
    if (path.isAbsolute(spec) || /^[a-z]+:/i.test(spec)) return null; // absolute, node:, http:
    const { aliases, baseUrls } = settingsFor(fromDir);
    for (const { pattern, targets, base } of aliases) {
      const star = pattern.indexOf('*');
      const match = star === -1 ? (spec === pattern ? '' : null)
        : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1
          ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
      if (match === null) continue;
      for (const t of targets) {
        const file = resolveFile(path.resolve(base, t.replace('*', match)));
        if (file) return file;
      }
    }
    for (const base of baseUrls) {
      const file = resolveFile(path.resolve(base, spec));
      if (file) return file;
    }
    return resolveWorkspace(spec);
  };

  return {
    /** Forget cached lookups (call after files are created or deleted, or configs change). */
    reset: () => { isFileCache.clear(); configCache.clear(); },
    /** Imports of one file that point at other files in this project. Pass `text` to check unsaved content. */
    importsOf(/** @type {string} */ rel, /** @type {string=} */ text) {
      const abs = path.join(root, rel);
      const src = text ?? fs.readFileSync(abs, 'utf8');
      /** @type {Import[]} */
      const out = [];
      for (const { spec, pos } of scanImports(src)) {
        const file = resolve(spec, path.dirname(abs));
        if (!file) continue;
        const target = toRel(root, file);
        if (target.startsWith('..') || path.isAbsolute(target) || target.split('/').includes('node_modules')) continue;
        out.push({ spec, target, line: lineAt(src, pos) });
      }
      return out;
    },
  };
}

const lineAt = (/** @type {string} */ text, /** @type {number} */ pos) => {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

// ---------------------------------------------------------------- graph

/** Imports in `rel` that cross into a part its own part is not allowed to use. */
export function violationsIn(/** @type {Rules} */ rules, /** @type {string} */ rel, /** @type {Import[]} */ imports) {
  const from = partOf(rules, rel);
  if (!from) return [];
  return imports.flatMap((imp) => {
    const to = partOf(rules, imp.target);
    return to && to !== from && !allowed(rules, from, to) ? [{ ...imp, from, to }] : [];
  });
}

const MAX_LISTED = 50; // per edge, keeps the payload small on big repos

/**
 * Aggregate file imports into part-to-part edges.
 * kind: "allowed" (follows the rules), "violation" (breaks them), "unchecked" (touches files no part claims).
 */
export function buildGraph(/** @type {Rules} */ rules, /** @type {Map<string, Import[]>} */ files) {
  /** @type {Map<string, { path: string, imports: number }[]>} */
  const partFiles = new Map(rules.parts.map((p) => [p.id, []]));
  /** @type {Map<string, { from: string, to: string, kind: string, count: number, imports: { file: string, line: number, spec: string, target: string }[] }>} */
  const edges = new Map();
  const unmapped = new Set();
  let importCount = 0;

  for (const [rel, imports] of files) {
    const from = partOf(rules, rel);
    if (from) partFiles.get(from)?.push({ path: rel, imports: imports.length });
    importCount += imports.length;
    for (const imp of imports) {
      const to = partOf(rules, imp.target);
      if (from === to) continue; // inside one part, or between two unclaimed files: not architecture
      if (!from) unmapped.add(rel);
      if (!to) unmapped.add(imp.target);
      const a = from ?? UNMAPPED, b = to ?? UNMAPPED;
      const key = `${a}>${b}`;
      let edge = edges.get(key);
      if (!edge) {
        const kind = !from || !to ? 'unchecked' : allowed(rules, a, b) ? 'allowed' : 'violation';
        edges.set(key, (edge = { from: a, to: b, kind, count: 0, imports: [] }));
      }
      edge.count++;
      if (edge.imports.length < MAX_LISTED) edge.imports.push({ file: rel, line: imp.line, spec: imp.spec, target: imp.target });
    }
  }

  const edgeList = [...edges.values()];
  const violations = edgeList.filter((e) => e.kind === 'violation').reduce((n, e) => n + e.count, 0);
  const planned = rules.parts.flatMap((p) => p.uses.filter((u) => !edges.has(`${p.id}>${u}`)).map((u) => ({ from: p.id, to: u })));
  return {
    parts: rules.parts.map((p) => ({
      ...p,
      files: /** @type {any[]} */ (partFiles.get(p.id)),
      violations: edgeList.filter((e) => e.from === p.id && e.kind === 'violation').reduce((n, e) => n + e.count, 0),
    })),
    unmapped: unmapped.size ? [...unmapped].sort() : null,
    edges: edgeList,
    planned,
    violations,
    stats: { files: files.size, imports: importCount, parts: rules.parts.length },
  };
}
