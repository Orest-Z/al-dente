#!/usr/bin/env node
// Claude Code SessionStart hook: tells Claude the plan before it writes any code, so it imports the right
// way the first time instead of being corrected by the edit hook. Whatever this prints becomes context,
// so it stays short, and it prints nothing in projects without al-dente.json.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw || '{}'); } catch { /* no input: use the folder */ }
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const MAX_BREAKS = 5;

try {
  const { DEFAULT_IGNORE, RULES_FILE, diskImports, readRules, violationsIn } = await import('./core.js');
  let rules;
  try { rules = readRules(root); }
  catch (e) {
    console.log(`al-dente: ${RULES_FILE} is invalid (${e.message}), so edits can't be checked against the architecture. Offer to fix it.`);
    process.exit(0);
  }
  if (!rules) process.exit(0);

  const label = (id) => rules.byId.get(id).label;
  const broken = [...diskImports(root, rules)].flatMap(([rel, imports]) => violationsIn(rules, rel, imports).map((v) => ({ rel, ...v })));
  const ignore = JSON.stringify(rules.ignore) === JSON.stringify(DEFAULT_IGNORE) ? 'Tests and stories' : rules.ignore.join(', ');
  console.log([
    `This project's architecture is agreed in ${RULES_FILE} and enforced by al-dente: an edit that imports from a part its own part may not use is blocked.`,
    'Parts (folders) and what each may import from:',
    ...rules.parts.map((p) => `- ${p.label} (${p.paths.join(', ')}) may use: ${p.uses.map(label).join(', ') || 'nothing outside itself'}`),
    `Imports inside a part are always fine.${rules.ignore.length ? ` ${ignore} aren't checked.` : ''} Put new code in the part it belongs to, and route through an allowed part instead of reaching across.`,
    ...(broken.length ? [
      `Older rule breaks already in the code (don't copy these patterns; fix them only if asked): ${broken.length}`,
      ...broken.slice(0, MAX_BREAKS).map((v) => `- ${v.rel}:${v.line} imports "${v.spec}" (${label(v.from)} → ${label(v.to)})`),
      ...(broken.length > MAX_BREAKS ? [`- …and ${broken.length - MAX_BREAKS} more`] : []),
    ] : []),
    `Change ${RULES_FILE} only if the user agrees to the new dependency.`,
  ].join('\n'));
} catch (e) {
  console.error(`al-dente session hook: ${e.message}`);
  process.exit(1); // non-blocking: a broken hook must never stop the session
}
