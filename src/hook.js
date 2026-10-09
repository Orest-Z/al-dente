#!/usr/bin/env node
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Claude Code PostToolUse hook for Edit|Write|MultiEdit.
// 1. Pings the live map so the edit lights up as "Claude".
// 2. Checks the edited file against al-dente.json; on a *new* rule break it exits 2,
//    which hands the message back to Claude so it fixes the code right away.
//    Breaks already in the last commit don't block: Claude isn't pushed into refactoring old debt
//    every time it touches a file (a ratchet: debt can only go down).
import fs from 'node:fs';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
const project = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const file = input.tool_input?.file_path;
if (!file) process.exit(0);

// The plan nearest to the edited file wins, so a monorepo can keep one al-dente.json per app or package, and a
// session opened below the plan's folder is still checked. No plan above the file: the project folder, where a
// broken plan still gets reported.
let root = project;
for (let dir = path.dirname(path.resolve(project, file)); ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, 'al-dente.json'))) { root = dir; break; }
  if (path.dirname(dir) === dir) break;
}

// Ping first: it's cheap, so the map reacts before the resolver has even loaded.
const pinged = fetch(`http://127.0.0.1:${process.env.AL_DENTE_PORT || 4747}/api/agent-edit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root, file, tool: input.tool_name }),
  signal: AbortSignal.timeout(1000),
}).catch(() => {}); // map not running: the guard below still works

try {
  const { RULES_FILE, UNMAPPED, createResolver, gitIgnoredOf, isIgnored, isSource, readRules, toRel, violationsIn } = await import('./core.js');
  const rel = toRel(root, file);
  // Messages name files as seen from the project folder, so a monorepo's apps/web/... is unambiguous.
  const shown = toRel(project, file), plan = toRel(project, path.join(root, RULES_FILE));
  let rules;
  try {
    rules = readRules(root);
  } catch (e) {
    await pinged;
    if (rel !== RULES_FILE) process.exit(0); // only nag about a broken plan right after it was edited
    console.error(`al-dente: ${e.message}. Fix ${plan} so the architecture can be checked.`);
    process.exit(2);
  }
  if (!rules || !isSource(rel) || isIgnored(rules, rel)) { await pinged; process.exit(0); }

  const resolver = createResolver(root);
  let broken = violationsIn(rules, rel, resolver.importsOf(rel));
  // A file no part claims counts only if it's the project's: generated code git ignores isn't (one git call, rarely needed).
  const generated = gitIgnoredOf(root, broken.filter((v) => v.to === UNMAPPED).map((v) => v.target));
  broken = broken.filter((v) => !generated.has(v.target));
  if (broken.length) {
    // Only breaks this edit introduced count: compare with the file as committed (none if it's new or there's no git).
    const { execFileSync } = await import('node:child_process');
    let committed = null;
    try { committed = execFileSync('git', ['-C', root, 'show', `HEAD:./${rel}`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8'); }
    catch { /* new file, or not a git repo */ }
    if (committed !== null) {
      const key = (/** @type {{ target: string, spec: string }} */ v) => `${v.target}|${v.spec}`;
      const old = new Set(violationsIn(rules, rel, resolver.importsOf(rel, committed)).map(key));
      broken = broken.filter((v) => !old.has(key(v)));
    }
  }
  await pinged;
  if (!broken.length) process.exit(0);

  const label = (id) => rules.byId.get(id).label;
  const from = rules.byId.get(broken[0].from);
  const may = from.uses.map(label).join(', ') || 'nothing outside itself';
  // The shortest allowed way through the plan to each part it reached for, so the fix is one step instead of a search.
  const prev = new Map([[from.id, '']]);
  for (const queue = [from.id]; queue.length;) {
    const id = queue.shift();
    for (const next of rules.byId.get(id).uses) if (!prev.has(next)) { prev.set(next, id); queue.push(next); }
  }
  const fix = (to) => {
    if (to === UNMAPPED) return `move the files no part claims into a part ${from.label} may use (${may}), or ask the user to add their folders to a part in ${plan}`;
    if (!prev.has(to)) return `nothing ${from.label} may use leads to ${label(to)}: move this code into a part that may use ${label(to)}, or have such a part pass in what ${from.label} needs`;
    const way = [];
    for (let id = to; id; id = prev.get(id)) way.unshift(label(id));
    return `reach ${label(to)} through ${way.slice(1, -1).join(', then ')} (${way.join(' → ')})`;
  };
  console.error([
    `al-dente: ${shown} breaks the architecture agreed in ${plan}.`,
    ...broken.map((v) => (v.to === UNMAPPED
      ? `  line ${v.line}: imports "${v.spec}" (${toRel(project, path.join(root, v.target))}), which no part claims, so ${from.label} may not rely on it.`
      : `  line ${v.line}: imports "${v.spec}" from ${label(v.to)}, but ${from.label} may only use: ${may}.`)),
    ...[...new Set(broken.map((v) => v.to))].map((to) => `To fix: ${fix(to)}.`),
    `Only change ${plan} if the user explicitly agrees to this new dependency.`,
  ].join('\n'));
  process.exit(2);
} catch (e) {
  await pinged;
  console.error(`al-dente hook: ${e.message}`);
  process.exit(1); // non-blocking: never stop the agent because of our own failure
}
