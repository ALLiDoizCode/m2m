// Build the USDC token classes to RUNTIME ESM for the faucet's mint path.
//
// Why a custom ESM build (and not the existing `dist/` or `npm run build`):
//   * `tsc` (the package's default `build`) emits `"module": "commonjs"` into
//     `dist/`. o1js is a DUAL package (ESM `dist/node/index.js` vs CJS
//     `dist/node/index.cjs`): a CJS require and an ESM import resolve to
//     DIFFERENT module instances. The faucet mint path MUST keep o1js as a
//     SINGLE instance (the o1js circuit cache + `FungibleToken` provers are
//     per-instance state) — so the faucet (ESM) importing the CJS `dist/` would
//     double-load o1js and break proving (the documented ts-node ESM/CJS split).
//   * So we emit a parallel ESM build (`dist-esm/`) the ESM faucet can import,
//     keeping exactly ONE o1js instance across the whole process.
//
// `tsc` with `moduleResolution: bundler` leaves the ONE relative import
// (`./constants`) extensionless, which Node ESM won't resolve, and emits no
// `package.json`, so Node warns the dir is "typeless". This script fixes both:
//   1. rewrite `from './constants'` → `from './constants.js'`
//   2. drop a `dist-esm/package.json` with `{ "type": "module" }`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const outDir = join(pkgRoot, 'dist-esm');

// Run the LOCALLY-installed TypeScript compiler directly. Do NOT use `npx tsc`:
// npx resolves the *package* named `tsc` (a deprecated stub on the registry),
// not the `tsc` *binary* that ships inside the `typescript` package, so on a
// clean install (no `tsc` package present) `npx tsc` downloads `tsc@2.0.4` and
// fails ("This is not the tsc command you are looking for"). Resolve the real
// compiler entrypoint from the installed `typescript` package and run it with
// node — works regardless of whether node_modules/.bin is on PATH.
const tscBin = ['packages/mina-zkapp/node_modules/typescript/bin/tsc', 'node_modules/typescript/bin/tsc']
  .map((rel) => join(pkgRoot, '..', '..', rel))
  .find((p) => existsSync(p))
  || join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tscBin, '-p', join(pkgRoot, 'tsconfig.esm.json')], {
  stdio: 'inherit',
  cwd: pkgRoot,
});

// Add `.js` to relative (./ or ../) extensionless import/export specifiers.
for (const file of readdirSync(outDir)) {
  if (!file.endsWith('.js')) continue;
  const p = join(outDir, file);
  const patched = readFileSync(p, 'utf8').replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (m, pre, spec, post) => (/\.[mc]?js$/.test(spec) ? m : `${pre}${spec}.js${post}`)
  );
  writeFileSync(p, patched);
}

writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log('mina-zkapp ESM build -> dist-esm/ (type:module, extensions patched)');
