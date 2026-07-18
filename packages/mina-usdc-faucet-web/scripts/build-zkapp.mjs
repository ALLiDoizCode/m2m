// Precompile the vendored o1js contract classes to plain ESM with tsc.
//
// WHY (see tsconfig.zkapp.json): o1js's `@method`/`@state` decorators work with
// tsc's decorator lowering but NOT esbuild's (Vite dev + build use esbuild),
// which throws `Cannot read properties of undefined (reading 'map')` at class
// decoration. So we transform these files with the REAL tsc into
// `src/zkapp-compiled/*.js`, and the prover worker imports THOSE — Vite then
// only sees already-lowered JS. Mirrors packages/mina-zkapp/scripts/build-esm.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'src', 'zkapp-compiled');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.zkapp.json')], {
  stdio: 'inherit',
  cwd: root,
});

// tsc (moduleResolution: bundler) leaves relative imports extensionless; add
// `.js` so the emitted ESM is valid for any ESM resolver, then Vite bundles it.
for (const file of readdirSync(outDir)) {
  if (!file.endsWith('.js')) continue;
  const p = join(outDir, file);
  const patched = readFileSync(p, 'utf8').replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (m, pre, spec, post) => (/\.[mc]?js$/.test(spec) ? m : `${pre}${spec}.js${post}`)
  );
  writeFileSync(p, patched);
}
console.log('zkapp contracts compiled -> src/zkapp-compiled/');
