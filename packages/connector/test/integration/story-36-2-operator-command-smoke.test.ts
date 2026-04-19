/**
 * Integration smoke gate for Story 36.2 AC 10:
 * Operator-verbatim command syntactic validity.
 *
 * AC 10 requires that every `--help`-shaped documented command in
 * docs/ator-transport.md §Option A.2 either exits 0 on `--help` OR rejects
 * an intentionally invalid flag with a usage-error exit (NOT by booting the
 * real daemon — that is Story 36.3's scope).
 *
 * The story's Task 7.6 was originally defined as a shell-level dev-run with
 * outputs recorded in Completion Notes. This file promotes that check into
 * the jest integration suite so it runs automatically on every CI leg where
 * the SDK is installed — giving AC 10 the same CI-gate treatment AC 6
 * already has, rather than leaving it as a one-shot manual verification at
 * story-completion time.
 *
 * Commands exercised (each sourced verbatim from docs/ator-transport.md
 * §Option A.2 "Example commands" block as of the 2026-04-15 audit):
 *
 *   1. anyone-proxy --help
 *        Expected per Task 1's capture: exits 0 (proxychains intercepts
 *        --help and prints a "can't load process" diagnostic). Either way,
 *        the command is syntactically valid — the SDK did not refuse to
 *        parse it.
 *
 *   2. anyone-client --help
 *        Expected per Task 1's capture: exits 1 with ERR_PARSE_ARGS_UNKNOWN_OPTION.
 *        This is the invalid-flag-rejection proof shape AC 10 explicitly
 *        permits — the CLI's parser saw the flag, rejected it with a usage
 *        error, and exited non-zero. That is sufficient proof of syntactic
 *        validity (the CLI is reachable and its argv parser is live).
 *
 *   3. anyone-client --bogus-flag
 *        Same shape as #2 — exits 1 with ERR_PARSE_ARGS_UNKNOWN_OPTION,
 *        proving the orchestrator CLI's argv parser is live and rejects
 *        unknown flags. This is the command the docs show as the
 *        "validate flag syntax without starting the daemon" recipe
 *        (line 124-125 of the deployment guide).
 *
 * Deliberately NOT invoked:
 *   - Bare `npx anyone-proxy` / `anyone-client -s ... -o ... -v` — these
 *     would start real daemons. Story 36.3's scope, not 36.2's.
 *
 * R-14 parity: mirror the snapshot test's outer `describe.skip` guard so
 * this file skips explicitly when the optional SDK dep is not installed,
 * rather than silently passing or failing in a CI-infra-flavored way.
 *
 * Acceptance Criteria Covered:
 *   - AC 10: Operator-verbatim smoke — documented commands are syntactically valid
 *
 * @module test/integration/story-36-2-operator-command-smoke
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

type AnonCli = 'anyone-proxy' | 'anyone-client';

// Allowlist of CLI names this test is permitted to spawn. Although `AnonCli`
// is a closed TS union (compile-time guard), we also enforce the invariant at
// runtime before any path.join / spawnSync call — defensive-coding hygiene per
// OWASP A01 (Broken Access Control / path traversal) and A03 (Injection /
// CWE-78). Parity with the snapshot-diff gate in the sibling file.
const ALLOWED_CLIS: ReadonlyArray<AnonCli> = ['anyone-proxy', 'anyone-client'];
function assertAllowedCli(cli: string): asserts cli is AnonCli {
  if (!ALLOWED_CLIS.includes(cli as AnonCli)) {
    throw new Error(`Refusing to spawn unknown CLI: ${JSON.stringify(cli)}`);
  }
}

// ---------------------------------------------------------------------------
// R-14 capability probe — identical shape to the snapshot test
// ---------------------------------------------------------------------------

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
// CLI resolution — same approach as the snapshot test (no hardcoded
// node_modules path so npm workspace hoisting doesn't break the probe)
// ---------------------------------------------------------------------------

function resolveCliPath(cli: AnonCli): string {
  assertAllowedCli(cli);
  const pkgJsonPath = require.resolve('@anyone-protocol/anyone-client/package.json');
  const nodeModulesRoot = path.resolve(pkgJsonPath, '..', '..', '..', '..');
  return path.join(nodeModulesRoot, 'node_modules', '.bin', cli);
}

interface InvocationResult {
  exitCode: number | null;
  combined: string;
}

/**
 * Invoke a CLI with the provided argv, combining stdout+stderr, with
 * NO_COLOR=1 and a 10s timeout so a hung test can't poison CI.
 */
