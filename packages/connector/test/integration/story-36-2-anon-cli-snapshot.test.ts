/**
 * Integration snapshot-diff gate for Story 36.2:
 * anyone-client SDK CLI Flag Audit.
 *
 * Runs the SDK's two CLIs (`anyone-proxy` and `anyone-client`) with `--help`
 * against the binary the monorepo actually installs, normalizes the output,
 * and diffs it against the committed snapshots at
 * `docs/ator-transport/<cli>-help.txt`. A mismatch means the SDK's flag
 * surface drifted silently — the test fails with a regeneration recipe
 * pointing at the Task 2.4 normalization steps (NOT a bare `>` redirect,
 * which would lose the normalization signal and re-trigger the diff on the
 * next run).
 *
 * RED PHASE NOTE: This file is authored before the snapshots it diffs
 * against exist. The expected initial failure mode when `npm run
 * test:integration` picks this up on a freshly-checked-out branch is:
 *
 *   1. `require.resolve('@anyone-protocol/anyone-client')` succeeds (the
 *      optional dep DOES install on macOS/Linux/Windows x64/arm64 per the
 *      SDK's bin matrix), so `describe.skip` does NOT fire, and
 *   2. `loadCommittedSnapshot()` throws ENOENT on the missing snapshot
 *      file, surfacing a test failure whose message includes the
 *      regeneration recipe.
 *
 * When the optional dep is NOT installed on the current platform (R-14),
 * the outer `describe.skip` fires and the suite reports "2 skipped" — the
 * skip branch is intentionally explicit (not a silent pass) per
 * test-design-epic-36 §4.
 *
 * Acceptance Criteria Covered:
 *   - AC 5: Snapshots exist with provenance header (indirectly — we strip it)
 *   - AC 6: Diff gate asserts flag surface hasn't drifted silently
 *
 * @module test/integration/story-36-2-anon-cli-snapshot
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'docs', 'ator-transport');

type AnonCli = 'anyone-proxy' | 'anyone-client';

// Allowlist of CLI names this test is permitted to spawn. Although `AnonCli`
// is a closed TS union (compile-time guard), we also enforce the invariant at
// runtime before any path.join / spawnSync call — defensive-coding hygiene per
// OWASP A01 (Broken Access Control / path traversal) and A03 (Injection /
// CWE-78). Semgrep's command-injection and path-traversal audit rules both
// key off "unvalidated function argument flows into child_process / path API";
// this allowlist is the validation they look for.
const ALLOWED_CLIS: ReadonlyArray<AnonCli> = ['anyone-proxy', 'anyone-client'];
function assertAllowedCli(cli: string): asserts cli is AnonCli {
  if (!ALLOWED_CLIS.includes(cli as AnonCli)) {
    throw new Error(`Refusing to spawn unknown CLI: ${JSON.stringify(cli)}`);
  }
}

// ---------------------------------------------------------------------------
// Optional-dependency capability probe (R-14)
// ---------------------------------------------------------------------------

// `@anyone-protocol/anyone-client` is listed under `optionalDependencies` in
// packages/connector/package.json because the SDK's postinstall script
// downloads a platform-specific `anon` binary; on platforms outside the SDK's
// bin/{android,darwin,ios,linux,win32}/ matrix, `npm install` silently skips
// it. In that case, this suite has nothing to test and MUST skip explicitly
// — not silently pass, not error out in a way CI treats as infra failure.
function sdkIsInstalled(): boolean {
  try {
    require.resolve('@anyone-protocol/anyone-client/package.json');
    return true;
  } catch {
    return false;
  }
}

const SDK_AVAILABLE = sdkIsInstalled();
const describeIfSdk = SDK_AVAILABLE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Regeneration-hint literal (Task 3.4 / AC 6 canary)
// ---------------------------------------------------------------------------
//
// The literal substring `Regenerate with: NO_COLOR=1` MUST appear in this
// file — Story 36.2 AC 6 grep-gates on it to catch a dev who weakens the
// hint to a bare `>` redirect. The two constants below are the full
// per-CLI messages the test emits on diff failure.

const REGEN_HINT_PROXY =
  'Regenerate with: NO_COLOR=1 npx anyone-proxy --help 2>&1 > docs/ator-transport/anyone-proxy-help.txt.raw; ' +
  'then apply Task 2.4 normalization (strip absolute paths, escapes, timestamps); ' +
  "then prepend '# Flag surface captured from @anyone-protocol/anyone-client@<VERSION> on <ISO-DATE>' and a blank line.";

const REGEN_HINT_CLIENT =
  'Regenerate with: NO_COLOR=1 npx anyone-client --help 2>&1 > docs/ator-transport/anyone-client-help.txt.raw; ' +
  'then apply Task 2.4 normalization (strip absolute paths, escapes, timestamps); ' +
  "then prepend '# Flag surface captured from @anyone-protocol/anyone-client@<VERSION> on <ISO-DATE>' and a blank line.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the `node_modules/.bin/<cli>` shim by
 * walking up from the SDK's installed package.json. npm workspace hoisting
 * may place the dep at the monorepo root OR at the workspace — do NOT
 * hardcode `node_modules/...`.
 */
