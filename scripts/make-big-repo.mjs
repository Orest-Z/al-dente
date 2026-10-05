// Synthetic "big" TS repo for al-dente perf tests: 12 layered parts (each may use the next three),
// N files with ~0.5% forbidden imports, a gitignored generated file, and a git history with PR merges.
// Usage: node scripts/make-big-repo.mjs <dir> [files=4800] [commits=60]   (~45 s for the defaults on Windows)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dir, nFiles = '4800', nCommits = '60'] = process.argv.slice(2);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Dev', '-c', 'user.email=dev@x', ...a], { stdio: 'pipe' });

const P = 12, perPart = Math.ceil(Number(nFiles) / P);
const parts = {};
for (let i = 0; i < P; i++) {
  parts[`p${i}`] = { label: `Part ${i}`, description: `Layer ${i} of the synthetic app`, paths: [`src/p${i}`], uses: [1, 2, 3].map((d) => i + d).filter((j) => j < P).map((j) => `p${j}`) };
}
fs.writeFileSync(path.join(dir, 'al-dente.json'), JSON.stringify({ parts }, null, 2));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'big', private: true }));
fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ngenerated\n');

const files = []; // [part, rel]
for (let i = 0; i < P; i++) for (let f = 0; f < perPart; f++) files.push([i, `src/p${i}/m${Math.floor(f / 20)}/f${f}.ts`]);
const byPart = (i) => files.filter(([p]) => p === i).map(([, r]) => r);
const spec = (from, to) => {
  if (rnd() < 0.5) return '@/' + to.slice(4).replace(/\.ts$/, '');
  let r = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/, '');
  return r.startsWith('.') ? r : './' + r;
};
const body = (i, rel, extra = []) => {
  const imps = [];
  const n = 3 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) {
    const r = rnd();
    let target;
    if (r < 0.6) target = pick(byPart(i));
    else if (r < 0.995) { const u = parts[`p${i}`].uses; if (!u.length) continue; target = pick(byPart(Number(pick(u).slice(1)))); }
    else target = pick(byPart(i === 0 ? 5 : i - 1)); // rare rule break
    if (target !== rel) imps.push(target);
  }
  const lines = [`/** Module ${rel}: does a thing for layer ${i}. */`];
  [...new Set([...imps, ...extra])].forEach((t, k) => lines.push(`import { v as v${k} } from '${spec(rel, t)}';`));
  lines.push('', `export const v = ${Math.floor(rnd() * 1000)};`);
  for (let k = 0; k < 30; k++) lines.push(`export function fn${k}(a: number, b: string): string { return b.repeat(a) + '${k}'; }`);
  return lines.join('\n') + '\n';
};
for (const [i, rel] of files) {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body(i, rel));
}
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-qm', 'Initial app');

let pr = 1;
for (let c = 0; c < Number(nCommits); c++) {
  const onBranch = c % 3 === 0;
  if (onBranch) git('checkout', '-q', '-b', `feat/x${c}`);
  const touched = 3 + Math.floor(rnd() * 8);
  for (let k = 0; k < touched; k++) {
    const [i, rel] = pick(files);
    const extra = rnd() < 0.15 ? [pick(byPart(i === 0 ? 6 : i - 1))] : [];
    fs.writeFileSync(path.join(dir, rel), body(i, rel, extra));
  }
  if (c % 7 === 0) { // add files
    for (let k = 0; k < 3; k++) {
      const i = Math.floor(rnd() * P);
      const rel = `src/p${i}/new/n${c}_${k}.ts`;
      files.push([i, rel]);
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body(i, rel));
    }
  }
  git('add', '.');
  git('commit', '-qm', `Change ${c}: tweak ${touched} modules`);
  if (onBranch) {
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', `feat/x${c}`, '-m', `Merge pull request #${pr++} from dev/feat-x${c}`);
  }
}
// gitignored generated code inside a part folder (should not be analysed)
fs.mkdirSync(path.join(dir, 'src/p3/generated'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src/p3/generated/api.ts'), "import { v } from '@/p0/m0/f0';\nexport const g = v;\n");
console.log('files', files.length, 'commits', git('rev-list', '--count', 'HEAD').toString().trim());
