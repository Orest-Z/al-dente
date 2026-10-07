// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Python for al-dente: read a file's imports and resolve them to files in the project the way Python's
// import system would, from the file layout alone (no Python needed): relative imports, packages and
// modules under the project root, a src/ layout or any other folder that holds a top-level package,
// and plain script folders. Anything that doesn't land on a project file (stdlib, installed packages) is skipped.
import path from 'node:path';
import { firstSentence, skippedDir } from './core.js';

/**
 * Blank out comments, and the insides of strings, keeping every newline and the quotes, so positions and
 * line numbers stay true and a docstring that shows "from x import y" isn't taken for an import.
 * ponytail: f-strings that nest the same quote (Python 3.12+) can end a string early; it's healed by the end of the line.
 */
export function blankPython(/** @type {string} */ src) {
  const out = [];
  const blank = (/** @type {number} */ a, /** @type {number} */ b) => src.slice(a, b).replace(/[^\n]/g, ' ');
  let last = 0, i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
      out.push(src.slice(last, i), blank(i, end));
      last = i = end;
    } else if (c === '"' || c === "'") {
      const q = src.startsWith(c + c + c, i) ? c + c + c : c;
      let j = i + q.length;
      while (j < src.length && !src.startsWith(q, j) && (q.length === 3 || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      const end = Math.min(j, src.length);
      out.push(src.slice(last, i + q.length), blank(i + q.length, end));
      last = end;
      i = end + (src.startsWith(q, end) ? q.length : 0);
    } else i++;
  }
  out.push(src.slice(last));
  return out.join('');
}