function resolveCliPath(cli: AnonCli): string {
  assertAllowedCli(cli);
  const pkgJsonPath = require.resolve('@anyone-protocol/anyone-client/package.json');
  // pkgJsonPath = <some-root>/node_modules/@anyone-protocol/anyone-client/package.json
  const nodeModulesRoot = path.resolve(pkgJsonPath, '..', '..', '..', '..');
  const binPath = path.join(nodeModulesRoot, 'node_modules', '.bin', cli);
  return binPath;
}

/**
 * Invoke `<cli> --help`, combining stdout + stderr, with NO_COLOR=1 and a
 * 10s timeout to avoid a hung test. Runs SYNCHRONOUSLY inside the jest
 * worker — no child-process leaks, no orphan processes at suite exit.
 *
 * NOTE ON FIELD EXPERIENCE (Task 1.3 capture, 2026-04-15):
 * At story-authoring time, the pinned SDK build at @anyone-protocol/anyone-client@1.1.3
 * did NOT accept `--help` on either CLI:
 *   - `anyone-proxy --help` is intercepted by proxychains before the SDK sees it:
 *       "proxychains: can't load process '--help'"
 *   - `anyone-client --help` throws from node:util.parseArgs:
 *       "ERR_PARSE_ARGS_UNKNOWN_OPTION: Unknown option '--help'"
 *
 * The audit's documentation path therefore captures WHATEVER these
 * invocations print (stdout + stderr + exit code), byte-for-byte, as the
 * ground-truth flag surface. The test diffs the committed capture against
 * the live capture; a future SDK that DOES add `--help` support will land
 * as a snapshot-diff failure, forcing a re-audit (which is the whole point).
 */
