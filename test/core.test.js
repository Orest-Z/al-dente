import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGraph, createResolver, describeFile, diskImports, isIgnored, listSources, readRules, scanImports, violationsIn } from '../src/core.js';
import { diffArchitecture, toMarkdown } from '../src/diff.js';
import { createEngine, createHistory } from '../src/history.js';
import { survey, surveyText } from '../src/survey.js';

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
    // Strings and templates whose text only looks like an import: code generators, docs, snippets.
    "const tpl = \"import { db } from '../data/db'\";",
    "const say = 'it\\'s require(\"./not-a-require\")';",
    'const gen = `export * from "./generated";\n  import x from "./also-not";`;',
    // Code inside `${}` is code, even with braces and a nested template in it.
    'const msg = `loaded ${(await import("./in-template")).name} and ${ { a: `${require("./nested")}` }.a }`;',
    "import after from './after-templates';",
  ].join('\n');
  assert.deepEqual(
    scanImports(src).map((i) => i.spec),
    ['./a', './types', './re-export', './multi-line', './lazy', './old', './in-template', './nested', './after-templates'],
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

test('python: src layout, relative and parenthesised imports, scripts, and the same answer from git history', () => {
  const py = fileURLToPath(new URL('./fixtures/py', import.meta.url));
  const r = createResolver(py), plan = readRules(py);
  const imports = (file) => r.importsOf(file).map((i) => [i.line, i.spec, i.target]);
  // The docstring and the comment that look like imports don't count; fastapi, os and typing aren't project files.
  assert.deepEqual(imports('src/shop/api/routes.py'), [
    [11, 'shop.services.orders', 'src/shop/services/orders.py'], // a submodule
    [12, '..shared.money', 'src/shop/shared/money.py'], // names from a module, over several lines: one import
    [16, 'shop.data.models', 'src/shop/data/models.py'],
    [19, 'shop.data.repo', 'src/shop/data/repo.py'], // inside `if TYPE_CHECKING:`
  ]);
  assert.deepEqual(imports('src/shop/services/orders.py'), [
    [2, 'shop.data.repo', 'src/shop/data/repo.py'],
    [3, '.pricing', 'src/shop/services/pricing.py'],
    [5, 'shop.data.plugins', 'src/shop/data/plugins/__init__.py'], // importlib.import_module("…")
  ]);
  assert.deepEqual(imports('scripts/seed.py'), [[1, 'helpers', 'scripts/helpers.py'], [2, 'shop.services.orders', 'src/shop/services/orders.py']]);
  assert.deepEqual(violationsIn(plan, 'src/shop/api/routes.py', r.importsOf('src/shop/api/routes.py')).map((v) => [v.line, v.to]), [[16, 'data'], [19, 'data']]);
  assert.ok(isIgnored(plan, 'tests/test_orders.py') && isIgnored(plan, 'src/shop/conftest.py'));

  const d = (rel) => describeFile(rel, fs.readFileSync(path.join(py, rel), 'utf8')).text;
  assert.equal(d('src/shop/api/routes.py'), 'HTTP routes for orders.');
  assert.equal(d('src/shop/services/orders.py'), 'Places and cancels orders.'); // the docstring of its one class
  assert.equal(d('src/shop/services/__init__.py'), 'Package: re-exports place_order');
  assert.equal(d('src/shop/services/pricing.py'), 'Functions: price');
  assert.equal(d('scripts/seed.py'), 'Script entry point; defines main');

  // History reads the same files from a commit (git objects, not the disk) and must agree.
  const { repo, git, done } = tempRepo();
  try {
    fs.cpSync(py, repo, { recursive: true });
    git('add', '.');
    git('commit', '-qm', 'Python shop');
    const atHead = createEngine(repo).imports(readRules(repo), 'HEAD');
    assert.deepEqual(atHead.get('src/shop/api/routes.py').map((i) => i.target), imports('src/shop/api/routes.py').map((i) => i[2]));
    assert.deepEqual(atHead.get('scripts/seed.py').map((i) => i.target), ['scripts/helpers.py', 'src/shop/services/orders.py']);
  } finally { done(); }
});

test('java: single, static, nested and wildcard imports, names written out in code, two modules, and the same answer from git history', () => {
  const java = fileURLToPath(new URL('./fixtures/java', import.meta.url));
  const r = createResolver(java), plan = readRules(java);
  const main = 'src/main/java/com/acme/shop', at = (p) => `${main}/${p}.java`;
  const imports = (file) => r.importsOf(file).map((i) => [i.line, i.spec, i.target]);
  // Comments, strings and text blocks that look like imports don't count; java.util isn't in the project.
  assert.deepEqual(imports(at('web/OrderController')), [
    [6, 'com.acme.shop.data.Order', at('data/Order')], // a wildcard: only the classes this file uses
    [6, 'com.acme.shop.data.OrderRepository', at('data/OrderRepository')],
    [7, 'com.acme.shop.service.OrderService', at('service/OrderService')],
  ]);
  assert.deepEqual(imports(at('service/OrderService')), [
    [3, 'com.acme.shop.shared.Money.cents', at('shared/Money')], // a static member
    [4, 'com.acme.shop.data.OrderRepository', at('data/OrderRepository')],
    [5, 'com.acme.shop.shared.Money.Currency', at('shared/Money')], // a nested class
    [10, 'com.acme.shop.data.Order', at('data/Order')], // written out in full, without an import
  ]);
  // Two modules with a class of the same name: each file gets the one nearest to it.
  assert.deepEqual(imports('tools/src/main/java/com/acme/shop/tools/Report.java'), [[3, 'com.acme.shop.shared.Money', 'tools/src/main/java/com/acme/shop/shared/Money.java']]);
  assert.deepEqual(violationsIn(plan, at('web/OrderController'), r.importsOf(at('web/OrderController'))).map((v) => [v.line, v.to]), [[6, 'data'], [6, 'data']]);
  assert.ok(isIgnored(plan, 'src/test/java/com/acme/shop/web/OrderControllerTest.java'));

  const d = (rel) => describeFile(rel, fs.readFileSync(path.join(java, rel), 'utf8')).text;
  assert.equal(d(at('web/OrderController')), 'HTTP endpoints for orders, backed by OrderService.'); // its Javadoc, not the license
  assert.equal(d(at('data/OrderRepository')), 'Interface: all, find');
  assert.equal(d(at('data/Status')), 'Enum: NEW, PAID, SHIPPED +1 more');
  assert.equal(d(at('App')), 'Entry point');

  const { repo, git, write, done } = tempRepo();
  try {
    fs.rmSync(path.join(repo, 'src'), { recursive: true });
    fs.cpSync(java, repo, { recursive: true });
    git('add', '.');
    git('commit', '-qm', 'Java shop');
    // History reads the same files from a commit (git objects, not the disk) and must agree.
    const atHead = createEngine(repo).imports(readRules(repo), 'HEAD');
    for (const file of [at('web/OrderController'), at('service/OrderService'), 'tools/src/main/java/com/acme/shop/tools/Report.java']) {
      assert.deepEqual(atHead.get(file), createResolver(repo).importsOf(file), file);
    }
    // A folder whose files declare another package isn't that package, however near it is.
    write(`${main}/service/x/com/acme/shop/data/Order.java`, 'package com.acme.shop.service.x.com.acme.shop.data;\npublic record Order() {}\n');
    // Maven's build output next to a pom.xml is never read: generated code isn't a project file.
    write('pom.xml', '<project/>\n');
    write('target/generated-sources/annotations/com/acme/shop/data/Order_.java', 'package com.acme.shop.data;\npublic class Order_ {}\n');
    const fresh = createResolver(repo);
    assert.deepEqual(fresh.importsOf(at('service/OrderService')), atHead.get(at('service/OrderService')));
    assert.deepEqual(fresh.importsOf(at('service/OrderService'), 'package com.acme.shop.service;\nimport com.acme.shop.data.Order_;\n'), []);
  } finally { done(); }
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

test('a part importing a file no part claims breaks the plan (no slipping past through a helper), unless git ignores it', () => {
  const { repo, write, done } = tempRepo();
  try {
    write('src/helpers/bridge.ts', "import { db } from '../data/db';\nexport const bridge = db;\n"); // outside every part: may use parts
    write('src/ui/page.ts', "import { fmt } from '../shared/fmt';\nimport { bridge } from '../helpers/bridge';\n");
    write('.gitignore', 'src/generated/\n');
    write('src/generated/client.ts', 'export const client = 1;\n'); // generated code isn't the project's
    write('src/ui/list.ts', "import { client } from '../generated/client';\n");
    const plan = readRules(repo), files = diskImports(repo, plan);
    assert.deepEqual([...files].flatMap(([rel, imps]) => violationsIn(plan, rel, imps).map((v) => [rel, v.line, v.to, v.target])),
      [['src/ui/page.ts', 2, '~unmapped', 'src/helpers/bridge.ts']]);
    assert.deepEqual(buildGraph(plan, files).edges.map((e) => [e.from, e.to, e.kind]).sort(),
      [['ui', 'shared', 'allowed'], ['ui', '~unmapped', 'violation'], ['~unmapped', 'data', 'unchecked']]);
    const hook = (rel) => {
      const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, rel) } });
      try { execFileSync('node', [fileURLToPath(new URL('../src/hook.js', import.meta.url))], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: repo, AL_DENTE_PORT: '9' }, stdio: 'pipe' }); return { code: 0, err: '' }; }
      catch (e) { return { code: e.status, err: e.stderr.toString() }; }
    };
    const r = hook('src/ui/page.ts');
    assert.equal(r.code, 2);
    assert.match(r.err, /line 2: imports "\.\.\/helpers\/bridge" \(src\/helpers\/bridge\.ts\), which no part claims/);
    assert.match(r.err, /^To fix: move the files no part claims into a part ui may use \(shared\)/m);
    assert.equal(hook('src/ui/list.ts').code, 0, 'generated code git ignores');
    assert.equal(hook('src/helpers/bridge.ts').code, 0, 'files outside every part may use parts');
    // The message names the allowed way through the plan, so the fix needs no search.
    write('al-dente.json', JSON.stringify({ parts: { ui: { paths: ['src/ui'], uses: ['shared'] }, shared: { paths: ['src/shared'], uses: ['data'] }, data: { paths: ['src/data'], uses: [] } } }));
    write('src/ui/deep.ts', "import { db } from '../data/db';\n");
    assert.match(hook('src/ui/deep.ts').err, /^To fix: reach data through shared \(ui → shared → data\)\.$/m);
  } finally { done(); }
});

