// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
// Screenshots of the live map through headless Chrome (DevTools protocol over Node's built-in WebSocket; no deps).
// Usage: node scripts/screenshot.mjs <url> <out-prefix> [steps.json]   Set CHROME to the browser binary if needed.
// steps: [{ "js": "...", "wait": 600, "shot": "name", "w": 1600, "h": 1000, "dark": true }]
// "js" runs in the page (its value is printed); page exceptions and console output are printed at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, out, stepsFile] = process.argv.slice(2);
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ shot: 'main' }];
const port = 9333 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn(process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1600,1000', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const logs = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
  if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.type + ' ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
});
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Runtime.enable');
let w = 1600, h = 1000;
await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url });
await sleep(1500);
for (const s of steps) {
  if (s.w) { w = s.w; h = s.h ?? h; await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }); }
  if (s.dark !== undefined) await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }] });
  if (s.js) { const r = await cdp('Runtime.evaluate', { expression: s.js, awaitPromise: true, returnByValue: true }); const v = r.result?.result?.value; if (v !== undefined) console.log('js>', typeof v === 'string' ? v : JSON.stringify(v)); if (r.result?.exceptionDetails) console.log('js error', JSON.stringify(r.result.exceptionDetails.exception?.description)); }
  await sleep(s.wait ?? 400);
  if (s.shot) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}-${s.shot}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', `${out}-${s.shot}.png`); }
}
if (logs.length) console.log(logs.join('\n'));
ws.close(); chrome.kill();
process.exit(0);
