// Measures what matters on a big repo: startup, bytes pushed per save, how long the hook waits, history cost,
// and whether the server stays responsive meanwhile. Usage: node scripts/bench.mjs <repo> [port=4800]
// (make a repo with scripts/make-big-repo.mjs). Edits one file and creates one, then restores both.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/al-dente.js', import.meta.url));

const [repoArg, port = '4800'] = process.argv.slice(2);
const repo = path.resolve(repoArg);
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const ms = (t) => `${Math.round(performance.now() - t)} ms`;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// CLI check
let t = performance.now();
try { execFileSync('node', [CLI, 'check', '--root', repo], { stdio: 'pipe' }); } catch (e) { /* exit 1 on breaks */ }
console.log('check (cold process)        ', ms(t));

const server = spawn('node', [CLI, '--root', repo, '--port', port, '--no-open'], { stdio: 'pipe' });
t = performance.now();
for (;;) { try { await fetch(`${base}/api/state`); break; } catch { await sleep(50); } }
console.log('server ready                ', ms(t));

t = performance.now();
const st = await (await fetch(`${base}/api/state`)).text();
console.log('GET /api/state              ', ms(t), kb(st.length));

// SSE: count bytes per event type after each action
const sse = { bytes: 0, events: {} };
const ctrl = new AbortController();
const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.match(/^event: (\w+)/m)?.[1];
        if (ev) { sse.bytes += block.length; sse.events[ev] = (sse.events[ev] ?? 0) + block.length; }
      }
    }
  } catch { /* aborted */ }
})();
await sleep(1500);
console.log('SSE on connect              ', kb(sse.bytes), JSON.stringify(Object.fromEntries(Object.entries(sse.events).map(([k, v]) => [k, kb(v)]))));

const ping = async (file) => {
  const t1 = performance.now();
  await fetch(`${base}/api/agent-edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: repo, file: path.join(repo, file), tool: 'Edit' }) });
  return performance.now() - t1;
};
const measureEdit = async (label, act, file) => {
  sse.bytes = 0; sse.events = {};
  act();
  const reply = await ping(file);
  await sleep(2500);
  console.log(label.padEnd(28), `hook reply ${Math.round(reply)} ms`, ' SSE after:', kb(sse.bytes), JSON.stringify(Object.fromEntries(Object.entries(sse.events).map(([k, v]) => [k, kb(v)]))));
};
const edited = 'src/p2/m3/f61.ts';
const orig = fs.readFileSync(path.join(repo, edited), 'utf8');
await measureEdit('edit a file', () => fs.writeFileSync(path.join(repo, edited), orig + '\nexport const extra = 1;\n'), edited);
const created = 'src/p4/m1/zz_new.ts';
await measureEdit('create a file', () => fs.writeFileSync(path.join(repo, created), "import { v } from '../m0/f0';\nexport const z = v;\n"), created);

// history
t = performance.now();
const log = await (await fetch(`${base}/api/history`)).json();
console.log('GET /api/history            ', ms(t), `${log.commits?.length} commits`);
for (const c of (log.commits ?? []).slice(0, 3)) {
  t = performance.now();
  // while the commit computes, see how long a cheap request waits
  const side = (async () => { await sleep(20); const t2 = performance.now(); await fetch(`${base}/api/state`); return performance.now() - t2; })();
  const r = await (await fetch(`${base}/api/commit?rev=${c.hash}`)).text();
  console.log(`GET /api/commit ${c.hash.slice(0, 7)}     `, ms(t), kb(r.length), ` (/api/state meanwhile: ${Math.round(await side)} ms)`);
}

// drift over the whole history, and how responsive the server stays meanwhile
t = performance.now();
let drift, worst = 0;
for (;;) {
  drift = await (await fetch(`${base}/api/drift`)).json();
  const t2 = performance.now();
  await fetch(`${base}/api/state`);
  worst = Math.max(worst, performance.now() - t2);
  if (drift.done || drift.error || performance.now() - t > 300_000) break;
  await sleep(300);
}
console.log('drift, whole history        ', ms(t), `${drift.points?.length}/${drift.total} commits`, ` (/api/state worst meanwhile: ${Math.round(worst)} ms)`);

fs.writeFileSync(path.join(repo, edited), orig);
fs.rmSync(path.join(repo, created), { force: true });
await sleep(2000);
ctrl.abort();
server.kill();
console.log('total', ms(t0));
process.exit(0);
