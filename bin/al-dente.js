#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const HELP = `al-dente: a live architecture map your coding agent has to respect

Usage
  al-dente [map]     open the live map for this project (default)
  al-dente check     check every file once; exits 1 on rule breaks (use it in CI)

Options
  --root <dir>       project folder (default: current folder)
  --port <n>         map port (default: 4747, or AL_DENTE_PORT)
  --no-open          don't open the browser`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      port: { type: 'string', default: process.env.AL_DENTE_PORT ?? '4747' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(1);
}
const { values, positionals } = args;
const command = positionals[0] ?? 'map';
const root = path.resolve(values.root);

if (values.help || !['map', 'check'].includes(command)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

try {
  if (command === 'check') await check();
  else await map();
} catch (e) {
  console.error(`al-dente: ${e.message}`);
  process.exit(1);
}

async function check() {
  const { RULES_FILE, createResolver, listSources, readRules, violationsIn } = await import('../src/core.js');
  const rules = readRules(root);
  if (!rules) throw new Error(`no ${RULES_FILE} in ${root}. Ask your agent to design the architecture first.`);
  const resolver = createResolver(root);
  const label = (id) => rules.byId.get(id).label;
  const files = listSources(root);
  const broken = files.flatMap((rel) => violationsIn(rules, rel, resolver.importsOf(rel)).map((v) => ({ rel, ...v })));

  if (!broken.length) {
    console.log(`✓ Matches the plan: ${files.length} files across ${rules.parts.length} parts follow ${RULES_FILE}.`);
    return;
  }
  console.log(`✗ ${broken.length} import${broken.length === 1 ? '' : 's'} break the plan in ${RULES_FILE}:\n`);
  for (const v of broken) console.log(`  ${v.rel}:${v.line}  ${label(v.from)} → ${label(v.to)}  ("${v.spec}")`);
  process.exitCode = 1;
}

async function map() {
  const { startServer } = await import('../src/server.js');
  let url;
  try {
    ({ url } = await startServer({ root, port: Number(values.port) }));
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`port ${values.port} is busy. Is the map already open? Try --port 4748.`);
    throw e;
  }
  console.log(`al-dente is watching ${path.basename(root)}  →  ${url}`);
  if (values['no-open']) return;
  const [cmd, ...cmdArgs] = process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url]
    : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref();
}
