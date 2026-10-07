// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Does the feature actually work? Starts the shop's real server from the run's folder and tries it end to end.
//   greeting: headless Chrome signs up, reloads, and reads the header (catches browser code that can't load)
//   receipt:  sign up, buy, check out; the server's console must show the order id and the customer's email
//   orders:   two orders; GET /api/orders must return both, newest first; the web app must call it
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function startServer(dir) {
  const port = 41000 + Math.floor(Math.random() * 9000);
  fs.rmSync(path.join(dir, 'db'), { recursive: true, force: true });
  const proc = spawn(process.execPath, ['src/api/server.ts'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/products`)).ok) break; } catch { /* not up yet */ }
    await sleep(150);
  }
  return { base, proc, out: () => out, stop: () => { proc.kill(); fs.rmSync(path.join(dir, 'db'), { recursive: true, force: true }); } };
}

/** A tiny client that keeps the session cookie. */
function client(base) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
}

async function inChrome(url, script) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(150); } }
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const waiting = new Map(), errors = [];
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text);
    });
    const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await cdp('Runtime.enable');
    await cdp('Log.enable');
    await cdp('Page.navigate', { url });
    await sleep(1500);
    const value = await script((expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.result?.value));
    ws.close();
    return { value, errors };
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(prof, { recursive: true, force: true });
  }
}

export async function checkFeature(task, dir) {
  const srv = await startServer(dir);
  const email = `ana.${Math.floor(Math.random() * 1e6)}@example.com`;
  try {
    if (task === 'greeting') {
      const { value, errors } = await inChrome(`${srv.base}/`, async (run) => {
        await run(`fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ${JSON.stringify(email)}, password: 'correct-horse-1' }) }).then((r) => r.status)`);
        await run('location.reload()');
        await sleep(1800);
        return run(`document.querySelector('header')?.innerText ?? ''`);
      });
      const pass = typeof value === 'string' && value.includes(email);
      return { pass, detail: pass ? 'header shows the email' : `header: ${JSON.stringify(value)}${errors.length ? ` · browser errors: ${errors.slice(0, 2).join(' | ').slice(0, 300)}` : ''}` };
    }
    const api = client(srv.base);
    const signup = await api('POST', '/api/signup', { email, password: 'correct-horse-1' });
    if (signup.status !== 200) return { pass: false, detail: `signup ${signup.status}` };
    if (task === 'receipt') {
      await api('POST', '/api/cart', { productId: 'p1' });
      const order = await api('POST', '/api/checkout');
      await sleep(600);
      const log = srv.out();
      const pass = order.status === 200 && log.includes(email) && log.includes(String(order.data?.id ?? '¤').slice(0, 8));
      return { pass, detail: pass ? 'receipt logged with id and email' : `checkout ${order.status}; console: ${JSON.stringify(log.slice(-300))}` };
    }
    if (task === 'welcome') {
      const cart = await api('GET', '/api/cart');
      const line = Array.isArray(cart.data) ? cart.data.find((l) => l.productId === 'p1') : null;
      const pass = cart.status === 200 && !!line && line.qty >= 1;
      return { pass, detail: pass ? 'new account starts with the tote bag in the cart' : `cart ${cart.status} ${JSON.stringify(cart.data)}` };
    }
    if (task === 'orders') {
      await api('POST', '/api/cart', { productId: 'p1' });
      const first = await api('POST', '/api/checkout');
      await sleep(20);
      await api('POST', '/api/cart', { productId: 'p2' });
      const second = await api('POST', '/api/checkout');
      const list = await api('GET', '/api/orders');
      const ids = Array.isArray(list.data) ? list.data.map((o) => o.id) : [];
      const apiOk = list.status === 200 && ids.length === 2 && ids[0] === second.data?.id && ids[1] === first.data?.id;
      const web = fs.readdirSync(path.join(dir, 'src/web'), { recursive: true }).filter((f) => String(f).endsWith('.ts'))
        .some((f) => fs.readFileSync(path.join(dir, 'src/web', String(f)), 'utf8').includes('/api/orders'));
      const pass = apiOk && web;
      return { pass, detail: pass ? 'API returns both orders newest first; web app calls it' : `api ${list.status} ${JSON.stringify(ids)} (want ${second.data?.id}, ${first.data?.id}); web calls it: ${web}` };
    }
    throw new Error(`unknown task ${task}`);
  } finally {
    srv.stop();
  }
}

// Direct use: node check.mjs <task> <dir>
if (process.argv[1]?.endsWith('check.mjs')) console.log(await checkFeature(process.argv[2], process.argv[3]));