const FROM = /(?:^|;)[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]*(\([^)]*\)|[^\n;]*)/gm;
const IMPORT = /(?:^|;)[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
const DYNAMIC = /(?:importlib\.)?(?:import_module|__import__)\s*\(\s*(['"])/g;

/**
 * Every import with its line: `import a.b`, `from .x import y` (y may be a submodule, so it's tried first,
 * then the module it comes from: `alt`), and `importlib.import_module("a.b")` with a literal name.
 * ponytail: `import a, \` continued with a backslash only sees the first line; parenthesised imports are fine.
 * @returns {import('./core.js').Spec[]}
 */
export function pythonSpecs(/** @type {string} */ src) {
  const code = blankPython(src);
  /** @type {{ spec: string, alt?: string, pos: number }[]} */
  const found = [];
  for (const m of code.matchAll(FROM)) {
    const mod = m[1], pos = /** @type {number} */ (m.index) + m[0].indexOf(mod, m[0].indexOf('from') + 4);
    const names = m[2].replace(/[()\\]/g, ' ').split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => /^\w+$|^\*$/.test(n));
    if (!names.length || names.includes('*')) { found.push({ spec: mod, pos }); continue; }
    for (const n of names) found.push({ spec: mod.endsWith('.') ? mod + n : `${mod}.${n}`, alt: mod, pos });
  }
  for (const m of code.matchAll(IMPORT)) {
    for (const item of m[1].split(',')) found.push({ spec: item.trim().split(/\s+/)[0], pos: /** @type {number} */ (m.index) + m[0].indexOf(item.trim()) });
  }
  for (const m of code.matchAll(DYNAMIC)) {
    const start = /** @type {number} */ (m.index) + m[0].length, end = src.indexOf(m[1], start);
    const name = src.slice(start, end);
    // A relative name ("…(".x", package)") depends on a package known only at runtime.
    if (/^\w+(?:\.\w+)*$/.test(name)) found.push({ spec: name, pos: start }); // not "pkg." + name, built at runtime
  }
  found.sort((a, b) => a.pos - b.pos);
  /** @type {import('./core.js').Spec[]} */
  const out = [];
  let line = 1, at = 0;
  for (const { spec, alt, pos } of found) {
    for (let i = src.indexOf('\n', at); i !== -1 && i < pos; i = src.indexOf('\n', i + 1)) { line++; at = i + 1; }
    out.push(alt === undefined ? { spec, line } : { spec, alt, line });
  }
  return out;
}

/**
 * Resolves Python imports for files under `root`. Every lookup is answered from one listing per folder
 * (a single directory read on disk, or the tree of a past commit), so no file is stat-ed on its own.
 * Names are matched case-sensitively, as Python does even on Windows.
 * @param {string} root absolute project root
 * @param {{ entries(abs: string): { dirs: string[], files: string[] } }} io
 */
export function createPythonResolver(root, io) {
  /** @type {Map<string, { dirs: Set<string>, files: Set<string> } | null>} */
  const listings = new Map();
  const list = (/** @type {string} */ dir) => {
    let hit = listings.get(dir);
    if (hit === undefined) {
      try { const e = io.entries(dir); hit = { dirs: new Set(e.dirs), files: new Set(e.files) }; } catch { hit = null; }
      listings.set(dir, hit);
    }
    return hit;
  };
  const hasFile = (/** @type {string} */ dir, /** @type {string} */ name) => list(dir)?.files.has(name) ?? false;
  const isPkg = (/** @type {string} */ dir) => hasFile(dir, '__init__.py');
  /** @type {string[] | null} */
  let found = null;

  /**
   * Folders Python would have on its path: the project root, every folder that holds a top-level package
   * (src/ layouts, monorepo packages) and every folder with its own pyproject.toml or setup.py.
   */
  const roots = () => {
    if (found) return found;
    /** @type {Set<string>} */
    const out = new Set([root]);
    const walk = (/** @type {string} */ dir, /** @type {boolean} */ parentIsPkg) => {
      const here = list(dir);
      if (!here || here.files.has('pyvenv.cfg')) return; // gone, or a virtualenv
      const pkg = here.files.has('__init__.py');
      if (pkg && !parentIsPkg) out.add(path.dirname(dir));
      if (here.files.has('pyproject.toml') || here.files.has('setup.py') || here.files.has('setup.cfg')) {
        out.add(dir);
        if (here.dirs.has('src')) out.add(path.join(dir, 'src')); // a src/ layout, even with namespace packages (no __init__.py)
      }
      for (const n of here.dirs) if (!skippedDir(n)) walk(path.join(dir, n), pkg);
    };
    walk(root, false);
    return (found = [...out]);
  };

  /** "a.b.c" under `base` -> a/b/c.py or a/b/c/__init__.py ("" is the package at `base` itself). */
  const moduleFile = (/** @type {string} */ base, /** @type {string} */ dotted) => {
    const segs = dotted ? dotted.split('.') : [];
    let dir = base;
    for (const s of segs.slice(0, -1)) {
      if (!list(dir)?.dirs.has(s)) return null;
      dir = path.join(dir, s);
    }
    const last = segs.at(-1);
    if (last !== undefined && hasFile(dir, `${last}.py`)) return path.join(dir, `${last}.py`);
    const pkg = last === undefined ? dir : list(dir)?.dirs.has(last) ? path.join(dir, last) : null;
    return pkg && isPkg(pkg) ? path.join(pkg, '__init__.py') : null;
  };

  /** The folder a file's top-level package sits in: Python's path entry when it's imported as a package. */
  const packageRoot = (/** @type {string} */ dir) => {
    while (isPkg(dir) && dir !== root && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return dir;
  };

  const resolveOne = (/** @type {string} */ spec, /** @type {string} */ fromDir) => {
    const dots = /** @type {string} */ (spec.match(/^\.*/)?.[0]).length;
    if (dots) {
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      return moduleFile(base, spec.slice(dots));
    }
    // The likely places first; the folder walk behind roots() only runs on a miss (stdlib and installed packages always miss).
    const near = [packageRoot(fromDir), root];
    for (const r of near) {
      const file = moduleFile(r, spec);
      if (file) return file;
    }
    const top = spec.split('.')[0];
    for (const r of roots()) {
      if (near.includes(r) || !(list(r)?.dirs.has(top) || hasFile(r, `${top}.py`))) continue;
      const file = moduleFile(r, spec);
      if (file) return file;
    }
    return null;
  };

  return {
    reset: () => { found = null; listings.clear(); },
    /** A spec's file: the submodule if there is one, else the module it was imported from. */
    resolve(/** @type {import('./core.js').Spec} */ s, /** @type {string} */ fromDir) {
      const file = resolveOne(s.spec, fromDir);
      if (file || s.alt === undefined) return file ? { file, spec: s.spec } : null;
      const alt = resolveOne(s.alt, fromDir);
      return alt ? { file: alt, spec: s.alt } : null;
    },
  };
}

// ---------------------------------------------------------------- file descriptions

const STRING_START = /^[rRuU]?("""|'''|"|')/;

/** The docstring of the statement block starting at `pos` in the blanked `code`, if it opens with one. */
function docstringAt(/** @type {string} */ src, /** @type {string} */ code, /** @type {number} */ pos) {
  const at = pos + /** @type {number} */ (code.slice(pos).match(/^\s*/)?.[0].length);
  const m = src.slice(at).match(STRING_START);
  if (!m) return null;
  const start = at + m[0].length, end = src.indexOf(m[1], start);
  return end === -1 ? null : src.slice(start, end);
}

/**
 * What a Python file is for, in one line: its module docstring, else the docstring of its main class or
 * function, else a summary of what it defines.
 * @returns {import('./core.js').About}
 */
export function describePython(/** @type {string} */ rel, /** @type {string} */ src) {
  const code = blankPython(src);
  const base = rel.split('/').pop() ?? rel;
  const stem = base.replace(/\.py$/, '');
  /** @type {{ name: string, kind: string, pos: number }[]} */
  const defs = [];
  for (const m of code.matchAll(/^(?:async[ \t]+)?(def|class)[ \t]+(\w+)/gm)) defs.push({ name: m[2], kind: m[1], pos: /** @type {number} */ (m.index) });
  const pub = defs.filter((d) => !d.name.startsWith('_'));
  const names = [...new Set(pub.map((d) => d.name))];
  const useful = (/** @type {string | null} */ doc) => {
    const t = doc && firstSentence(doc);
    return t && t.split(' ').length >= 2 ? t : null;
  };

  let doc = useful(docstringAt(src, code, 0));
  if (!doc) {
    const flat = (/** @type {string} */ s) => s.replace(/_/g, '').toLowerCase();
    const main = pub.find((d) => flat(d.name) === flat(stem)) ?? (pub.length === 1 ? pub[0] : null);
    if (main) {
      // The body starts after the ":" that ends the header (the signature may span lines).
      let depth = 0, i = main.pos;
      for (; i < code.length; i++) {
        const c = code[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ':' && depth === 0) break;
      }
      doc = useful(docstringAt(src, code, i + 1));
    }
  }
  if (doc) return { text: doc, from: 'doc', exports: names };

  const list = (/** @type {string[]} */ xs) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` +${xs.length - 3} more` : '');
  const classes = [...new Set(pub.filter((d) => d.kind === 'class').map((d) => d.name))];
  const fns = [...new Set(pub.filter((d) => d.kind === 'def').map((d) => d.name))];
  let text;
  if (base === 'conftest.py') text = 'Test fixtures';
  else if (/^test_|_test\.py$/.test(base) || /(?:^|\/)tests?\//.test(rel)) {
    const tests = [...new Set(defs.filter((d) => /^Test|^test_/.test(d.name)).map((d) => d.name.replace(/^Test|^test_/, '')))];
    text = tests.length ? `Tests for ${list(tests)}` : 'Tests';
  } else if (base === '__init__.py') {
    const reexports = [...code.matchAll(/^from[ \t]+\.[\w.]*[ \t]+import[ \t]+\(?([^)\n]*)/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+/)[0])).filter((n) => /^\w+$/.test(n));
    text = names.length ? `Package: ${list(names)}` : reexports.length ? `Package: re-exports ${list([...new Set(reexports)])}` : 'Package marker';
  } else if (/^if[ \t]+__name__[ \t]*==/m.test(code)) text = `Script entry point${names.length ? `; defines ${list(names)}` : ''}`;
  else if (base === 'manage.py' || base === '__main__.py') text = 'Entry point';
  else if (!names.length) text = 'Module with no public classes or functions';
  else text = [classes.length && `Classes: ${list(classes)}`, fns.length && `functions: ${list(fns)}`].filter(Boolean).join('; ').replace(/^f/, 'F');
  return { text, from: 'code', exports: names };
}
