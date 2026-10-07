#!/usr/bin/env node
// Claude Code SessionStart hook: tells Claude the plan before it writes any code, so it imports the right
// way the first time instead of being corrected by the edit hook. Whatever this prints becomes context,
// so it stays short, and it prints nothing in projects without al-dente.json.
// A monorepo without a plan at its root gets the plans of its apps and packages (each al-dente.json git sees).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw || '{}'); } catch { /* no input: use the folder */ }
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const MAX_BREAKS = 5, MAX_PLANS = 5;

try {
  const { DEFAULT_IGNORE, RULES_FILE, diskImports, readRules, violationsIn } = await import('./core.js');
  // ponytail: without git only a root plan is found; a folder walk at every session start would cost a full tree scan.
  const nested = () => {
    try {
      return execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', `:(glob)**/${RULES_FILE}`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split('\n').filter(Boolean).map((f) => path.posix.dirname(f));
    } catch { return []; }
  };
  const dirs = fs.existsSync(path.join(root, RULES_FILE)) ? [''] : nested().slice(0, MAX_PLANS);

  // One plan's context. Paths are written from the project folder, so a sub-plan's parts point at the right place.
  const describe = (dir) => {
    const at = (p) => (dir ? `${dir}/${p}` : p), file = at(RULES_FILE);
    let rules;
    try { rules = readRules(path.join(root, dir)); }
    catch (e) { return [`al-dente: ${file} is invalid (${e.message}), so edits can't be checked against the architecture. Offer to fix it.`]; }
    if (!rules) return [];
    const label = (id) => rules.byId.get(id).label;
    const broken = [...diskImports(path.join(root, dir), rules)].flatMap(([rel, imports]) => violationsIn(rules, rel, imports).map((v) => ({ rel, ...v })));
    const ignore = JSON.stringify(rules.ignore) === JSON.stringify(DEFAULT_IGNORE) ? 'Tests, stories and migrations' : rules.ignore.join(', ');
    return [
      `${dir ? `The architecture of ${dir}/` : "This project's architecture"} is agreed in ${file} and enforced by al-dente: an edit that imports from a part its own part may not use is blocked.`,
      'Parts (folders) and what each may import from:',
      ...rules.parts.map((p) => `- ${p.label} (${p.paths.map(at).join(', ')}) may use: ${p.uses.map(label).join(', ') || 'nothing outside itself'}`),
      `Imports inside a part are always fine.${rules.ignore.length ? ` ${ignore} aren't checked.` : ''} Put new code in the part it belongs to, and route through an allowed part instead of reaching across.`,
      ...(broken.length ? [
        `Older rule breaks already in the code (don't copy these patterns; fix them only if asked): ${broken.length}`,
        ...broken.slice(0, MAX_BREAKS).map((v) => `- ${at(v.rel)}:${v.line} imports "${v.spec}" (${label(v.from)} → ${label(v.to)})`),
        ...(broken.length > MAX_BREAKS ? [`- …and ${broken.length - MAX_BREAKS} more`] : []),
      ] : []),
      `Change ${file} only if the user agrees to the new dependency.`,
    ];
  };
  const out = dirs.map(describe).filter((lines) => lines.length).map((lines) => lines.join('\n'));
  if (out.length) console.log(out.join('\n\n'));
} catch (e) {
  console.error(`al-dente session hook: ${e.message}`);
  process.exit(1); // non-blocking: a broken hook must never stop the session
}
