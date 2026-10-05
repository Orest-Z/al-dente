#!/usr/bin/env node
// Claude Code PostToolUse hook for Edit|Write|MultiEdit.
// 1. Pings the live map so the edit lights up as "Claude".
// 2. Checks the edited file against al-dente.json; on a rule break it exits 2,
//    which hands the message back to Claude so it fixes the code right away.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const file = input.tool_input?.file_path;
if (!file) process.exit(0);

// Ping first: it's cheap, so the map reacts before TypeScript has even loaded.
const pinged = fetch(`http://127.0.0.1:${process.env.AL_DENTE_PORT || 4747}/api/agent-edit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ root, file, tool: input.tool_name }),
  signal: AbortSignal.timeout(1000),
}).catch(() => {}); // map not running: the guard below still works

try {
  const { RULES_FILE, createResolver, isSource, readRules, toRel, violationsIn } = await import('./core.js');
  const rel = toRel(root, file);
  let rules;
  try {
    rules = readRules(root);
  } catch (e) {
    await pinged;
    if (rel !== RULES_FILE) process.exit(0); // only nag about a broken plan right after it was edited
    console.error(`al-dente: ${e.message}. Fix ${RULES_FILE} so the architecture can be checked.`);
    process.exit(2);
  }
  if (!rules || !isSource(rel)) { await pinged; process.exit(0); }

  const broken = violationsIn(rules, rel, createResolver(root).importsOf(rel));
  await pinged;
  if (!broken.length) process.exit(0);

  const label = (id) => rules.byId.get(id).label;
  const from = rules.byId.get(broken[0].from);
  const may = from.uses.map(label).join(', ') || 'nothing outside itself';
  console.error([
    `al-dente: ${rel} breaks the architecture agreed in ${RULES_FILE}.`,
    ...broken.map((v) => `  line ${v.line}: imports "${v.spec}" from ${label(v.to)}, but ${from.label} may only use: ${may}.`),
    `Restructure the code so this goes through a part ${from.label} is allowed to use.`,
    `Only change ${RULES_FILE} if the user explicitly agrees to this new dependency.`,
  ].join('\n'));
  process.exit(2);
} catch (e) {
  await pinged;
  console.error(`al-dente hook: ${e.message}`);
  process.exit(1); // non-blocking: never stop the agent because of our own failure
}