function runHelp(cli: AnonCli): { combined: string; exitCode: number | null } {
  assertAllowedCli(cli);
  const binPath = resolveCliPath(cli);
  const res = spawnSync(binPath, ['--help'], {
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return {
    combined: stdout + stderr,
    exitCode: res.status,
  };
}

/**
 * Read the committed snapshot and strip the provenance header block
 * (first non-blank line that begins with `# Flag surface captured ...`, up
 * to and including the following blank line).
 */
function loadCommittedSnapshot(cli: AnonCli): string {
  assertAllowedCli(cli);
  const snapPath = path.join(SNAPSHOT_DIR, `${cli}-help.txt`);
  const raw = fs.readFileSync(snapPath, 'utf8');
  const lines = raw.split('\n');
  // Find first non-blank line
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length > 0) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return raw; // all-blank snapshot — let diff fail downstream
  const headerLine = lines[headerIdx] ?? '';
  // Require the header shape so that a missing header trips this test (AC 5)
  if (!/^# Flag surface captured from @anyone-protocol\/anyone-client@/.test(headerLine)) {
    throw new Error(
      `Snapshot ${snapPath} missing canonical provenance header '# Flag surface captured from @anyone-protocol/anyone-client@<VERSION> on <ISO-DATE>'`
    );
  }
  // Drop everything up to and including the next blank line after the header
  let startIdx = headerIdx + 1;
  while (startIdx < lines.length && (lines[startIdx] ?? '').trim().length !== 0) startIdx++;
  if (startIdx < lines.length) startIdx++; // consume the blank separator line
  return lines.slice(startIdx).join('\n');
}

/**
 * Normalize both live and committed streams to absorb OS / tty / encoding
 * noise without masking a real flag-surface change:
 *   - CRLF -> LF
 *   - trim trailing whitespace per line
 *   - drop leading / trailing blank lines
 * Any normalization beyond this (e.g. stripping ANSI, replacing abs paths)
 * SHOULD already have been applied to the committed snapshot at capture
 * time per Task 2.4 — we normalize the LIVE side the same way so ANSI-leak
 * from a new SDK release surfaces as a diff, not as a silent noop.
 */
function normalize(s: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiStripped = s.replace(/\x1b\[[0-9;]*m/g, '');
  const lfOnly = ansiStripped.replace(/\r\n/g, '\n');

  // Task 2.4 canonicalization: collapse volatile tokens on the LIVE side so
  // the diff only trips on true flag-surface drift (not on a line number
  // moving after a minor Node / SDK patch). Apply in order; each regex is
  // anchored to a distinctive token so a real message containing e.g. the
  // word "VERSION" doesn't get clobbered.
  //
  //   - Node core frame paths   (node:foo/bar:123:45 -> node:foo/bar:<LINE>:<COL>)
  //   - Node core frame tails   (node:foo/bar:123    -> node:foo/bar:<LINE>)
  //   - Absolute repo paths     (/Users/.../connector -> <REPO>)
  //   - Tempdir paths           (/tmp/anon-proxy-1234 -> <TMPDIR>/anon-proxy-<TIMESTAMP>)
  //   - Platform / arch in SDK  (bin/darwin/arm64/... -> bin/<PLATFORM>/<ARCH>/...)
  //   - proxychains lib suffix  (.dylib|.so|.dll     -> .<EXT>)
  //   - Node.js version line    (Node.js vX.Y.Z      -> Node.js v<VERSION>)
  //   - Inline frame file paths (at Object.<anonymous> (/abs/path:L:C) -> (<REPO>/...:<LINE>:<COL>))
  const canonical = lfOnly
    // Node core frames with col: node:internal/foo/bar:12:34
    .replace(/(node:[A-Za-z0-9_./-]+):\d+:\d+/g, '$1:<LINE>:<COL>')
    // Node core frames without col: node:internal/foo/bar:12
    .replace(/(node:[A-Za-z0-9_./-]+):\d+\b/g, '$1:<LINE>')
    // tmp proxychains config path with trailing timestamp/token
    .replace(
      /\/(?:tmp|var\/folders|private\/var\/folders)\/[^\s]*anon-proxy-[A-Za-z0-9._-]+/g,
      '<TMPDIR>/anon-proxy-<TIMESTAMP>'
    )
    // SDK bundled-bin platform/arch path segment
    .replace(
      /bin\/(android|darwin|ios|linux|win32)\/(x64|arm64|arm|ia32)\//g,
      'bin/<PLATFORM>/<ARCH>/'
    )
    // proxychains shared-library extension
    .replace(/libproxychains4\.(dylib|so|dll)/g, 'libproxychains4.<EXT>')
    // Node.js vX.Y.Z marker
    .replace(/Node\.js v\d+\.\d+\.\d+/g, 'Node.js v<VERSION>')
    // Node.js FORCE_COLOR warning (transient env issue, not part of CLI surface)
    .replace(
      /\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\n/g,
      ''
    )
    .replace(/\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, '')
    // Absolute monorepo root in stack frames: anything up to /node_modules/
    .replace(/\/[A-Za-z0-9_./ -]+?\/node_modules\//g, '<REPO>/node_modules/')
    // Relative traversal to node_modules (e.g. ../../node_modules/...) also canonicalize
    .replace(/(?:\.\.\/)+node_modules\//g, '<REPO>/node_modules/')
    // Normalize stack trace indentation: Node.js 22+ uses 6-space indent for
    // first frame and 8-space for subsequent frames; earlier versions use 2-space.
    // Normalize ALL stack trace indentation to 2 spaces. Node.js 22+ uses
    // 6/8 spaces, earlier versions use 2 spaces, some have 0 spaces. Apply
    // generic pattern first, then explicit patterns for known Node 22 formats.
    .replace(/^ +at /gm, '  at ') // Generic: any spaces -> 2 spaces
    .replace(/^ {6}at /gm, '  at ') // Explicit: 6 spaces -> 2 spaces (Node 22 first frame)
    .replace(/^ {8}at /gm, '  at ') // Explicit: 8 spaces -> 2 spaces (Node 22 subsequent)
    // Strip Node.js version-specific diagnostic frames that appear in one version
    // but not another. These lines carry no semantic signal for flag-surface audit.
    .replace(/^ +at TracingChannel\.traceSync.*$/gm, '') // Node 22 diagnostic channel
    .replace(/^ +at Function\.executeUserEntryPoint.*$/gm, '') // Node 20 entry point
    // Any remaining user-home prefix that survived
    .replace(/\/(Users|home|root|builds)\/[^/\s)]+/g, '<HOME>');

  const trimmed = canonical
    .split('\n')
    .map((l) => l.replace(/\s+$/g, ''))
    .join('\n');
  // Drop all blank lines. proxychains flushes its preload/config messages
  // piecewise across stdout and stderr; spawnSync concatenates them in
  // nondeterministic order with nondeterministic blank-line padding between
  // segments (each segment may or may not end with its own \n, and the stderr
  // frames may arrive either before, after, or interleaved with the stdout
  // frames). Removing blank lines entirely on BOTH the live side and the
  // committed snapshot side yields a stable diff without masking real
  // flag-surface drift: a new flag is still a new non-blank line, and a
  // removed flag is still a missing non-blank line. Blank lines themselves
  // carry no semantic signal in the CLI help/error surface we're gating on.
  const nonBlank = trimmed
    .split('\n')
    .filter((l) => l.length > 0)
    .join('\n');
  return nonBlank.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfSdk('Story 36.2 — anyone-client SDK CLI flag-surface snapshot gate', () => {
  jest.setTimeout(30_000);

  it('anyone-proxy --help output matches the committed snapshot', () => {
    const { combined } = runHelp('anyone-proxy');
    const liveNorm = normalize(combined);
    const snapNorm = normalize(loadCommittedSnapshot('anyone-proxy'));
    if (liveNorm !== snapNorm) {
      throw new Error(
        `anyone-proxy --help output drifted from committed snapshot.\n` +
          `${REGEN_HINT_PROXY}\n\n` +
          `--- expected (committed) ---\n${snapNorm}\n\n` +
          `--- actual (live) ---\n${liveNorm}\n`
      );
    }
    expect(liveNorm).toBe(snapNorm);
  });

  it('anyone-client --help output matches the committed snapshot', () => {
    const { combined } = runHelp('anyone-client');
    const liveNorm = normalize(combined);
    const snapNorm = normalize(loadCommittedSnapshot('anyone-client'));
    if (liveNorm !== snapNorm) {
      throw new Error(
        `anyone-client --help output drifted from committed snapshot.\n` +
          `${REGEN_HINT_CLIENT}\n\n` +
          `--- expected (committed) ---\n${snapNorm}\n\n` +
          `--- actual (live) ---\n${liveNorm}\n`
      );
    }
    expect(liveNorm).toBe(snapNorm);
  });
});

// When the optional dep is NOT installed, jest would otherwise report
// "0 tests" for this file — surface a single descriptive skipped test so
// the CI log shows an explicit skip reason (R-14 mitigation).
if (!SDK_AVAILABLE) {
  test.skip(
    '@anyone-protocol/anyone-client not installed — optional dependency skipped on this platform ' +
      '(install to exercise flag-surface gate)',
    () => {
      // intentionally empty
    }
  );
}
