import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGraph, createResolver, listSources, readRules, violationsIn } from '../src/core.js';

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