test('survey: folders grouped to a readable size (one-way chains passed through) and the imports between them', () => {
  const s = survey(fileURLToPath(new URL('./fixtures/java', import.meta.url)));
  const shop = 'src/main/java/com/acme/shop';
  assert.deepEqual(s.groups.map((g) => [g.path, g.files]),
    [[`${shop}/App.java`, 1], [`${shop}/data`, 3], [`${shop}/service`, 1], [`${shop}/shared`, 1], [`${shop}/web`, 1], ['tools', 2]]);
  assert.deepEqual(s.edges.map((e) => [e.from, e.to, e.count]), [[0, 4, 1], [2, 1, 2], [2, 3, 1], [4, 1, 2], [4, 2, 1]]);
  const text = surveyText(survey(root)); // the TypeScript shop: the shared start of the paths is said once
  assert.match(text, /^Folders \(paths below src\/\): files, most connected files$/m);
  assert.match(text, /^ {2}4\. screens +1 {2}HomeScreen\.tsx$/m);
  assert.match(text, /^ {2}4 → 1: 1, 3: 1$/m);
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

    // A branch against main: all its commits as one change, like a PR before merging.
    const main = git('rev-parse', 'HEAD').toString().trim();
    git('branch', '-M', 'main'); // whatever init.defaultBranch says
    git('checkout', '-qb', 'feature');
    write('src/ui/extra.ts', "import { db } from '../data/db';\n");
    git('add', '.');
    git('commit', '-qm', 'Extra page');
    write('src/ui/page.ts', "import { fmt } from '../shared/fmt';\n// tidy\n");
    git('commit', '-qam', 'Tidy');
    const k = await h.compare(readRules(repo));
    assert.equal(k.compare.branch, 'feature');
    assert.deepEqual(k.compare.commits.map((c) => c.title), ['Tidy', 'Extra page']);
    assert.equal(k.range.from, main);
    assert.deepEqual(k.changes.map((f) => [f.status, f.path]), [['A', 'src/ui/extra.ts'], ['M', 'src/ui/page.ts']]);
    assert.deepEqual(k.violations, { before: 0, after: 1 });
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

test('monorepo: the plan nearest to the edited file counts, and session start finds plans in subfolders', () => {
  const { repo, write, done } = tempRepo();
  const run = (script, input) => {
    try {
      return { code: 0, out: execFileSync('node', [fileURLToPath(new URL(`../src/${script}`, import.meta.url))], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: repo, AL_DENTE_PORT: '9' }, stdio: 'pipe' }).toString() };
    } catch (e) { return { code: e.status, out: e.stderr.toString() }; }
  };
  try {
    fs.rmSync(path.join(repo, 'al-dente.json')); // no plan where Claude Code was opened, only in the app
    write('apps/web/al-dente.json', JSON.stringify({ parts: { ui: { paths: ['src/ui'], uses: [] }, data: { paths: ['src/data'], uses: [] } } }));
    write('apps/web/src/data/db.ts', 'export const db = 1;\n');
    write('apps/web/src/ui/page.ts', "import { db } from '../data/db';\n");
    const r = run('hook.js', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'apps/web/src/ui/page.ts') } }));
    assert.equal(r.code, 2);
    assert.match(r.out, /^al-dente: apps\/web\/src\/ui\/page\.ts breaks the architecture agreed in apps\/web\/al-dente\.json\.$/m);
    assert.equal(run('hook.js', JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src/ui/x.ts') } })).code, 0, 'files outside the app have no plan');

    const s = run('session.js', '{"source":"startup"}').out;
    assert.match(s, /^The architecture of apps\/web\/ is agreed in apps\/web\/al-dente\.json/m);
    assert.match(s, /^- ui \(apps\/web\/src\/ui\) may use: nothing outside itself$/m);
    assert.match(s, /^- apps\/web\/src\/ui\/page\.ts:1 imports "\.\.\/data\/db" \(ui → data\)$/m);
  } finally {
    done();
  }
});

