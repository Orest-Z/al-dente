// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Core of al-dente: read the architecture rules, resolve each file's imports
// (no dependencies, any TypeScript version; Python in python.js, Java in java.js), and turn them into a part-level graph.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createJavaResolver, describeJava, javaSpecs } from './java.js';
import { createPythonResolver, describePython, pythonSpecs } from './python.js';

export const RULES_FILE = 'al-dente.json';
export const UNMAPPED = '~unmapped';
const SOURCE = /\.(?:[cm]?[jt]sx?|py|java)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv', 'site-packages']);
/** Not architecture: tests, stories and migrations may import anything. A plan can override this with its own "ignore" list. */
export const DEFAULT_IGNORE = [
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__mocks__/**', '**/test/**', '**/tests/**', '**/e2e/**', '**/*.stories.*',
  '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/migrations/*.py', '**/alembic/versions/*.py', // migrations are generated snapshots
  '**/src/androidTest/**', '**/src/integrationTest/**', '**/src/testFixtures/**', // Java's src/test/ is covered by test/ above
];

/** Project-relative path with forward slashes, e.g. "src/ui/Button.tsx". */
export const toRel = (/** @type {string} */ root, /** @type {string} */ file) =>
  path.relative(root, path.resolve(root, file)).split(path.sep).join('/');

export const skippedDir = (/** @type {string} */ name) => SKIP_DIRS.has(name) || name.startsWith('.');

/** Is this a source file inside the project that we should analyse? */
export function isSource(/** @type {string} */ rel) {
  if (!SOURCE.test(rel) || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split('/').slice(0, -1).some(skippedDir);
}

/** A tsconfig/jsconfig/package.json whose change can alter how imports resolve. */
export const isResolverConfig = (/** @type {string} */ rel) =>
  /(?:^|\/)(?:[tj]sconfig[^/]*|package)\.json$/.test(rel) && !rel.split('/').slice(0, -1).some(skippedDir);

/**
 * Every source file in the project, skipping dependencies, build output and dot-folders.
 * In a git repo this is what git sees (tracked + untracked, minus .gitignore), so generated code stays out.
 */
export function listSources(/** @type {string} */ root) {
  // --cached still lists a file deleted since the last commit; readers skip files that are gone.
  const fromGit = gitFiles(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (fromGit?.length) return [...new Set(fromGit)].filter(isSource).sort();
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

/** NUL-separated paths from a git command run in `root`, or null when git or the repo isn't there. */
function gitFiles(/** @type {string} */ root, /** @type {string[]} */ args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, windowsHide: true })
      .toString('utf8').split('\0').filter(Boolean);
  } catch { return null; }
}

/** Is this file ignored by git (e.g. generated code)? False when there's no git. */
export const isGitIgnored = (/** @type {string} */ root, /** @type {string} */ rel) =>
  (gitFiles(root, ['check-ignore', '--', rel])?.length ?? 0) > 0; // prints the path and exits 0 only when ignored

// ---------------------------------------------------------------- rules

/**
 * @typedef {{ id: string, label: string, description: string, paths: string[], uses: string[] }} Part
 * @typedef {{ parts: Part[], byId: Map<string, Part>, prefixes: { prefix: string, id: string }[], ignore: string[], ignoreRe: RegExp[] }} Rules
 */

const normPath = (/** @type {unknown} */ p) =>
  String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** "**\/*.test.*" -> a RegExp over project-relative paths. Supports **, * and ?. */
const globToRegExp = (/** @type {string} */ glob) => new RegExp(`^${normPath(glob).split(/(\*\*\/?|\*|\?)/).map((t) =>
  t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`);

/** Files the plan leaves out of the architecture (tests by default): not drawn, not checked. */
export const isIgnored = (/** @type {Rules} */ rules, /** @type {string} */ rel) => rules.ignoreRe.some((re) => re.test(rel));

