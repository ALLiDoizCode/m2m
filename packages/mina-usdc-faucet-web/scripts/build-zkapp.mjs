// Precompile the vendored o1js contract classes to plain ESM with tsc.
//
// WHY (see tsconfig.zkapp.json): o1js's `@method`/`@state` decorators work with
// tsc's decorator lowering but NOT esbuild's (Vite dev + build use esbuild),
// which throws `Cannot read properties of undefined (reading 'map')` at class
// decoration. So we transform these files with the REAL tsc into
// `src/zkapp-compiled/*.js`, and the prover worker imports THOSE — Vite then
// only sees already-lowered JS. Mirrors packages/mina-zkapp/scripts/build-esm.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'src', 'zkapp-compiled');

// Resolve the REAL tsc binary. In a hoisted npm workspace install `typescript`
// lives in the REPO-ROOT node_modules, not this package's — the package-local
// path only exists on a non-hoisted install. Prefer the local copy, else fall
// back to the workspace root; picking the first that exists keeps `npm run build`
// (root build → this prebuild) working in CI/release, which is where the
// hardcoded local-only path failed (release pipeline blocked at 3.35.0). Mirrors
// the same fallback in packages/mina-zkapp/scripts/build-esm.mjs.
const tsc =
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  ].find((p) => existsSync(p)) || join(root, 'node_modules', 'typescript', 'bin', 'tsc');

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