test('diff: a branch is judged only on the breaks it adds, and renders a PR comment with a Mermaid map', () => {
  const { repo, git, write, done } = tempRepo();
  const cli = (...args) => {
    try { return { code: 0, out: execFileSync('node', [fileURLToPath(new URL('../bin/al-dente.js', import.meta.url)), 'diff', '--root', repo, ...args], { stdio: 'pipe' }).toString() }; }
    catch (e) { return { code: e.status, out: e.stdout.toString() }; }
  };
  try {
    write('src/ui/page.ts', "import { db } from '../data/db';\n"); // debt already on main
    git('add', '.');
    git('commit', '-qm', 'Old debt');
    git('branch', '-M', 'main');
    git('checkout', '-qb', 'feature');
    git('mv', 'src/ui/page.ts', 'src/ui/home.ts'); // moving a file doesn't make its old break new
    write('src/ui/fresh.ts', "import { fmt } from '../shared/fmt';\nimport { cache } from '../data/cache';\n");
    git('add', '.');
    git('commit', '-qm', 'Add fresh');

    const d = diffArchitecture(repo, { head: 'HEAD' }); // base: found by itself (main)
    assert.deepEqual(d.broke.map((v) => [v.file, v.line, v.to]), [['src/ui/fresh.ts', 2, 'data']]);
    assert.deepEqual(d.fixed, []);
    assert.equal(d.graph.violations, 2);
    const md = toMarkdown(d);
    assert.match(md, /✗ \*\*Adds 1 rule break\*\*/);
    assert.match(md, /```mermaid\nflowchart TD/);
    assert.match(md, /`src\/ui\/fresh\.ts:2` \| `\.\.\/data\/cache` \(ui → data\)/);
    assert.match(md, /1 older rule break left as it was/);
    assert.equal(cli('main', '--head', 'HEAD').code, 1);

    // Names come from the pull request, so a label can't break out of the diagram or a table to fake a verdict.
    const fake = 'UI\n\n```\n</details>\n\n✓ **Follows the plan** \\| x'; // a backslash can't undo the pipe's escape
    d.labels.ui = fake;
    for (const p of d.graph.parts) if (p.id === 'ui') p.label = fake;
    const spoofed = toMarkdown(d);
    assert.doesNotMatch(spoofed, /^✓ \*\*Follows the plan\*\*/m);
    assert.equal(spoofed.split('</details>').length, md.split('</details>').length);
    const diagram = spoofed.split('```mermaid\n')[1].split('\n```')[0].split('\n');
    assert.ok(diagram.every((l) => l === 'flowchart TD' || l.startsWith('  ')), diagram.join('\n'));
    assert.match(spoofed, /\| `\.\.\/data\/cache` \(UI ``` &lt;\/details&gt; ✓ \*\*Follows the plan\*\* \\\\\\\| x → data\) \|/);

    // The working tree (the default head) undoes the new break: the PR would pass.
    write('src/ui/fresh.ts', "import { fmt } from '../shared/fmt';\n");
    const r = cli('main');
    assert.equal(r.code, 0);
    assert.match(r.out, /✓ \*\*Follows the plan\*\*/);
  } finally {
    done();
  }
});

test('session start: Claude gets the plan and the older breaks up front; projects without a plan get nothing', () => {
  const { repo, write, done } = tempRepo();
  const session = (dir) => execFileSync('node', [fileURLToPath(new URL('../src/session.js', import.meta.url))], { input: '{"source":"startup"}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, stdio: 'pipe' }).toString();
  try {
    write('src/ui/page.ts', "import { db } from '../data/db';\n");
    const out = session(repo);
    assert.match(out, /^- ui \(src\/ui\) may use: shared$/m);
    assert.match(out, /^- data \(src\/data\) may use: nothing outside itself$/m);
    assert.match(out, /^- src\/ui\/page\.ts:1 imports "\.\.\/data\/db" \(ui → data\)$/m);
    fs.rmSync(path.join(repo, 'al-dente.json'));
    assert.equal(session(repo), '');
  } finally {
    done();
  }
});
