// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Deterministic numbers (no model involved): how long al-dente's hook takes per edit (a fresh Node process,
// exactly as Claude Code runs it), and how big the plan context is at session start.
// Usage: node measure-hook.mjs <root> <file> [<root> <file> ...]   -> results/hook.json
//   each <root> has an al-dente.json; <file> is one of its source files, relative to <root>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AL = fileURLToPath(new URL('../src', import.meta.url));
const args = process.argv.slice(2);
const REPOS = [];
for (let i = 0; i + 1 < args.length; i += 2) REPOS.push({ name: path.basename(path.resolve(args[i])), root: path.resolve(args[i]), file: args[i + 1] });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const out = [];
for (const r of REPOS) {
  if (!fs.existsSync(path.join(r.root, 'al-dente.json'))) { console.log(`skip ${r.name}: no al-dente.json`); continue; }
  const file = r.file ?? spawnSync('git', ['-C', r.root, 'ls-files', '*.ts'], { encoding: 'utf8' }).stdout.split('\n').find((f) => f.includes('/src/') && !f.includes('test'));
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(r.root, file) } });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: r.root, AL_DENTE_PORT: '59999' };
  const times = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    spawnSync(process.execPath, [`${AL}/hook.js`], { input, env, encoding: 'utf8' });
    times.push(performance.now() - t0);
  }
  const s0 = performance.now();
  const session = spawnSync(process.execPath, [`${AL}/session.js`], { input: '{}', env, encoding: 'utf8' });
  const sessionMs = performance.now() - s0;
  const row = { repo: r.name, file, hookMsMedian: Math.round(median(times)), hookMsMin: Math.round(Math.min(...times)), hookMsMax: Math.round(Math.max(...times)),
    sessionMs: Math.round(sessionMs), sessionChars: session.stdout.length, sessionTokensApprox: Math.round(session.stdout.length / 4) };
  out.push(row);
  console.log(row);
}
fs.writeFileSync(fileURLToPath(new URL('./results/hook.json', import.meta.url)), JSON.stringify(out, null, 1));
