// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Benchmark hook wrapper: runs al-dente's real hooks unchanged and logs what they did.
//   node hook-wrap.mjs session          SessionStart: pass the plan context through to Claude
//   node hook-wrap.mjs post guard       PostToolUse: the real guard (exit 2 + message go back to Claude)
//   node hook-wrap.mjs post observe     PostToolUse: same check, but silent (Claude is never told): the baseline
// Every call appends one line to <project>/.claude/bench-log.jsonl.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AL = fileURLToPath(new URL('../src', import.meta.url));
const [mode, cond] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const log = (o) => fs.appendFileSync(path.join(root, '.claude', 'bench-log.jsonl'), JSON.stringify({ t: Date.now(), ...o }) + '\n');

const t0 = performance.now();
// AL_DENTE_PORT: no map runs during the benchmark; point the hook's ping at a closed port.
const r = spawnSync(process.execPath, [`${AL}/${mode === 'session' ? 'session' : 'hook'}.js`], {
  input, encoding: 'utf8', env: { ...process.env, AL_DENTE_PORT: '59999', CLAUDE_PROJECT_DIR: root },
});
const ms = Math.round(performance.now() - t0);

if (mode === 'session') {
  log({ ev: 'session', ms, chars: r.stdout.length });
  process.stdout.write(r.stdout);
  process.exit(0);
}
let file = null, tool = null;
try { const j = JSON.parse(input); file = j.tool_input?.file_path ?? null; tool = j.tool_name ?? null; } catch { /* not JSON */ }
log({ ev: 'edit', cond, tool, file, code: r.status, ms, msg: r.stderr.trim() });
if (cond === 'guard' && r.status === 2) {
  process.stderr.write(r.stderr);
  process.exit(2);
}
process.exit(0);
