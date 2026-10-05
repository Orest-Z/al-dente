import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGraph, createResolver, describeFile, isIgnored, listSources, readRules, scanImports, violationsIn } from '../src/core.js';
import { createHistory } from '../src/history.js';

const root = fileURLToPath(new URL('../examples/shop', import.meta.url));
const rules = readRules(root);
const resolver = createResolver(root);

test('the example shop follows its own plan', () => {
  const graph = buildGraph(rules, new Map(listSources(root).map((f) => [f, resolver.importsOf(f)])));
  assert.equal(graph.violations, 0);
  assert.ok(graph.edges.some((e) => e.from === 'features' && e.to === 'data' && e.kind === 'allowed'));
  assert.deepEqual(graph.planned, [{ from: 'screens', to: 'shared' }]);
});

test('a forbidden import is caught with its line, through a tsconfig path alias', () => {
  const file = 'src/components/ProductCard.tsx';
  const src = "import { formatPrice } from '@/shared/format';\nimport { cartStore } from '@/data/cartStore';\n";
  const broken = violationsIn(rules, file, resolver.importsOf(file, src));
  assert.deepEqual(broken.map((v) => [v.line, v.from, v.to, v.target]), [[2, 'components', 'data', 'src/data/cartStore.ts']]);
});

test('import scanning ignores comments and strings that only look like imports', () => {
  const src = [
    "import a, { b as c } from './a';",
    "// import nope from './commented';",
    "const url = 'https://example.com/x'; import type { T } from \"./types\";",
    '/* import alsoNope from "./block"; */',
    'export * from "./re-export";',
    'import {',
    '  multi,',
    "} from './multi-line';",
    "const lazy = () => import('./lazy');",
    "const old = require('./old');",
    'import.meta.url;',
  ].join('\n');
  assert.deepEqual(
    scanImports(src).map((i) => i.spec),
    ['./a', './types', './re-export', './multi-line', './lazy', './old'],
  );
});

test('monorepo: workspace packages, tsconfig references, JSONC configs and .js-to-.ts imports', () => {
  const mono = fileURLToPath(new URL('./fixtures/mono', import.meta.url));
  const r = createResolver(mono);
  const targets = (file) => r.importsOf(file).map((i) => [i.spec, i.target]);
  assert.deepEqual(targets('apps/web/src/main.ts'), [
    ['@web/ui/button', 'apps/web/src/ui/button.ts'],
    ['@mono/shared/math', 'packages/shared/src/math.ts'],
  ]);
  assert.deepEqual(targets('apps/web/src/ui/button.ts'), [['@mono/shared', 'packages/shared/src/index.ts']]);
  assert.deepEqual(targets('packages/shared/src/index.ts'), [['./math.js', 'packages/shared/src/math.ts']]);
});

test('file descriptions: top doc comment first, otherwise a summary from the code', () => {
  const d = (rel, src) => describeFile(rel, src).text;
  assert.equal(d('a.ts', "// @ts-check\nimport x from './x';\n\n/**\n * Talks to the payment API. Retries twice.\n */\n\nexport function pay() {}\n"), 'Talks to the payment API.');
  // A comment sitting on one export among several documents that export, not the file.
  assert.equal(d('vcam.ts', '/** Pixel formats. */\nexport type Format = 1;\nexport function push() {}\n'), 'Exports Format, push');
  assert.equal(d('ui/Card.tsx', 'export default function Card() {}\nexport function useCard() {}\n'), 'React component: Card; hook: useCard');
  assert.equal(d('main.ts', "import './boot';\nstart();\n"), 'Entry point: runs when loaded, exports nothing');
  assert.equal(d('test/x.test.ts', "describe('cart', () => { test('adds', () => {}); });"), 'Tests for cart');
});

test('ignore: tests are left out of the architecture by default, and a plan can choose its own list', () => {
  for (const rel of ['src/ui/a.test.ts', 'src/ui/__tests__/x.tsx', 'test/setup.ts', 'apps/web/tests/e2e.ts', 'src/ui/Card.stories.tsx']) {
    assert.equal(isIgnored(rules, rel), true, rel);
  }
  for (const rel of ['src/ui/attest.ts', 'src/testing/x.ts', 'src/ui/Card.tsx']) assert.equal(isIgnored(rules, rel), false, rel);
  // A test reaching into another part is fine; the same import from production code is not.
  const crossing = resolver.importsOf('src/components/ProductCard.tsx', "import { cartStore } from '@/data/cartStore';\n");
  assert.equal(violationsIn(rules, 'src/components/ProductCard.test.tsx', crossing).length, 0);
  assert.equal(violationsIn(rules, 'src/components/ProductCard.tsx', crossing).length, 1);
});

