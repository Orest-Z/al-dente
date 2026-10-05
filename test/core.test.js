import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGraph, createResolver, listSources, readRules, scanImports, violationsIn } from '../src/core.js';

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
