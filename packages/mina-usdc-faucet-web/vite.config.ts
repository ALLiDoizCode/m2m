import { defineConfig } from 'vite';

// o1js is a WASM-backed ESM package that runs its prover in a web worker and
// (when cross-origin-isolated) multi-threads via SharedArrayBuffer.
//
//   * `optimizeDeps.exclude: ['o1js']` — never let esbuild pre-bundle o1js; its
//     wasm + worker glue break when flattened. Let Rollup handle it natively.
//   * `target: 'esnext'` — o1js uses top-level `await`; older targets fail.
//   * dev server COOP/COEP headers — enable `crossOriginIsolated` so
//     SharedArrayBuffer works locally. In PRODUCTION (GitHub Pages, which cannot
//     set response headers) the same isolation is provided by
//     `public/coi-serviceworker.js`, registered first thing in index.html.
//   * `base: './'` — emit RELATIVE asset URLs so the built site works when
//     served from a repo subpath (e.g. https://<org>.github.io/connector/).
export default defineConfig({
  base: './',
  build: {
    target: 'esnext',
    // o1js pulls in a large wasm bundle; silence the chunk-size warning noise.
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['o1js'],
    esbuildOptions: { target: 'esnext' },
  },
  esbuild: { target: 'esnext' },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
