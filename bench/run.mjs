// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// The benchmark: the same feature requests, given to Claude Code with and without al-dente.
//   node run.mjs --tag pilot --tasks greeting --models sonnet --conds baseline,guard --reps 1 --par 2
//   node run.mjs --remediate --tag full        (follow-up "fix the breaks" sessions for runs that ended with breaks)
// Conditions:
//   baseline  no al-dente; a silent observer logs every rule break (Claude is never told)
//   guard     al-dente as shipped: the plan at session start + the guard hook after every edit
//   context   only the plan at session start (no guard), to separate prevention from the guard
//   guardonly only the guard (no plan at session start): shows the catch-and-fix loop on its own
// Each run: a fresh clone of the shop at the task's base commit, `claude -p` with only file tools, user
// settings and plugins switched off (--setting-sources project,local), then scored:
//   new rule breaks vs the base (al-dente diff), the feature end to end (check.mjs), tokens, cost, time.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFeature } from './check.mjs';
import { MODELS, REPO, TASKS } from './tasks.mjs';

// This folder (forward slashes: it also goes into each run's .claude/settings.json), the CLI next to it, and Claude Code.
const BENCH = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const AL = fileURLToPath(new URL('../bin/al-dente.js', import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i === -1 ? d : args[i + 1]; };
const list = (k, d) => opt(k, d).split(',');
const TAG = opt('tag', 'run');
fs.mkdirSync(`${BENCH}/results`, { recursive: true });

function setup(id, task, cond) {
  const dir = path.join(BENCH, 'runs', id);
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', REPO, dir]);
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'bench', TASKS[task].base]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'bench@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'bench']);
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.claude/\ndb/\n');
  fs.mkdirSync(path.join(dir, '.claude'));
  const hook = (a) => ({ type: 'command', command: `node "${BENCH}/hook-wrap.mjs" ${a}`, timeout: 30 });
  const guarded = cond === 'guard' || cond === 'guardonly';
  const hooks = { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [hook(`post ${guarded ? 'guard' : 'observe'}`)] }] };
  if (cond === 'guard' || cond === 'context') hooks.SessionStart = [{ matcher: 'startup', hooks: [hook('session')] }];
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ hooks }, null, 2));
  return dir;
}

function claude(dir, prompt, model) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE' || k === 'CLAUDE_PROJECT_DIR') delete env[k];
    const p = spawn(CLAUDE, ['-p', '--model', model, '--output-format', 'json', '--setting-sources', 'project,local',
      '--permission-mode', 'acceptEdits', '--max-turns', '40',
      '--allowedTools', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep',
      '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Task'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => p.kill(), 12 * 60_000);
    p.on('close', (code) => {
      clearTimeout(kill);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* not JSON */ }
      resolve({ code, json, err: err.slice(-800), raw: json ? '' : out.slice(-800) });
    });
    p.stdin.end(prompt);
  });
}

