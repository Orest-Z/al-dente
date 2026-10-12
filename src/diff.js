// @ts-check
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// What a branch or pull request does to the architecture: connections added or removed, rule breaks it
// introduces or fixes, and edits to the plan itself. Breaks that were already on the base branch never
// fail it (the same ratchet as the hook), so a repo with old debt can turn this on today.
// `toMarkdown` renders it for a PR comment, with a Mermaid diagram GitHub draws inline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RULES_FILE, UNMAPPED, buildGraph, diskImports, importDelta, isIgnored, isSource, partOf, readRules } from './core.js';
import { MAIN_REFS, createEngine, edgeDiff } from './history.js';

const MAX_ROWS = 50; // per table: a PR comment is capped at 65,536 characters

/**
 * @param {string} root
 * @param {{ base?: string, head?: string }} [opts] base: a rev (default: where this branch forked from main);
 *   head: a rev (default: the working tree, uncommitted changes included)
 */
export function diffArchitecture(root, { base, head } = {}) {
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8').trim();
  const commit = (/** @type {string} */ rev) => {
    try { return git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`); }
    catch { throw new Error(`unknown revision "${rev}" (in GitHub Actions, check out with fetch-depth: 0)`); }
  };
  const show = (/** @type {string} */ rev) => { try { return git('show', `${rev}:./${RULES_FILE}`); } catch { return null; } };

  let headText = null;
  if (head) headText = show(commit(head));
  else try { headText = fs.readFileSync(path.join(root, RULES_FILE), 'utf8').replace(/\r\n/g, '\n').trim(); } catch { /* no plan */ }
  const rules = readRules(root, headText);
  if (!rules) throw new Error(`no ${RULES_FILE} in ${root}${head ? ` at ${head}` : ''}. Ask your agent to design the architecture first.`);
  const headSha = commit(head ?? 'HEAD');

  // Compare with where this branch forked off, like GitHub's "Files changed" tab.
  const forkFrom = (/** @type {string} */ sha) => {
    try { return git('merge-base', sha, headSha); } catch { throw new Error(`${base ?? sha} and ${head ?? 'HEAD'} share no history`); }
  };
  let fork = base ? forkFrom(commit(base)) : null;
  for (const ref of base ? [] : MAIN_REFS) {
    try { fork = forkFrom(commit(ref)); break; } catch { /* try the next */ }
  }
  if (!fork) throw new Error('no main or master branch to compare with: pass a base, like `al-dente diff develop`');

  // Everything is judged by the plan as it is now; edits to the plan are reported on their own.
  const engine = createEngine(root);
  const before = engine.imports(rules, fork);
  const after = head ? engine.imports(rules, headSha) : diskImports(root, rules);

  const changes = engine.changedFiles(fork, head ? headSha : undefined);
  if (!head) {
    const known = new Set(changes.map((c) => c.path));
    for (const rel of git('ls-files', '-z', '--others', '--exclude-standard').split('\0')) {
      if (rel && !known.has(rel)) changes.push({ path: rel, old: null, status: 'A', add: null, del: null });
    }
  }

  // Per file, so a renamed file keeps its old breaks and a moved import isn't mistaken for a new one.
  const renamedFrom = new Map(changes.filter((c) => c.old).map((c) => [c.path, /** @type {string} */ (c.old)]));
  const moved = new Set(renamedFrom.values());
  const broke = [], fixed = [];
  for (const rel of new Set([...after.keys(), ...[...before.keys()].filter((rel) => !moved.has(rel))])) {
    const d = importDelta(rules, rel, before.get(renamedFrom.get(rel) ?? rel) ?? [], after.get(rel) ?? []);
    broke.push(...d.broke.map((v) => ({ file: rel, from: /** @type {string} */ (d.part), ...v })));
    fixed.push(...d.fixed.map((v) => ({ file: rel, from: /** @type {string} */ (d.part), ...v })));
  }

  const graph = buildGraph(rules, after);
  const baseText = show(fork);
  /** @type {import('./core.js').Rules | null} */
  let baseRules = null;
  try { baseRules = readRules(root, baseText); } catch { /* the base plan was invalid: treat it as new */ }
  const uses = (/** @type {import('./core.js').Rules | null} */ r) => new Set(r?.parts.flatMap((p) => p.uses.map((u) => `${p.id}>${u}`)) ?? []);
  const was = uses(baseRules), now = uses(rules);
  const pair = (/** @type {string} */ k) => { const [from, to] = k.split('>'); return { from, to }; };

  return {
    base: fork,
    head: headSha,
    worktree: !head,
    web: engine.web,
    prefix: git('rev-parse', '--show-prefix'), // root inside the repo, for links
    labels: Object.fromEntries(rules.parts.map((p) => [p.id, p.label])),
    uses: Object.fromEntries(rules.parts.map((p) => [p.id, p.uses])),
    graph,
    edges: edgeDiff(buildGraph(rules, before), graph),
    broke,
    fixed,
    plan: {
      created: !baseRules,
      changed: baseText !== headText,
      allowed: baseRules ? [...now].filter((k) => !was.has(k)).map(pair) : [],
      revoked: baseRules ? [...was].filter((k) => !now.has(k)).map(pair) : [],
    },
    changes: changes.map((c) => ({ ...c, part: isSource(c.path) && !isIgnored(rules, c.path) ? partOf(rules, c.path) ?? UNMAPPED : null })),
  };
}

/** @typedef {ReturnType<typeof diffArchitecture>} ArchDiff */

/** The PR comment: a verdict, the parts as a Mermaid diagram, then the details. */
export function toMarkdown(/** @type {ArchDiff} */ d) {
  // Names from the plan and the file tree come from the pull request itself, so they must not be able to break out of a
  // table row, a code span or the diagram and dress up the report (a fake verdict, a closed <details>).
  const text = (/** @type {string} */ s) => String(s).replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\\&<>|]/g, (c) => (/** @type {Record<string, string>} */ ({ '\\': '\\\\', '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '\\|' }))[c]);
  const label = (/** @type {string} */ id) => (id === UNMAPPED ? 'Unmapped files' : text(d.labels[id] ?? id));
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const arrow = (/** @type {{ from: string, to: string }} */ e) => `${label(e.from)} → ${label(e.to)}`;
  const code = (/** @type {string} */ s) => `\`${String(s).replace(/`/g, "'").replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&')}\``;
  const at = (/** @type {string} */ file, /** @type {number} */ line) =>
    d.web && !d.worktree ? `[${code(`${file}:${line}`)}](${d.web}/blob/${d.head}/${encodeURI(d.prefix + file).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}#L${line})` : code(`${file}:${line}`);
  const more = (/** @type {number} */ n) => (n > MAX_ROWS ? [`\n…and ${n - MAX_ROWS} more.`] : []);
  const key = (/** @type {{ from: string, to: string }} */ e) => `${e.from}>${e.to}`;
  const existing = d.graph.violations - d.broke.length;
  const out = [];

  out.push('### al-dente: architecture check', '');
  if (d.broke.length) out.push(`✗ **Adds ${plural(d.broke.length, 'rule break')}**: ${d.broke.length === 1 ? 'an import' : 'imports'} the plan in ${code(RULES_FILE)} doesn't allow.`);
  else out.push(`✓ **Follows the plan** in ${code(RULES_FILE)}${d.fixed.length ? `, and fixes ${plural(d.fixed.length, 'rule break')}` : ''}.`);
  const { added, removed, changed } = d.edges;
  const facts = [
    ...(added.length ? [plural(added.length, 'new connection')] : []),
    ...(removed.length ? [`${plural(removed.length, 'connection')} removed`] : []),
    ...(added.length || removed.length ? [] : ['No new connections between parts']),
    ...(existing > 0 ? [`${plural(existing, 'older rule break')} left as ${existing === 1 ? 'it was' : 'they were'}`] : []),
  ];
  out.push(`${facts.join(' · ').replace(/^./, (c) => c.toUpperCase())}.`, '');

  if (d.plan.created) out.push(`⚠ **Adds the plan** (${code(RULES_FILE)}). Review the parts and what each may use.`, '');
  else if (d.plan.changed) {
    const bits = [
      ...(d.plan.allowed.length ? [`now allows ${d.plan.allowed.map(arrow).join(', ')}`] : []),
      ...(d.plan.revoked.length ? [`no longer allows ${d.plan.revoked.map(arrow).join(', ')}`] : []),
    ];
    out.push(`⚠ **Changes the plan** (${code(RULES_FILE)})${bits.length ? `: ${bits.join('; ')}` : ''}.`, '');
  }

  // The diagram: every part, the connections as they are after this change, new ones thick, breaks red, removed ones dashed.
  const ids = new Map(d.graph.parts.map((p, i) => [p.id, `p${i}`]));
  const node = (/** @type {string} */ id) => ids.get(id) ?? 'unmapped';
  const touched = new Set(d.changes.map((c) => c.part).filter((p) => p && p !== UNMAPPED));
  const isNew = new Set(added.map(key));
  const newBreak = new Set(d.broke.map((v) => key({ from: v.from, to: v.to })));
  const mm = ['```mermaid', 'flowchart TD'];
  for (const p of d.graph.parts) mm.push(`  ${node(p.id)}["${String(p.label).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, (c) => ({ '"': '#quot;', '<': '#lt;', '>': '#gt;' })[c])}"]`);
  if ([...d.graph.edges, ...removed].some((e) => e.from === UNMAPPED || e.to === UNMAPPED)) mm.push('  unmapped["Unmapped files"]:::unmapped');
  /** @type {string[]} */
  const styles = [];
  let n = 0;
  for (const e of d.graph.edges) {
    const fresh = isNew.has(key(e));
    const line = e.kind === 'unchecked' ? '-.->' : fresh ? '==>' : '-->';
    const text = e.kind === 'violation' ? `✗ ${e.count}` : fresh ? 'new' : '';
    mm.push(`  ${node(e.from)} ${line}${text ? `|"${text}"|` : ''} ${node(e.to)}`);
    if (e.kind === 'violation') styles.push(`  linkStyle ${n} stroke:#d03b3b,stroke-width:${newBreak.has(key(e)) ? 4 : 2}px`);
    n++;
  }
  for (const e of removed) {
    mm.push(`  ${node(e.from)} -.->|"removed"| ${node(e.to)}`);
    styles.push(`  linkStyle ${n++} stroke:#8c8c8c`);
  }
  mm.push(...styles, '  classDef touched stroke-width:3px', '  classDef unmapped stroke-dasharray:4');
  if (touched.size) mm.push(`  class ${[...touched].map(node).join(',')} touched`);
  mm.push('```');
  const quiet = !d.broke.length && !d.fixed.length && !added.length && !removed.length && !d.plan.changed;
  out.push(quiet ? '<details><summary>Map of the parts</summary>' : '<details open><summary>Map of the parts (thick border: touched by this change)</summary>', '', ...mm, '', '</details>', '');

  if (d.broke.length) {
    out.push('#### New rule breaks', '', '| Where | Import | Rule |', '|---|---|---|');
    for (const v of d.broke.slice(0, MAX_ROWS)) {
      const may = d.uses[v.from]?.map(label).join(', ') || 'nothing outside itself';
      out.push(`| ${at(v.file, v.line)} | ${code(v.spec)} (${arrow(v)}) | ${label(v.from)} may only use: ${may} |`);
    }
    out.push(...more(d.broke.length), '');
  }
  if (d.fixed.length) {
    out.push('#### Fixed rule breaks', '');
    for (const v of d.fixed.slice(0, MAX_ROWS)) out.push(`- ✓ ${code(`${v.file}:${v.line}`)} no longer imports ${code(v.spec)} (${arrow(v)})`);
    out.push(...more(d.fixed.length), '');
  }
  if (added.length || removed.length || changed.length) {
    out.push('#### Connections between parts', '', '| Change | Connection | Imports |', '|---|---|---|');
    const rows = [
      ...added.map((e) => [e.kind === 'violation' ? '✗ new, breaks the plan' : '+ new', arrow(e), String(e.count)]),
      ...removed.map((e) => ['− removed', arrow(e), `~~${e.count}~~`]),
      ...changed.map((e) => ['changed', arrow(e), `${e.was} → ${e.count}`]),
    ];
    for (const r of rows.slice(0, MAX_ROWS)) out.push(`| ${r.join(' | ')} |`);
    out.push(...more(rows.length), '');
  }

  if (d.changes.length) {
    /** @type {Map<string, string[]>} */
    const byPart = new Map();
    let other = 0;
    for (const c of d.changes) {
      if (!c.part) { other++; continue; }
      const lines = c.add === null ? '' : ` +${c.add} −${c.del}`;
      byPart.set(c.part, [...(byPart.get(c.part) ?? []), `${code(c.path)}${c.status === 'D' ? ' (deleted)' : lines}`]);
    }
    out.push(`<details><summary>${plural(d.changes.length - other, 'source file')} changed in ${plural(byPart.size, 'part')}${other ? `, plus ${other} other` : ''}</summary>`, '');
    if (byPart.size) {
      out.push('| Part | Files |', '|---|---|');
      for (const [part, files] of byPart) out.push(`| ${label(part)} | ${files.slice(0, 20).join('<br>')}${files.length > 20 ? `<br>…and ${files.length - 20} more` : ''} |`);
    }
    out.push('', '</details>', '');
  }

  out.push(`<sub>Checked by [al-dente](https://github.com/Orest-Z/al-dente) · ${d.base.slice(0, 7)} → ${d.worktree ? 'working tree' : d.head.slice(0, 7)} · older breaks never fail a PR</sub>`);
  return out.join('\n');
}
