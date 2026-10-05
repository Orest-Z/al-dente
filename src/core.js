// @ts-check
// Core of al-dente: read the architecture rules, read a file's imports with
// TypeScript's own resolver, and turn files + imports into a part-level graph.
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

function loadTypeScript(/** @type {string} */ root) {
  // Prefer the project's own TypeScript so resolution matches its compiler exactly.
  for (const from of [path.join(root, 'package.json'), import.meta.url]) {
    try { return createRequire(from)('typescript'); } catch { /* try the next one */ }
  }
  throw new Error('al-dente needs TypeScript to read imports. Run: npm i -D typescript');
}

/**
 * Reads imports with TypeScript's resolver, so tsconfig "paths" aliases, baseUrl,
 * index files and ".js -> .ts" ESM imports resolve exactly like the compiler does.
 */
export function createResolver(/** @type {string} */ root) {
  const ts = loadTypeScript(root);
  const canonical = ts.sys.useCaseSensitiveFileNames ? (/** @type {string} */ f) => f : (/** @type {string} */ f) => f.toLowerCase();

  /** @type {{ options: any, files: Set<string>, cache: any }[]} */
  const configs = [];
  const seen = new Set();
  const visit = (/** @type {string | undefined} */ file) => {
    if (!file || seen.has(file) || !ts.sys.fileExists(file)) return;
    seen.add(file);
    const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
    if (error) return;
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(file), undefined, file);
    configs.push({ options: parsed.options, files: new Set(parsed.fileNames.map((f) => canonical(path.resolve(f)))), cache: null });
    // Vite-style roots ("files": [] + references) keep the real settings in the referenced configs.
    for (const ref of parsed.projectReferences ?? []) visit(ts.resolveProjectReferencePath(ref));
  };
  visit(ts.findConfigFile(root, ts.sys.fileExists));
  if (!configs.length) {
    configs.push({
      options: { allowJs: true, resolveJsonModule: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
      files: new Set(), cache: null,
    });
  }
  const reset = () => { for (const c of configs) c.cache = ts.createModuleResolutionCache(root, canonical, c.options); };
  reset();
  // ponytail: files created after startup use the config that owns the most files; match include globs if that misfires.
  const main = configs.reduce((a, b) => (b.files.size > a.files.size ? b : a));
  const configFor = (/** @type {string} */ abs) => configs.find((c) => c.files.has(canonical(abs))) ?? main;

  return {
    /** Forget cached resolutions (call after files are created or deleted). */
    reset,
    /** Imports of one file that point at other files in this project. Pass `text` to check unsaved content. */
    importsOf(/** @type {string} */ rel, /** @type {string=} */ text) {
      const abs = path.join(root, rel);
      const src = text ?? fs.readFileSync(abs, 'utf8');
      const { options, cache } = configFor(abs);
      /** @type {Import[]} */
      const out = [];
      for (const { fileName: spec, pos } of ts.preProcessFile(src, true, true).importedFiles) {
        const resolved = ts.resolveModuleName(spec, abs, options, ts.sys, cache).resolvedModule;
        if (!resolved || resolved.isExternalLibraryImport) continue;
        const target = toRel(root, resolved.resolvedFileName);
        if (target.startsWith('..') || target.includes('node_modules/')) continue;
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