/** A throwaway repo: ui may use shared, nothing may use data. */
function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'al-dente-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  write('al-dente.json', JSON.stringify({ parts: { ui: { paths: ['src/ui'], uses: ['shared'] }, data: { paths: ['src/data'], uses: [] }, shared: { paths: ['src/shared'], uses: [] } } }));
  write('src/shared/fmt.ts', 'export const fmt = 1;\n');
  write('src/data/db.ts', 'export const db = 1;\n');
  write('src/data/cache.ts', 'export const cache = 1;\n');
  git('init', '-q');
  return { repo, git, write, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test('history: a commit that adds a forbidden import shows up as a new rule break, and in the drift', async () => {
  const { repo, git, write, done } = tempRepo();
  write('src/ui/page.ts', "import { fmt } from '../shared/fmt';\n");
  write('src/ui/page.test.ts', "import { db } from '../data/db';\n"); // tests may import anything
  git('add', '.');
  git('commit', '-qm', 'First');
  write('src/ui/page.ts', "import { fmt } from '../shared/fmt';\nimport { db } from '../data/db';\n");
  git('commit', '-qam', 'Reach into data (#7)');

  const h = createHistory(repo);
  try {
    const { commits } = await h.log(false);
    assert.deepEqual(commits.map((c) => [c.title, c.pr]), [['Reach into data', 7], ['First', null]]);
    const c = await h.commit(readRules(repo), commits[0].hash);
    assert.deepEqual(c.violations, { before: 0, after: 1 });
    assert.deepEqual(c.edges.added.map((e) => [e.from, e.to, e.kind]), [['ui', 'data', 'violation']]);
    assert.deepEqual(c.changes.map((f) => [f.status, f.path, f.add, f.del, f.delta.broke.map((v) => v.line)]), [['M', 'src/ui/page.ts', 1, 0, [2]]]);
    assert.equal(c.graph.files['src/ui/page.test.ts'], undefined);

    let drift;
    for (let i = 0; i < 200 && !drift?.done; i++) {
      drift = await h.drift(readRules(repo), false);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(drift.points.map((p) => [p.v, p.dv, p.added]), [[1, 1, 1], [0, 0, 1]]);
    assert.deepEqual(drift.stats[commits[0].hash], [1, 1, 0]);

    // A new commit fixes the break: once HEAD moves, the drift picks it up.
    write('src/ui/page.ts', "import { fmt } from '../shared/fmt';\n");
    git('commit', '-qam', 'Go through shared again');
    await h.headMoved();
    drift = null;
    for (let i = 0; i < 200 && !drift?.done; i++) {
      drift = await h.drift(readRules(repo), false);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(drift.points.map((p) => [p.v, p.dv]), [[0, -1], [1, 1], [0, 0]]);
  } finally {
    await h.close();
    done();
  }
});

test('hook: only breaks this edit introduced block Claude; breaks already committed do not', () => {
  const { repo, git, write, done } = tempRepo();
  const hook = (rel) => {
    const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, rel) } });
    try {
      execFileSync('node', [fileURLToPath(new URL('../src/hook.js', import.meta.url))], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: repo, AL_DENTE_PORT: '9' }, stdio: 'pipe' });
      return { code: 0, err: '' };
    } catch (e) { return { code: e.status, err: e.stderr.toString() }; }
  };
  try {
    write('src/ui/page.ts', "import { db } from '../data/db';\n"); // committed debt
    git('add', '.');
    git('commit', '-qm', 'Old debt');
    write('src/ui/page.ts', "import { db } from '../data/db';\nexport const x = 1;\n");
    assert.deepEqual(hook('src/ui/page.ts'), { code: 0, err: '' }, 'touching a file with old debt is fine');
    write('src/ui/page.ts', "import { db } from '../data/db';\nimport { cache } from '../data/cache';\n");
    const r = hook('src/ui/page.ts');
    assert.equal(r.code, 2);
    assert.match(r.err, /line 2: imports "\.\.\/data\/cache"/);
    assert.doesNotMatch(r.err, /line 1/, 'the old break is not reported as new');
    write('src/ui/fresh.ts', "import { db } from '../data/db';\n");
    assert.equal(hook('src/ui/fresh.ts').code, 2, 'a new file has no committed version: every break counts');
  } finally {
    done();
  }
});
