#!/usr/bin/env node
// Copyright (c) 2026 Orest Zogju. Part of al dente: https://github.com/Orest-Z/al-dente
// SPDX-License-Identifier: MIT
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const HELP = `al-dente: a live architecture map your coding agent has to respect
by Orest Zogju, MIT license: https://github.com/Orest-Z/al-dente

Usage
  al-dente [map]     open the live map for this project (default)
  al-dente check     check every file once; exits 1 on rule breaks
  al-dente survey    an existing project's folders and the imports between them, to plan its parts
  al-dente diff [base]
                     what this branch does to the architecture, compared with where it forked
                     from base (default: main). Markdown for a PR comment; exits 1 only on
                     rule breaks it adds, so older debt never fails a PR

Options
  --root <dir>       project folder (default: current folder)
  --port <n>         map port (default: 4747, or AL_DENTE_PORT)
  --no-open          don't open the browser
  --head <rev>       diff: compare a commit instead of the working tree
  --json             diff, survey: print JSON instead of text`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', default: '.' },
      port: { type: 'string', default: process.env.AL_DENTE_PORT ?? '4747' },
      'no-open': { type: 'boolean', default: false },
      head: { type: 'string' },
      json: { type: 'boolean', default: false },
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

if (values.help || !['map', 'check', 'diff', 'survey'].includes(command)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

try {
  if (command === 'check') await check();
  else if (command === 'diff') await diff();
  else if (command === 'survey') await surveyCommand();
  else await map();
} catch (e) {
  console.error(`al-dente: ${e.message}`);
  process.exit(1);
}

async function check() {
  const { RULES_FILE, diskImports, readRules, violationsIn } = await import('../src/core.js');
  const rules = readRules(root);
  if (!rules) throw new Error(`no ${RULES_FILE} in ${root}. Ask your agent to design the architecture first.`);
  const label = (id) => rules.byId.get(id)?.label ?? 'no part'; // files no part claims
  const files = diskImports(root, rules);
  const broken = [...files].flatMap(([rel, imports]) => violationsIn(rules, rel, imports).map((v) => ({ rel, ...v })));

  if (!broken.length) {
    console.log(`✓ Matches the plan: ${files.size} files across ${rules.parts.length} parts follow ${RULES_FILE}.`);
    return;
  }
  console.log(`✗ ${broken.length} import${broken.length === 1 ? '' : 's'} break the plan in ${RULES_FILE}:\n`);
  for (const v of broken) console.log(`  ${v.rel}:${v.line}  ${label(v.from)} → ${label(v.to)}  ("${v.spec}")`);
  process.exitCode = 1;
}

async function diff() {
  const { diffArchitecture, toMarkdown } = await import('../src/diff.js');
  const d = diffArchitecture(root, { base: positionals[1], head: values.head });
  console.log(values.json ? JSON.stringify(d, null, 2) : toMarkdown(d));
  if (d.broke.length) process.exitCode = 1;
}

async function surveyCommand() {
  const { survey, surveyText } = await import('../src/survey.js');
  const s = survey(root);
  console.log(values.json ? JSON.stringify(s, null, 2) : surveyText(s));
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