/**
 * Load al-dente.json (or parse `text`, e.g. the plan as committed). Returns null when the project has none;
 * throws a readable error when it's invalid.
 */
export function readRules(/** @type {string} */ root, /** @type {string | null=} */ text) {
  if (text === undefined) {
    const file = path.join(root, RULES_FILE);
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  if (text === null) return null;
  let raw;
  try { raw = JSON.parse(text); }
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
  if (raw.ignore !== undefined && (!Array.isArray(raw.ignore) || raw.ignore.some((g) => typeof g !== 'string'))) {
    throw new Error(`"ignore" in ${RULES_FILE} must be a list of globs, like ["**/*.test.ts"]`);
  }
  const ignore = raw.ignore ?? DEFAULT_IGNORE;
  return { parts: list, byId: new Map(list.map((p) => [p.id, p])), prefixes, ignore, ignoreRe: ignore.map(globToRegExp) };
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
export function stripComments(/** @type {string} */ src, /** @type {{ start: number, end: number }[]=} */ comments) {
  const out = [];
  let last = 0, i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const close = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : d === '/' ? close : close + 2;
      comments?.push({ start: i, end });
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

/**
 * @typedef {{ spec: string, line: number, alt?: string, names?: string[] }} Spec
 * alt: where Python's `from m import x` lands when x isn't a submodule; names: the types a Java file uses, for `import a.b.*`
 */

/** Specifiers with their line numbers: the part of a file's analysis that only depends on its text, so it can be cached. */
export function importSpecs(/** @type {string} */ src, /** @type {string} */ rel = '') {
  if (rel.endsWith('.py')) return pythonSpecs(src);
  if (rel.endsWith('.java')) return javaSpecs(src);
  /** @type {Spec[]} */
  const out = [];
  let line = 1, at = 0;
  for (const { spec, pos } of scanImports(src)) {
    for (let i = src.indexOf('\n', at); i !== -1 && i < pos; i = src.indexOf('\n', i + 1)) { line++; at = i + 1; }
    out.push({ spec, line });
  }
  return out;
}

const TS_FIRST = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_EXT = /\.(?:[cm]?js|jsx)$/;

const parseJsonc = (/** @type {string} */ text) => JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'));

/**
 * Where the resolver reads files from: the disk by default; the history view passes one that
 * reads a past commit instead (see history.js).
 * @typedef {{ isFile(abs: string): boolean, read(abs: string): string, dirs(abs: string): string[], entries(abs: string): { dirs: string[], files: string[] } }} SourceIO
 */
/** @type {SourceIO} */
export const diskIO = {
  isFile: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
  read: (p) => fs.readFileSync(p, 'utf8'),
  dirs: (p) => fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  entries: (p) => {
    const all = fs.readdirSync(p, { withFileTypes: true });
    return { dirs: all.filter((e) => e.isDirectory()).map((e) => e.name), files: all.filter((e) => e.isFile()).map((e) => e.name) };
  },
};

/**
 * Resolves imports the way TypeScript and bundlers do, without needing TypeScript itself:
 * relative paths, index files, ".js -> .ts" ESM imports, tsconfig/jsconfig "paths" + "baseUrl"
 * (following "extends" and "references"), and monorepo workspace packages by name.
 */
export function createResolver(/** @type {string} */ root, /** @type {SourceIO} */ io = diskIO) {
  root = path.resolve(root);
  /** @type {Map<string, boolean>} */
  const isFileCache = new Map();
  /** @type {Map<string, any>} */
  const configCache = new Map();

  const isFile = (/** @type {string} */ p) => {
    let hit = isFileCache.get(p);
    if (hit === undefined) isFileCache.set(p, (hit = io.isFile(p)));
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
    try { json = parseJsonc(io.read(file)); } catch { return { refs: [] }; }
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
      const pkg = JSON.parse(io.read(path.join(root, 'package.json')));
      globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
    } catch { /* no package.json */ }
    try {
      const yaml = io.read(path.join(root, 'pnpm-workspace.yaml'));
      for (const m of yaml.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) globs.push(m[1]);
    } catch { /* not pnpm */ }
    /** @type {{ name: string, dir: string, pkg: any }[]} */
    const list = [];
    // ponytail: supports "dir/*", "dir/**" and plain folders, the shapes nearly every monorepo uses.
    for (const glob of globs.filter((g) => typeof g === 'string' && !g.startsWith('!'))) {
      const wild = /\/\*\*?$/.test(glob);
      const base = path.join(root, glob.replace(/\/\*\*?$/, ''));
      let dirs = [base];
      if (wild) { try { dirs = io.dirs(base).map((name) => path.join(base, name)); } catch { dirs = []; } }
      for (const dir of dirs) {
        try {
          const pkg = JSON.parse(io.read(path.join(dir, 'package.json')));
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

  const python = createPythonResolver(root, io);
  const java = createJavaResolver(root, io);

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
    reset: () => { isFileCache.clear(); configCache.clear(); python.reset(); java.reset(); },
    /** Imports of one file that point at other files in this project. Pass `text` to check unsaved content. */
    importsOf(/** @type {string} */ rel, /** @type {string=} */ text) {
      return this.resolveAll(rel, importSpecs(text ?? io.read(path.join(root, rel)), rel));
    },
    /** Resolve specifiers already scanned from `rel` (see importSpecs); only project files are kept. */
    resolveAll(/** @type {string} */ rel, /** @type {Spec[]} */ specs) {
      const dir = path.dirname(path.join(root, rel));
      /** @type {Import[]} */
      const out = [];
      if (rel.endsWith('.py')) {
        const seen = new Set(); // `from m import a, b` where both land in m is one import
        for (const s of specs) {
          const hit = python.resolve(s, dir);
          const target = hit ? toRel(root, hit.file) : '';
          const key = `${target}|${hit?.spec}|${s.line}`;
          if (!hit || target === rel || target.startsWith('..') || seen.has(key)) continue;
          seen.add(key);
          out.push({ spec: hit.spec, target, line: s.line });
        }
        return out;
      }
      if (rel.endsWith('.java')) {
        for (const s of specs) for (const hit of java.resolve(s, rel)) if (hit.target !== rel) out.push({ spec: hit.spec, target: hit.target, line: s.line });
        return out;
      }
      for (const { spec, line } of specs) {
        const file = resolve(spec, dir);
        if (!file) continue;
        const target = toRel(root, file);
        if (target.startsWith('..') || path.isAbsolute(target) || target.split('/').includes('node_modules')) continue;
        out.push({ spec, target, line });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- file descriptions

/** @typedef {{ text: string, from: 'doc' | 'code', exports: string[] }} About */

const IMPORT_LINE = /^(?:#!|import\b|export\s*(?:type\s*)?(?:\*|\{[^}]*\}\s*from\b)|\}\s*from\s*['"]|['"]use [a-z]+['"])/;
const OPEN_IMPORT = /^(?:import\b[^'"]*|export\s*(?:type\s*)?)\{[^}]*$/; // `import {` that continues on the next lines
const DIRECTIVE = /^(?:[-=*#~]{3}|@ts-|eslint|prettier|biome|jshint|istanbul|c8\b|global\b|#region|#endregion|<reference|copyright|spdx|@license|@vite-ignore|ponytail:)/i;
const EXPORT_DECL = /(?:^|[^\w$.])export\s+(?:declare\s+)?(default\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+([\w$]+)/g;
const EXPORT_LIST = /(?:^|[^\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g;

/** "/** Does X. More detail" -> "Does X." (first paragraph, first sentence, tags and markup dropped). */
export function firstSentence(/** @type {string} */ raw) {
  const lines = raw.replace(/^\/\*+!?|\*+\/$/g, '').split('\n').map((l) => l.replace(/^\s*(?:\/\/+|\*(?!\/))?\s?/, ''));
  const para = lines.join('\n').trim().split(/\n\s*\n|\n\s*@/)[0].replace(/:\s*\n[\s\S]*$/, '.');
  const text = para.replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^.+?[.!?](?=\s+[A-Z(`"]|$)/)?.[0] ?? text;
  return sentence.length > 180 ? `${sentence.slice(0, 177).replace(/\s+\S*$/, '')}…` : sentence;
}

/**
 * What a file is for, in one line: its own top-of-file doc comment (or the doc on its main export),
 * otherwise a summary built from what it exports.
 * ponytail: heuristic; agent-written descriptions would read better, add when users ask for them.
 */
export function describeFile(/** @type {string} */ rel, /** @type {string} */ src) {
  if (rel.endsWith('.py')) return describePython(rel, src);
  if (rel.endsWith('.java')) return describeJava(rel, src);
  /** @type {{ start: number, end: number }[]} */
  const comments = [];
  const code = stripComments(src, comments);
  const base = rel.split('/').pop() ?? rel;
  const stem = base.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '').toLowerCase();

  /** @type {{ name: string, kind: string, pos: number, def?: boolean }[]} */
  const exps = [];
  for (const m of code.matchAll(EXPORT_DECL)) exps.push({ name: m[3], kind: m[2], pos: /** @type {number} */ (m.index), def: !!m[1] });
  for (const m of code.matchAll(/(?:^|[^\w$.])export\s+default\b(?!\s+(?:abstract\s+)?(?:async\s+)?(?:function|class)\b)/g)) exps.push({ name: 'default', kind: 'value', pos: /** @type {number} */ (m.index) });
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) exps.push({ name, kind: 'value', pos: /** @type {number} */ (m.index) });
    }
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:module\.)?exports\.([\w$]+)\s*=/g)) exps.push({ name: m[1], kind: 'value', pos: /** @type {number} */ (m.index) });
  const names = [...new Set(exps.map((e) => e.name))];

  // Line comments that follow each other are one comment.
  /** @type {{ start: number, end: number }[]} */
  const blocks = [];
  for (const c of comments) {
    const prev = blocks.at(-1);
    if (prev && src.startsWith('//', c.start) && src.startsWith('//', prev.start) && /^[ \t]*\r?\n[ \t]*$/.test(src.slice(prev.end, c.start))) prev.end = c.end;
    else blocks.push({ ...c });
  }
  const useful = (/** @type {{ start: number, end: number }} */ c) => {
    const t = firstSentence(src.slice(c.start, c.end));
    return t.split(' ').length >= 3 && !DIRECTIVE.test(t) ? t : null;
  };

  // A doc comment above all code except imports describes the file.
  let firstCode = code.length, inImport = false, off = 0;
  for (const line of code.split('\n')) {
    const t = line.trim();
    if (inImport) inImport = !/\bfrom\s*['"]/.test(t);
    else if (OPEN_IMPORT.test(t)) inImport = true;
    else if (t && !IMPORT_LINE.test(t)) { firstCode = off + line.indexOf(t); break; }
    off += line.length + 1;
  }
  // ...unless it sits right on one export among several: then it documents that export, not the file.
  const firstExport = names.length > 1 && exps.some((e) => Math.abs(e.pos - firstCode) <= 1);
  const onOneExport = (/** @type {{ end: number }} */ c) => firstExport && /^[ \t]*\r?\n?[ \t]*$/.test(src.slice(c.end, firstCode));
  let doc = null;
  for (const c of blocks) if (c.start < firstCode && !onOneExport(c) && (doc = useful(c))) break;
  // Otherwise the doc on the main export: the default one, the one named like the file, or the only one.
  if (!doc) {
    const main = exps.find((e) => e.def || e.name === 'default') ?? exps.find((e) => e.name.toLowerCase() === stem) ?? (names.length === 1 ? exps[0] : null);
    const c = main && blocks.find((b) => b.end <= main.pos && !src.slice(b.end, main.pos + 1).trim());
    if (c) doc = useful(c);
  }
  if (doc) return /** @type {About} */ ({ text: doc, from: 'doc', exports: names });

  const list = (/** @type {string[]} */ xs) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` +${xs.length - 3} more` : '');
  const isType = (/** @type {string} */ k) => k === 'type' || k === 'interface';
  const pick = (/** @type {(e: { name: string, kind: string }) => boolean} */ f) => [...new Set(exps.filter(f).map((e) => e.name))];
  const hooks = pick((e) => /^use[A-Z]/.test(e.name));
  const comps = /x$/.test(base) ? pick((e) => /^[A-Z]/.test(e.name) && !isType(e.kind)) : [];
  const rest = names.filter((n) => !hooks.includes(n) && !comps.includes(n));
  let text;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || /(?:^|\/)(?:__tests__|tests?)\//.test(rel)) {
    const named = (/** @type {string} */ fn) => [...new Set([...code.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\1`, 'g'))].map((m) => m[2]))];
    const suites = named('describe').length ? named('describe') : named('test').concat(named('it'));
    text = suites.length ? `Tests for ${list(suites)}` : 'Tests';
  } else if (/\.d\.[cm]?ts$/.test(base)) text = names.length ? `Type declarations: ${list(names)}` : 'Global type declarations';
  else if (/\.config\.[cm]?[jt]s$/.test(base)) text = 'Build or tool configuration';
  else if (!names.length) text = 'Entry point: runs when loaded, exports nothing';
  else if (exps.every((e) => isType(e.kind))) text = `Types: ${list(names)}`;
  else if (comps.length || hooks.length) {
    text = [comps.length && `React component${comps.length > 1 ? 's' : ''}: ${list(comps)}`, hooks.length && `hook${hooks.length > 1 ? 's' : ''}: ${list(hooks)}`]
      .filter(Boolean).join('; ').replace(/^h/, 'H') + (rest.length ? `; also exports ${list(rest)}` : '');
  } else text = `Exports ${list(names)}`;
  return /** @type {About} */ ({ text, from: 'code', exports: names });
}

// ---------------------------------------------------------------- graph

/** Every checked source file on disk with its resolved imports (one full scan; the live server keeps its own cache). */
export function diskImports(/** @type {string} */ root, /** @type {Rules} */ rules) {
  const resolver = createResolver(root);
  return new Map(listSources(root).filter((rel) => !isIgnored(rules, rel)).flatMap((rel) => {
    try { return [[rel, resolver.importsOf(rel)]]; } catch { return []; } // deleted since the last commit
  }));
}

/** Imports in `rel` that cross into a part its own part is not allowed to use. */
export function violationsIn(/** @type {Rules} */ rules, /** @type {string} */ rel, /** @type {Import[]} */ imports) {
  const from = partOf(rules, rel);
  if (!from || isIgnored(rules, rel)) return [];
  return imports.flatMap((imp) => {
    const to = partOf(rules, imp.target);
    return to && to !== from && !allowed(rules, from, to) ? [{ ...imp, from, to }] : [];
  });
}

/** How one file's imports changed between two versions: parts it started/stopped using, rule breaks added/fixed. */
export function importDelta(/** @type {Rules} */ rules, /** @type {string} */ rel, /** @type {Import[]} */ before, /** @type {Import[]} */ after) {
  const part = partOf(rules, rel);
  const key = (/** @type {Import} */ v) => `${v.target}|${v.spec}`;
  const was = violationsIn(rules, rel, before), now = violationsIn(rules, rel, after);
  const slim = (/** @type {Import & { to: string }} */ v) => ({ line: v.line, spec: v.spec, target: v.target, to: v.to });
  const parts = (/** @type {Import[]} */ imps) => [...new Set(imps.map((i) => partOf(rules, i.target)).filter((p) => p && p !== part))];
  const pb = parts(before), pa = parts(after);
  return {
    part,
    links: pa,
    gained: pa.filter((p) => !pb.includes(p)),
    lost: pb.filter((p) => !pa.includes(p)),
    broke: now.filter((v) => !was.some((w) => key(w) === key(v))).map(slim),
    fixed: was.filter((v) => !now.some((w) => key(w) === key(v))).map(slim),
    violations: now.length,
  };
}

/**
 * One file as the map shows it: its part, what it's for, and every import with the part it lands in
 * (`to` is null for files no part claims). Imports of ignored files (tests) are left out.
 */
export const fileEntry = (/** @type {Rules} */ rules, /** @type {string} */ rel, /** @type {Import[]} */ imports, /** @type {About | null | undefined} */ about) => ({
  part: partOf(rules, rel),
  about: about ?? null,
  imports: imports.filter((i) => !isIgnored(rules, i.target)).map((i) => ({ ...i, to: partOf(rules, i.target) })),
});

/**
 * Aggregate file imports into part-to-part edges.
 * kind: "allowed" (follows the rules), "violation" (breaks them), "unchecked" (touches files no part claims).
 * The edges carry counts only; which files and lines make them up is in the file index (`index: true`),
 * which the live server sends once and then patches, so a save never re-sends the whole repo.
 */
export function buildGraph(
  /** @type {Rules} */ rules,
  /** @type {Map<string, Import[]>} */ files,
  /** @type {{ index?: boolean, about?: Map<string, About> }} */ { index = false, about = new Map() } = {},
) {
  /** @type {Map<string, number>} */
  const fileCount = new Map(rules.parts.map((p) => [p.id, 0]));
  /** @type {Map<string, { from: string, to: string, kind: string, count: number }>} */
  const edges = new Map();
  const unmapped = new Set();
  let importCount = 0, counted = 0;

  for (const [rel, imports] of files) {
    if (isIgnored(rules, rel)) continue;
    counted++;
    const from = partOf(rules, rel);
    if (from) fileCount.set(from, /** @type {number} */ (fileCount.get(from)) + 1);
    for (const imp of imports) {
      if (isIgnored(rules, imp.target)) continue;
      importCount++;
      const to = partOf(rules, imp.target);
      if (from === to) continue; // inside one part, or between two unclaimed files: not architecture
      if (!from) unmapped.add(rel);
      if (!to) unmapped.add(imp.target);
      const a = from ?? UNMAPPED, b = to ?? UNMAPPED;
      const key = `${a}>${b}`;
      let edge = edges.get(key);
      if (!edge) {
        const kind = !from || !to ? 'unchecked' : allowed(rules, a, b) ? 'allowed' : 'violation';
        edges.set(key, (edge = { from: a, to: b, kind, count: 0 }));
      }
      edge.count++;
    }
  }

  const edgeList = [...edges.values()];
  const violations = edgeList.filter((e) => e.kind === 'violation').reduce((n, e) => n + e.count, 0);
  const planned = rules.parts.flatMap((p) => p.uses.filter((u) => !edges.has(`${p.id}>${u}`)).map((u) => ({ from: p.id, to: u })));
  return {
    parts: rules.parts.map((p) => ({
      ...p,
      fileCount: /** @type {number} */ (fileCount.get(p.id)),
      violations: edgeList.filter((e) => e.from === p.id && e.kind === 'violation').reduce((n, e) => n + e.count, 0),
    })),
    unmapped: unmapped.size ? [...unmapped].sort() : null,
    edges: edgeList,
    planned,
    violations,
    ignore: rules.ignore,
    stats: { files: counted, imports: importCount, parts: rules.parts.length },
    ...(index ? {
      files: Object.fromEntries([...files].filter(([rel]) => !isIgnored(rules, rel)).map(([rel, imports]) => [rel, fileEntry(rules, rel, imports, about.get(rel))])),
    } : {}),
  };
}
