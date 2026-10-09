// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// What an existing project looks like before it has a plan: its folders grouped to a readable number, the files in
// each, and how many imports go from each group to each other one. One command instead of reading dozens of files,
// so mapping existing code into parts costs Claude a screenful of text, and the parts it proposes rest on real imports.
import path from 'node:path';
import { createResolver, isIgnored, listSources, readRules } from './core.js';

const MAX_GROUPS = 24;
const MIN_SPLIT = 6; // a group this small says more as one folder than as its pieces

/** @typedef {{ dir: string, direct: boolean, files: string[], leaf?: boolean }} Group dir/ and everything below it, or (direct) only the files right in dir/ */

export function survey(/** @type {string} */ root) {
  let rules = null;
  try { rules = readRules(root); } catch { /* an invalid plan: survey with the default ignore list */ }
  rules ??= /** @type {import('./core.js').Rules} */ (readRules(root, '{"parts":{}}'));
  const files = listSources(root).filter((rel) => !isIgnored(rules, rel));
  const known = new Set(files);
  const resolver = createResolver(root);
  /** @type {Map<string, string[]>} file -> the project files it imports */
  const imports = new Map(files.map((rel) => {
    try { return [rel, [...new Set(resolver.importsOf(rel).map((i) => i.target).filter((t) => known.has(t) && t !== rel))]]; } catch { return [rel, []]; }
  }));

  // Split the biggest group into its subfolders (and the files right in it) until there are enough groups;
  // a folder whose files all sit in one subfolder (src/main/java/com/acme/…) is passed through.
  const under = (/** @type {string} */ dir, /** @type {string} */ rel) => rel.slice(dir ? dir.length + 1 : 0);
  /** @type {Group[]} */
  let groups = [{ dir: '', direct: false, files }];
  for (;;) {
    const g = groups.filter((x) => !x.direct && !x.leaf && x.files.length >= MIN_SPLIT).sort((a, b) => b.files.length - a.files.length)[0];
    if (!g) break;
    /** @type {Map<string, string[]>} */
    const parts = new Map();
    for (const rel of g.files) {
      const rest = under(g.dir, rel), slash = rest.indexOf('/'), key = slash === -1 ? '' : rest.slice(0, slash);
      if (!parts.has(key)) parts.set(key, []);
      /** @type {string[]} */ (parts.get(key)).push(rel);
    }
    const next = [...parts].map(([key, list]) => ({ dir: key ? (g.dir ? `${g.dir}/${key}` : key) : g.dir, direct: !key, files: list }));
    if (next.length === 1) { // one way down: pass through, or a folder with no subfolders
      if (next[0].direct) g.leaf = true; else groups.splice(groups.indexOf(g), 1, next[0]);
      continue;
    }
    if (groups.length - 1 + next.length > MAX_GROUPS) break;
    groups.splice(groups.indexOf(g), 1, ...next);
  }
  groups.sort((a, b) => a.dir.localeCompare(b.dir) || Number(a.direct) - Number(b.direct));
  const groupOf = new Map(groups.flatMap((g, i) => g.files.map((rel) => [rel, i])));

  /** @type {Map<string, number>} "from>to" group indexes -> imports */
  const edges = new Map();
  const degree = new Map(files.map((rel) => [rel, 0]));
  for (const [rel, targets] of imports) {
    for (const t of targets) {
      degree.set(rel, /** @type {number} */ (degree.get(rel)) + 1);
      degree.set(t, /** @type {number} */ (degree.get(t)) + 1);
      const a = groupOf.get(rel), b = groupOf.get(t);
      if (a !== b) edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  const languages = new Map();
  for (const rel of files) {
    const lang = rel.endsWith('.py') ? 'Python' : rel.endsWith('.java') ? 'Java' : 'TypeScript/JavaScript';
    languages.set(lang, (languages.get(lang) ?? 0) + 1);
  }
  return {
    project: path.basename(path.resolve(root)),
    files: files.length,
    languages: Object.fromEntries(languages),
    imports: [...imports.values()].reduce((n, t) => n + t.length, 0),
    hasPlan: rules.parts.length > 0,
    groups: groups.map((g) => {
      // The most connected files tell what a folder is for; a name shared by two of them (index.ts) keeps its folder.
      const top = [...g.files].sort((a, b) => /** @type {number} */ (degree.get(b)) - /** @type {number} */ (degree.get(a))).slice(0, 3);
      const names = top.map((rel) => path.posix.basename(rel));
      return {
        path: g.direct ? (g.files.length === 1 ? g.files[0] : `${g.dir ? `${g.dir}/` : ''}*`) : g.dir,
        files: g.files.length,
        samples: top.map((rel, i) => (names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? rel.split('/').slice(-2).join('/') : names[i])),
      };
    }),
    edges: [...edges].map(([k, count]) => { const [from, to] = k.split('>').map(Number); return { from, to, count }; })
      .sort((a, b) => a.from - b.from || b.count - a.count),
  };
}

/** The survey as compact text for Claude (and people): numbered folders, then the imports between them. */
export function surveyText(/** @type {ReturnType<typeof survey>} */ s) {
  const langs = Object.entries(s.languages).map(([l, n]) => `${l} ${n}`).join(', ');
  if (!s.files) return `al-dente survey of ${s.project}: no source files al-dente reads (TypeScript, JavaScript, Python, Java).`;
  // Paths share a long start in Java and src/ layouts: say it once.
  const dirs = s.groups.map((g) => g.path);
  let common = dirs[0].slice(0, dirs[0].lastIndexOf('/') + 1);
  for (const d of dirs) while (common && !d.startsWith(common)) common = common.slice(0, common.lastIndexOf('/', common.length - 2) + 1);
  const name = (/** @type {number} */ i) => s.groups[i].path.slice(common.length) || '(top)';
  const width = Math.max(...s.groups.map((_, i) => name(i).length));
  const mutual = s.edges.filter((e) => e.from < e.to && s.edges.some((f) => f.from === e.to && f.to === e.from));
  return [
    `al-dente survey of ${s.project}: ${s.files} source files (${langs}), ${s.imports} imports between them. Tests, stories and migrations are left out.`,
    ...(s.hasPlan ? ['This project already has an al-dente.json; the survey ignores its parts.'] : []),
    '',
    `Folders${common ? ` (paths below ${common})` : ''}: files, most connected files`,
    ...s.groups.map((g, i) => `${String(i + 1).padStart(3)}. ${name(i).padEnd(width)}  ${String(g.files).padStart(4)}  ${g.samples.join(', ')}`),
    '',
    'Imports between folders (number: imports into the folder it points at)',
    ...s.groups.flatMap((_, i) => {
      const out = s.edges.filter((e) => e.from === i);
      return out.length ? [`${String(i + 1).padStart(3)} → ${out.map((e) => `${e.to + 1}: ${e.count}`).join(', ')}`] : [];
    }),
    ...(mutual.length ? ['', `Folders that import each other (a cycle to break or keep inside one part): ${mutual.map((e) => `${e.from + 1} ⇄ ${e.to + 1}`).join(', ')}`] : []),
  ].join('\n');
}