function score(dir, task) {
  const d = spawnSync(process.execPath, [AL, 'diff', TASKS[task].base, '--root', dir, '--json'], { encoding: 'utf8' });
  let diff = null;
  try { diff = JSON.parse(d.stdout); } catch { /* no diff */ }
  const events = fs.existsSync(path.join(dir, '.claude/bench-log.jsonl'))
    ? fs.readFileSync(path.join(dir, '.claude/bench-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const edits = events.filter((e) => e.ev === 'edit');
  const flagged = edits.filter((e) => e.code === 2);
  // Time from the first flagged edit to the next edit of that file that's clean.
  let fixMs = null;
  if (flagged.length) {
    const f = flagged[0];
    const next = edits.find((e) => e.t > f.t && e.file === f.file && e.code === 0);
    if (next) fixMs = next.t - f.t;
  }
  return {
    newBreaks: diff ? diff.broke.length : null,
    breaks: diff ? diff.broke.map((b) => `${b.file}:${b.line} ${b.from}→${b.to} "${b.spec}"`) : [],
    newEdges: diff ? diff.edges.added.map((e) => `${e.from}→${e.to}${e.kind === 'violation' ? ' ✗' : ''}`) : [],
    edits: edits.length,
    flagged: flagged.length,
    firstFlag: flagged[0] ? { file: flagged[0].file, msg: flagged[0].msg } : null,
    fixMs,
    hookMs: edits.map((e) => e.ms),
    sessionChars: events.find((e) => e.ev === 'session')?.chars ?? 0,
  };
}

async function runOne({ task, model, cond, rep }) {
  const id = `${TAG}-${task}-${model}-${cond}-${rep}`;
  const dir = setup(id, task, cond);
  const t0 = Date.now();
  const res = await claude(dir, TASKS[task].prompt, MODELS[model]);
  const s = score(dir, task);
  const feature = await checkFeature(task, dir).catch((e) => ({ pass: false, detail: `check failed: ${e.message}` }));
  const j = res.json ?? {};
  const row = {
    id, task, model, cond, rep, wallMs: Date.now() - t0, exit: res.code, isError: j.is_error ?? true, subtype: j.subtype,
    turns: j.num_turns, durationMs: j.duration_ms, apiMs: j.duration_api_ms, cost: j.total_cost_usd, usage: j.usage, ...s, feature,
    error: res.json ? undefined : (res.err || res.raw),
  };
  fs.appendFileSync(`${BENCH}/results/${TAG}.jsonl`, JSON.stringify(row) + '\n');
  if (isInvalid(row)) { stopped = true; console.log(`${id}: INVALID (no model output); stopping the queue`); return; }
  console.log(`${id}: breaks ${s.newBreaks} · flagged ${s.flagged} · feature ${feature.pass ? 'PASS' : 'FAIL'} · ${j.num_turns} turns · $${j.total_cost_usd?.toFixed(3)} · ${Math.round((Date.now() - t0) / 1000)}s${row.error ? ` · ERROR ${String(row.error).slice(0, 160)}` : ''}`);
}

async function remediateOne(row) {
  const dir = path.join(BENCH, 'runs', row.id);
  const check = spawnSync(process.execPath, [AL, 'check', '--root', dir], { encoding: 'utf8' }).stdout.trim();
  const prompt = `A code review found that this change breaks the app's agreed architecture (al-dente.json). The architecture check says:\n\n${check}\n\nRestructure the code so it follows the plan, without changing what the app does.`;
  const t0 = Date.now();
  const res = await claude(dir, prompt, MODELS[row.model]);
  const s = score(dir, row.task);
  const feature = await checkFeature(row.task, dir).catch((e) => ({ pass: false, detail: `check failed: ${e.message}` }));
  const j = res.json ?? {};
  const out = { id: row.id, task: row.task, model: row.model, cond: row.cond, rep: row.rep, wallMs: Date.now() - t0, turns: j.num_turns, durationMs: j.duration_ms, cost: j.total_cost_usd, usage: j.usage, newBreaks: s.newBreaks, breaks: s.breaks, feature };
  fs.appendFileSync(`${BENCH}/results/${TAG}-remediation.jsonl`, JSON.stringify(out) + '\n');
  console.log(`remediate ${row.id}: breaks after ${s.newBreaks} · feature ${feature.pass ? 'PASS' : 'FAIL'} · $${j.total_cost_usd?.toFixed(3)} · ${Math.round((Date.now() - t0) / 1000)}s`);
}

/** A run that never reached the model (usage limit, auth): no tokens, or flagged as an error. Never counted. */
export const isInvalid = (row) => !(row.turns > 1) || row.isError
  || !((row.usage?.input_tokens ?? 0) + (row.usage?.cache_read_input_tokens ?? 0) + (row.usage?.output_tokens ?? 0));
let stopped = false;

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length && !stopped) await fn(queue.shift()); }));
  if (stopped) console.log(`stopped early: ${queue.length} runs not started (usage limit?)`);
}

if (args.includes('--remediate')) {
  const rows = fs.readFileSync(`${BENCH}/results/${TAG}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => !isInvalid(r) && r.cond === 'baseline' && r.newBreaks > 0);
  console.log(`remediating ${rows.length} runs`);
  await pool(rows, Number(opt('par', 3)), remediateOne);
} else {
  const runs = [];
  for (const rep of Array.from({ length: Number(opt('reps', 1)) }, (_, i) => i + 1))
    for (const task of list('tasks', 'greeting,receipt,orders'))
      for (const model of list('models', 'haiku,sonnet,opus'))
        for (const cond of list('conds', 'baseline,guard')) runs.push({ task, model, cond, rep });
  console.log(`${runs.length} runs, ${opt('par', 3)} at a time`);
  await pool(runs, Number(opt('par', 3)), runOne);
}
