// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Aggregates every benchmark run into results/summary.json (what the landing page reads) and results/REPORT.md.
// Runs that never reached the model (usage limit) are dropped, never counted.
// Usage: node report.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.mjs';

const R = fileURLToPath(new URL('./results', import.meta.url));
const TAGS = ['full', 'more', 'r2', 'w2', 'g2'];
const read = (f) => (fs.existsSync(`${R}/${f}`) ? fs.readFileSync(`${R}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const tokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.output_tokens ?? 0);
const invalid = (r) => !(r.turns > 1) || r.isError || !tokens(r.usage);

const all = TAGS.flatMap((t) => read(`${t}.jsonl`));
const runs = all.filter((r) => !invalid(r));
const remediation = TAGS.flatMap((t) => read(`${t}-remediation.jsonl`)).filter((r) => r.turns > 1 && tokens(r.usage));
const hook = fs.existsSync(`${R}/hook.json`) ? JSON.parse(fs.readFileSync(`${R}/hook.json`, 'utf8')) : []; // a JSON array, not JSONL

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const r3 = (n) => (n === null ? null : Math.round(n * 1000) / 1000);
const COND = { baseline: 'Without al dente', guard: 'With al dente', guardonly: 'Guard only (no plan up front)', context: 'Plan only' };

function stats(rows) {
  return {
    n: rows.length,
    brokeRuns: rows.filter((r) => r.newBreaks > 0).length,
    attemptRuns: rows.filter((r) => r.flagged > 0).length, // the shortcut was written at some point (blocked or silently logged)
    featurePass: rows.filter((r) => r.feature?.pass).length,
    costMean: r3(mean(rows.map((r) => r.cost))),
    outTokensMean: Math.round(mean(rows.map((r) => r.usage?.output_tokens ?? 0)) ?? 0),
    tokensMean: Math.round(mean(rows.map((r) => tokens(r.usage))) ?? 0),
    secondsMean: r1(mean(rows.map((r) => (r.durationMs ?? 0) / 1000))),
    turnsMean: r1(mean(rows.map((r) => r.turns))),
  };
}
const by = (rows, key) => rows.reduce((m, r) => ((m[key(r)] ??= []).push(r), m), {});

// Tasks where some model, left alone, took the shortcut at least once: the tempting ones.
const tempting = Object.keys(TASKS).filter((t) => runs.some((r) => r.task === t && r.cond === 'baseline' && r.flagged > 0));
const table = Object.entries(by(runs, (r) => `${r.task}|${r.model}|${r.cond}`)).map(([k, rows]) => {
  const [task, model, cond] = k.split('|');
  return { task, model, cond, ...stats(rows) };
}).sort((a, b) => a.task.localeCompare(b.task) || a.model.localeCompare(b.model) || a.cond.localeCompare(b.cond));

const totals = Object.fromEntries(Object.entries(by(runs, (r) => r.cond)).map(([c, rows]) => [c, stats(rows)]));
const temptingTotals = Object.fromEntries(Object.entries(by(runs.filter((r) => tempting.includes(r.task)), (r) => r.cond)).map(([c, rows]) => [c, stats(rows)]));

// The guard's loop: when it blocked an edit, how long until that file was clean again, and did the run end clean?
const blocked = runs.filter((r) => (r.cond === 'guard' || r.cond === 'guardonly') && r.flagged > 0);
const loop = {
  runsBlocked: blocked.length,
  endedClean: blocked.filter((r) => r.newBreaks === 0).length,
  fixSecondsMedian: r1(median(blocked.filter((r) => r.fixMs !== null).map((r) => r.fixMs / 1000))),
  examples: blocked.slice(0, 3).map((r) => ({ id: r.id, message: r.firstFlag?.msg?.split('\n').slice(0, 2).join(' ') })),
};

// Cost of finding the break later: a follow-up "fix the architecture" session, per broken run.
const fix = {
  n: remediation.length,
  endedClean: remediation.filter((r) => r.newBreaks === 0).length,
  featureStillWorks: remediation.filter((r) => r.feature?.pass).length,
  costMean: r3(mean(remediation.map((r) => r.cost))),
  secondsMean: r1(mean(remediation.map((r) => (r.durationMs ?? 0) / 1000))),
  tokensMean: Math.round(mean(remediation.map((r) => tokens(r.usage))) ?? 0),
};

const hookMs = runs.flatMap((r) => r.hookMs ?? []);
const summary = {
  generated: new Date().toISOString(),
  runs: runs.length, dropped: all.length - runs.length,
  models: { haiku: 'Claude Haiku 4.5', sonnet: 'Claude Sonnet 5.5', opus: 'Claude Opus 5.5' },
  tasks: Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, { prompt: t.prompt, shortcut: t.shortcut }])),
  tempting, totals, temptingTotals, table, loop, fix,
  hook: { perEditMsMedian: median(hookMs), perEditMsP90: [...hookMs].sort((a, b) => a - b)[Math.floor(hookMs.length * 0.9)] ?? null, edits: hookMs.length, repos: hook },
};
fs.writeFileSync(`${R}/summary.json`, JSON.stringify(summary, null, 1));

// --- human-readable report -----------------------------------------------------------------------------
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const line = (s) => `${s.brokeRuns}/${s.n} (${pct(s.brokeRuns, s.n)})`;
const md = [];
md.push('# al dente benchmark', '', `Generated ${summary.generated}. ${runs.length} valid runs (${summary.dropped} dropped: they never reached the model, e.g. a usage limit).`, '');
md.push('## Method', '');
md.push('- The same feature requests, sent to Claude Code headless (`claude -p`), on a fresh copy of a small TypeScript shop with a Layered plan (Web → Shared; API → Auth, Shop; Auth, Shop → Data; Data → Shared).');
md.push('- No prompt mentions architecture. User settings and plugins are switched off (`--setting-sources project,local`); only file tools are allowed.');
md.push('- **Without al dente:** a silent observer runs al-dente\'s real check after every edit and logs it; Claude is never told. **With al dente:** the plugin as shipped (plan at session start + the guard after every edit). **Guard only:** the guard without the plan up front.');
md.push('- Scored after each run: new rule breaks versus the starting commit (`al-dente diff`), and whether the feature works end to end (a real server; a real headless browser for the header task).');
md.push('');
md.push('## Tasks', '');
for (const [k, t] of Object.entries(TASKS)) md.push(`- **${k}**${tempting.includes(k) ? ' (a model took the shortcut at least once without al dente)' : ''}: "${t.prompt}" Tempting shortcut: ${t.shortcut}.`);
md.push('');
md.push('## Headline', '');
md.push('| Condition | Runs that ended with a rule break | Features working | Mean cost | Mean time |', '|---|---|---|---|---|');
for (const [c, s] of Object.entries(totals)) md.push(`| ${COND[c] ?? c} | ${line(s)} | ${s.featurePass}/${s.n} | $${s.costMean} | ${s.secondsMean}s |`);
md.push('', `On the tempting tasks only (${tempting.join(', ')}):`, '');
md.push('| Condition | Runs that ended with a rule break | Runs where the shortcut was written at all | Mean cost |', '|---|---|---|---|');
for (const [c, s] of Object.entries(temptingTotals)) md.push(`| ${COND[c] ?? c} | ${line(s)} | ${s.attemptRuns}/${s.n} | $${s.costMean} |`);
md.push('', '## Per task and model', '', '| Task | Model | Condition | Runs | Ended broken | Shortcut written | Feature works | Mean cost | Mean output tokens | Mean time |', '|---|---|---|---|---|---|---|---|---|---|');
for (const t of table) md.push(`| ${t.task} | ${t.model} | ${COND[t.cond] ?? t.cond} | ${t.n} | ${t.brokeRuns} | ${t.attemptRuns} | ${t.featurePass} | $${t.costMean} | ${t.outTokensMean} | ${t.secondsMean}s |`);
md.push('', '## The guard\'s loop', '', `Runs where the guard blocked an edit: ${loop.runsBlocked}; ended clean: ${loop.endedClean}; median time from the block to the file being clean again: ${loop.fixSecondsMedian ?? 'n/a'} s.`);
for (const e of loop.examples) md.push(`- ${e.id}: ${e.message}`);
md.push('', '## Fixing it later instead', '', fix.n ? `Follow-up sessions told about the breaks (as a code review would): ${fix.n}; ended clean: ${fix.endedClean}; feature still works: ${fix.featureStillWorks}; mean cost $${fix.costMean}, ${fix.secondsMean}s, ${fix.tokensMean} tokens.` : 'Not run yet.');
md.push('', '## Overhead (no model involved)', '', `Guard per edit across all runs: median ${summary.hook.perEditMsMedian} ms, p90 ${summary.hook.perEditMsP90} ms (${hookMs.length} edits; a fresh Node process each time).`, '');
md.push('| Repo | Guard per edit (median of 15) | Plan at session start |', '|---|---|---|');
for (const h of hook) md.push(`| ${h.repo} | ${h.hookMsMedian} ms | ~${h.sessionTokensApprox} tokens (${h.sessionChars} characters / 4) |`);
md.push('', '## Limits', '', '- Small samples (2 to 6 runs per cell): treat rates as indicative, not precise.');
md.push('- One small app and one plan. Bigger codebases and longer sessions give more chances to drift; not measured here.');
md.push('- Token counts are what Claude Code reports, including cached input. The plan-size figure is characters / 4, an approximation.');
fs.writeFileSync(`${R}/REPORT.md`, md.join('\n') + '\n');
console.log(md.slice(0, 40).join('\n'));