function invoke(cli: AnonCli, args: string[]): InvocationResult {
  assertAllowedCli(cli);
  const res = spawnSync(resolveCliPath(cli), args, {
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    exitCode: res.status,
    combined: (res.stdout ?? '') + (res.stderr ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfSdk('Story 36.2 / AC 10 — documented operator commands are syntactically valid', () => {
  jest.setTimeout(30_000);

  it('anyone-proxy --help exits with a non-null status and prints diagnostic output (no daemon boot)', () => {
    const { exitCode, combined } = invoke('anyone-proxy', ['--help']);
    // AC 10 accepts either `--help` dry-run OR invalid-flag rejection, so
    // the assertion is "the CLI was reachable, produced output, and exited
    // with a deterministic status". A non-null exitCode is the proof that
    // the spawnSync timeout did NOT fire — i.e. the CLI did not launch a
    // daemon that stayed alive past the 10s ceiling.
    expect(exitCode).not.toBeNull();
    // Some output SHOULD land on stdout+stderr. An empty string would mean
    // the CLI silently no-op'd, which is not "syntactically valid" in AC
    // 10's sense (AC 10 names "prints usage text to stdout and/or stderr").
    expect(combined.length).toBeGreaterThan(0);
    // Pinned-SDK fingerprint: proxychains intercepts `--help` before the
    // SDK sees it and prints a "can't load process" diagnostic. If a future
    // SDK bump changes this behavior (e.g. real usage screen on exit 0, or
    // a different intercept path) the sibling snapshot-diff gate will
    // catch it. This assertion is the weak-form version for the case where
    // the combined output drifts within the same behavior class.
    const isProxychainsIntercept =
      /proxychains/i.test(combined) && /can't load process|--help/.test(combined);
    const isUsageScreen = /usage|Usage|OPTIONS|flags?/i.test(combined);
    expect(isProxychainsIntercept || isUsageScreen).toBe(true);
  });

  it('anyone-client --help exits non-zero with a usage-error message (invalid-flag rejection path)', () => {
    const { exitCode, combined } = invoke('anyone-client', ['--help']);
    // Per the 2026-04-15 capture (Dev Agent Record), the CLI uses
    // node:util.parseArgs and throws ERR_PARSE_ARGS_UNKNOWN_OPTION because
    // `--help` isn't declared in its options table. AC 10 accepts this as
    // proof of syntactic validity: the argv parser saw the flag and
    // rejected it cleanly.
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    // The error token is the unambiguous fingerprint of the parseArgs
    // rejection path. If a future SDK adds real `--help` support the
    // command will exit 0 and print usage — which is ALSO AC-10-valid, so
    // we relax the assertion to "either ERR_PARSE_ARGS_UNKNOWN_OPTION or
    // an exit-0 usage screen". This keeps the test future-proof without
    // weakening the check: the snapshot-diff gate in the sibling file
    // will catch the behavior change and force a re-audit.
    const isRejection =
      /ERR_PARSE_ARGS_UNKNOWN_OPTION|Unknown option/.test(combined) && exitCode !== 0;
    const isHelpScreen = exitCode === 0 && /usage|Usage|OPTIONS|flags?/i.test(combined);
    expect(isRejection || isHelpScreen).toBe(true);
  });

  it('anyone-client --bogus-flag rejects the unknown flag with a usage error (documented recipe)', () => {
    // This is the exact command the deployment guide shows operators in
    // the "Validate flag syntax without starting the daemon" recipe
    // (docs/ator-transport.md line 124-125 as of the 2026-04-15 audit).
    // The AC 10 bright line: this command MUST reject rather than boot a
    // daemon.
    const { exitCode, combined } = invoke('anyone-client', ['--bogus-flag']);
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(combined).toMatch(/ERR_PARSE_ARGS_UNKNOWN_OPTION|Unknown option/);
  });
});

// R-14: surface an explicit skip when the SDK optional dep is absent so
// CI logs show the skip reason rather than a zero-tests file.
if (!SDK_AVAILABLE) {
  test.skip(
    '@anyone-protocol/anyone-client not installed — optional dependency skipped on this platform ' +
      '(install to exercise AC 10 operator-command smoke gate)',
    () => {
      // intentionally empty
    }
  );
}
