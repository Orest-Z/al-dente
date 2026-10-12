// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Java for al-dente: read a file's imports and resolve them to files in the project from the file layout alone
// (no JDK, Maven or Gradle needed). Class a.b.C lives in a file whose path ends in a/b/C.java, which is how Maven,
// Gradle, Android, Bazel and every IDE lay out sources, so any source root works (src/main/java, a module's src/,
// several modules side by side). Anything that doesn't land on a project file (the JDK, libraries) is skipped.
import path from 'node:path';
import { firstSentence, skippedDir } from './core.js';

/**
 * Blank out comments and the insides of strings, char literals and text blocks, keeping every newline and the
 * quotes, so positions and line numbers stay true and a string that shows "import a.B;" isn't taken for an import.
 * `comments` collects where each comment was.
 */
export function blankJava(/** @type {string} */ src, /** @type {{ start: number, end: number }[]=} */ comments) {
  const out = [];
  const blank = (/** @type {number} */ a, /** @type {number} */ b) => src.slice(a, b).replace(/[^\n]/g, ' ');
  let last = 0, i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const close = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : d === '/' ? close : close + 2;
      comments?.push({ start: i, end });
      out.push(src.slice(last, i), blank(i, end));
      last = i = end;
    } else if (c === '"' || c === "'") {
      const q = c === '"' && src.startsWith('"""', i) ? '"""' : c;
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

const PACKAGE = /^[ \t]*package\s+([\w$.\s]+?)\s*;/m;

/** The package a Java file declares ('' for the default package). */
export const javaPackage = (/** @type {string} */ src) => PACKAGE.exec(blankJava(src))?.[1].replace(/\s+/g, '') ?? '';

const IMPORT = /(?:^|;)[ \t]*import\s+(static\s+)?([\w$]+(?:\s*\.\s*[\w$]+)*)(\s*\.\s*\*)?\s*;/gm;
const QUALIFIED = /(?<![\w$.])[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\.[A-Z][\w$]*/g; // com.acme.Order written out in the code
const TYPE_NAME = /(?<![\w$.])[A-Z][\w$]*/g;

/**
 * Every class a file depends on by name, with its line: `import a.b.C;`, `import static a.b.C.m;`, `import a.b.*;`
 * (with the type names the file uses, so only the classes it really takes from that package count) and names
 * written out in full in the code, like `new com.acme.Order()`. Classes of the file's own package need no import
 * and live in its own folder, so they never cross a part.
 * @returns {import('./core.js').Spec[]}
 */
export function javaSpecs(/** @type {string} */ src) {
  const code = blankJava(src);
  /** @type {{ spec: string, pos: number, names?: string[] }[]} */
  const found = [];
  /** @type {{ name: string, pos: number }[]} */
  const wild = [];
  const single = new Set(); // a class imported by name shadows the same name from a wildcard import
  const pkg = PACKAGE.exec(code);
  let body = pkg ? pkg.index + pkg[0].length : 0;
  for (const m of code.matchAll(IMPORT)) {
    const name = m[2].replace(/\s+/g, ''), pos = /** @type {number} */ (m.index) + m[0].indexOf(m[2], m[0].indexOf('import') + 6);
    body = Math.max(body, /** @type {number} */ (m.index) + m[0].length);
    if (m[3] && !m[1]) wild.push({ name, pos });
    else found.push({ spec: m[3] ? `${name}.*` : name, pos });
    if (!m[1] && !m[3]) single.add(name.slice(name.lastIndexOf('.') + 1));
  }
  const rest = code.slice(body);
  const seen = new Set(found.map((f) => f.spec));
  for (const m of rest.matchAll(QUALIFIED)) {
    if (!seen.has(m[0])) { seen.add(m[0]); found.push({ spec: m[0], pos: body + /** @type {number} */ (m.index) }); }
  }
  if (wild.length) {
    const names = [...new Set(rest.match(TYPE_NAME))].filter((n) => !single.has(n));
    for (const w of wild) found.push({ spec: `${w.name}.*`, pos: w.pos, names });
  }
  found.sort((a, b) => a.pos - b.pos);
  /** @type {import('./core.js').Spec[]} */
  const out = [];
  let line = 1, at = 0;
  for (const { spec, pos, names } of found) {
    for (let i = src.indexOf('\n', at); i !== -1 && i < pos; i = src.indexOf('\n', i + 1)) { line++; at = i + 1; }
    out.push(names ? { spec, line, names } : { spec, line });
  }
  return out;
}

/**
 * Resolves Java names for files under `root`. The first lookup lists every folder once (on disk, or the tree of a
 * past commit) to index the .java files by name. A file whose path ends in a/b/C.java is a.b.C only if its folder's
 * files say `package a.b;` (read once per folder), so org/apache/kafka/X.java is never taken for kafka.X. When several
 * files match (the same class in two modules), the one nearest the importing file wins.
 * ponytail: a class whose folder doesn't match its package is missed; javac allows it, build tools and IDEs don't.
 * @param {string} root absolute project root
 * @param {{ entries(abs: string): { dirs: string[], files: string[] }, read(abs: string): string }} io
 */
export function createJavaResolver(root, io) {
  /** @type {Map<string, string[]> | null} "Order.java" -> project-relative paths */
  let byName = null;
  /** @type {Map<string, string | null>} folder -> the package its files declare (null: unreadable, trust the layout) */
  const packages = new Map();
  const packageOf = (/** @type {string} */ file) => {
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    let pkg = packages.get(dir);
    if (pkg === undefined) {
      try { pkg = javaPackage(io.read(path.join(root, file))); } catch { pkg = null; }
      packages.set(dir, pkg);
    }
    return pkg;
  };
  const index = () => {
    if (byName) return byName;
    /** @type {Map<string, string[]>} */
    const map = new Map();
    const walk = (/** @type {string} */ rel) => {
      let e;
      try { e = io.entries(rel ? path.join(root, rel) : root); } catch { return; }
      for (const f of e.files) {
        if (!f.endsWith('.java')) continue;
        const p = rel ? `${rel}/${f}` : f, list = map.get(f);
        if (list) list.push(p); else map.set(f, [p]);
      }
      for (const d of e.dirs) {
        if (skippedDir(d) || (d === 'target' && e.files.includes('pom.xml'))) continue; // Maven's build output: generated code
        walk(rel ? `${rel}/${d}` : d);
      }
    };
    walk('');
    return (byName = map);
  };

  /** Of several files, the one sharing the most folders with `from` (ties: the first by name, on every machine). */
  const nearest = (/** @type {string[]} */ list, /** @type {string} */ from) => {
    if (list.length === 1) return list[0];
    const f = from.split('/');
    const shared = (/** @type {string} */ p) => { const s = p.split('/'); let n = 0; while (n < s.length && s[n] === f[n]) n++; return n; };
    return list.reduce((best, p) => { const a = shared(p), b = shared(best); return a > b || (a === b && p < best) ? p : best; });
  };

  /** The file of class `segs` (a, b, C), or null. */
  const fileOf = (/** @type {string[]} */ segs, /** @type {string} */ from, n = segs.length) => {
    const named = index().get(`${segs[n - 1]}.java`);
    if (!named) return null; // most names (java.util.List, org.junit.Test) stop here
    const tail = `/${segs.slice(0, n).join('/')}.java`, pkg = segs.slice(0, n - 1).join('.');
    const hits = named.filter((p) => `/${p}`.endsWith(tail) && (packageOf(p) ?? pkg) === pkg);
    return hits.length ? nearest(hits, from) : null;
  };

  /** a.b.C, or a member or nested class of it (a.b.C.m, a.b.C.D), lives in a/b/C.java. */
  const classFile = (/** @type {string} */ dotted, /** @type {string} */ from) => {
    const segs = dotted.split('.');
    for (let n = segs.length; n > 1; n--) {
      const file = fileOf(segs, from, n);
      if (file) return file;
    }
    return null;
  };

  return {
    reset: () => { byName = null; packages.clear(); },
    /** The project files a spec from `from` (project-relative) lands in, each with the name it was reached by. */
    resolve(/** @type {import('./core.js').Spec} */ s, /** @type {string} */ from) {
      if (!s.spec.endsWith('.*')) {
        const target = classFile(s.spec, from);
        return target ? [{ target, spec: s.spec }] : [];
      }
      const owner = s.spec.slice(0, -2);
      const target = classFile(owner, from); // `import static a.b.C.*` and `import a.b.Outer.*` take from one class
      if (target) return [{ target, spec: s.spec }];
      // A package: the classes this file names from it, unless its own package (its folder) has one by that name.
      const dir = from.slice(0, from.lastIndexOf('/') + 1), segs = owner.split('.');
      return (s.names ?? []).flatMap((n) => {
        if (index().get(`${n}.java`)?.includes(`${dir}${n}.java`)) return [];
        const file = fileOf([...segs, n], from);
        return file ? [{ target: file, spec: `${owner}.${n}` }] : [];
      });
    },
  };
}

// ---------------------------------------------------------------- file descriptions

const ANNOTATION = String.raw`@(?!interface\b)[\w$.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*`;
const TYPE_DECL = new RegExp(String.raw`(?<![\w$.@])((?:${ANNOTATION})*)((?:(?:public|protected|private|abstract|final|sealed|non-sealed|static|strictfp)\s+)*)(class|interface|enum|record|@\s*interface)\s+([\w$]+)`, 'g');
const PUBLIC_METHOD = /\bpublic\s+[^;{}=()]*?\b([a-z_$][\w$]*)\s*\(/g;
const ANY_METHOD = /[\w$>\]]\s+([a-z_$][\w$]*)\s*\(/g; // inside an interface every method is public
const ROLES = /** @type {Record<string, string>} */ ({
  SpringBootApplication: 'Spring Boot app', RestController: 'REST controller', Controller: 'Web controller', Service: 'Service',
  Repository: 'Repository', Entity: 'Database entity', Configuration: 'Configuration', Component: 'Component',
});

/** Javadoc markup -> plain text: {@link a.b.C#m(X, Y)} -> C.m(), {@code x} -> x, <p> -> a paragraph break, other tags dropped. */
const plainJavadoc = (/** @type {string} */ raw) => raw
  .replace(/\{@(?:link|linkplain)\s+([^\s}(]+)(\([^)]*\))?\s*([^}]*)\}/g, (_, ref, args, label) =>
    label.trim() || ref.replace(/^(?:[a-z_$][\w$]*\.)+/, '').replace(/^#/, '').replace('#', '.') + (args ? '()' : ''))
  .replace(/\{@(?:code|literal|value)\s*([^}]*)\}/g, '$1')
  .replace(/<\/?p\s*\/?>/gi, '\n\n')
  .replace(/<[^>]*>/g, '')
  .replace(/</g, ''); // whatever is left of a tag, like an unclosed "<script"

/**
 * What a Java file is for, in one line: the Javadoc of its main class (the one named like the file), else a summary:
 * its role (Spring annotations) or kind, and its public methods.
 * @returns {import('./core.js').About}
 */
export function describeJava(/** @type {string} */ rel, /** @type {string} */ src) {
  /** @type {{ start: number, end: number }[]} */
  const comments = [];
  const code = blankJava(src, comments);
  const base = rel.split('/').pop() ?? rel;
  const stem = base.replace(/\.java$/, '');
  const list = (/** @type {string[]} */ xs) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` +${xs.length - 3} more` : '');
  const javadocBefore = (/** @type {number} */ pos) => {
    const c = comments.filter((c) => c.end <= pos && src.startsWith('/**', c.start) && !code.slice(c.end, pos).trim()).pop();
    const t = c && firstSentence(plainJavadoc(src.slice(c.start, c.end))).replace(/:$/, '.');
    return t && t.split(' ').length >= 2 && !t.startsWith('@') ? t : null; // not a doc that only has tags (@author …)
  };

  if (base === 'module-info.java') return { text: `Java module ${code.match(/\bmodule\s+([\w$.]+)/)?.[1] ?? ''}`.trim(), from: 'code', exports: [] };
  if (base === 'package-info.java') {
    const doc = javadocBefore(PACKAGE.exec(code)?.index ?? 0);
    return { text: doc ?? 'Package annotations', from: doc ? 'doc' : 'code', exports: [] };
  }

  // Depth in braces before each character: types at 0 are top level, their members at 1.
  const depth = new Int32Array(code.length + 1);
  for (let i = 0, d = 0; i < code.length; i++) { depth[i] = d; if (code[i] === '{') d++; else if (code[i] === '}') d--; }
  const types = [...code.matchAll(TYPE_DECL)].filter((m) => depth[/** @type {number} */ (m.index)] === 0).map((m) => ({
    pos: /** @type {number} */ (m.index), end: /** @type {number} */ (m.index) + m[0].length, annotations: m[1], modifiers: m[2],
    kind: m[3].replace(/\s+/g, ''), name: m[4],
  }));
  const main = types.find((t) => t.name === stem) ?? types[0];
  const names = types.filter((t) => /\bpublic\b/.test(t.modifiers)).map((t) => t.name);
  if (!main) return { text: 'No classes', from: 'code', exports: [] };

  const doc = javadocBefore(main.pos);
  // The main type's body, and what's declared directly in it.
  const open = code.indexOf('{', main.end);
  let close = code.length;
  for (let i = open + 1; open !== -1 && i < code.length; i++) if (code[i] === '}' && depth[i] === 1) { close = i; break; }
  const members = (/** @type {RegExp} */ re) => [...new Set([...code.slice(open + 1, close).matchAll(re)]
    .filter((m) => depth[open + 1 + /** @type {number} */ (m.index)] === 1).map((m) => m[1]))];
  const methods = open === -1 ? [] : members(main.kind === 'interface' || main.kind === '@interface' ? ANY_METHOD : PUBLIC_METHOD);
  const exports = [...new Set([...names, ...methods])];
  if (doc) return { text: doc, from: 'doc', exports };

  const role = [...main.annotations.matchAll(/@(?:[\w$]+\.)*([\w$]+)/g)].map((m) => ROLES[m[1]]).find(Boolean);
  const body = open === -1 ? '' : code.slice(open + 1, close);
  const tested = stem.match(/^(.+?)(?:Tests?|IT)$/)?.[1];
  let text;
  if (tested || /(?:^|\/)tests?\//.test(rel)) text = tested ? `Tests for ${tested}` : 'Tests';
  else if (role === 'Spring Boot app' || (!role && /\bstatic\s+void\s+main\s*\(/.test(body))) text = role ?? 'Entry point';
  else {
    const kind = { interface: 'Interface', record: 'Record', '@interface': 'Annotation', enum: 'Enum' }[main.kind]
      ?? (/(?:Exception|Error)$/.test(main.name) ? 'Exception' : /\babstract\b/.test(main.modifiers) ? 'Abstract class' : 'Class');
    let items = methods;
    if (main.kind === 'enum') { // its constants instead: what's directly in the body up to the first ";", minus arguments
      let head = '';
      for (let i = open + 1; i < close && !(code[i] === ';' && depth[i] === 1); i++) if (depth[i] === 1 && code[i] !== '{') head += code[i];
      for (let was = ''; was !== head;) { was = head; head = head.replace(/\([^()]*\)/g, ''); }
      items = head.split(',').map((c) => c.trim().split(/\s+/).pop() ?? '').filter((c) => /^[\w$]+$/.test(c));
    }
    text = (role ?? kind) + (items.length ? `: ${list(items)}` : '');
  }
  return { text, from: 'code', exports };
}
