/**
 * Acceptance Tests for Story 36.2: anyone-client SDK CLI Flag Audit
 *
 * These tests validate the docs-drift bright-line for Epic 36 Story 36.2:
 *   - No "consult docs.anyone.io / do not guess" hedges in docs/ator-transport.md
 *   - Committed --help snapshots for anyone-proxy + anyone-client under docs/ator-transport/
 *   - A grep-able provenance line tying the doc's flag surface to a resolved SDK version
 *   - Each flag row annotated with its consumer story ([story 35.5] / [story 36.2] / [operator-only])
 *   - Option B cross-reference pointing back to Option A.2's flag table
 *   - No connector source / infra changes (scope bright-line)
 *
 * RED PHASE NOTE: All assertions below are authored against state that does
 * NOT YET EXIST (edits to docs/ator-transport.md, new docs/ator-transport/
 * snapshot files, new integration test file, CHANGELOG entry). Every
 * `describe` block will FAIL until Story 36.2 implementation lands. These
 * tests are pure static assertions against text files — no child processes,
 * no docker, no network are invoked here (the snapshot-diff gate that DOES
 * spawn a CLI lives separately in
 * packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts).
 *
 * Acceptance Criteria Covered:
 * - AC 1: Zero hedge-phrase matches in the deployment guide
 * - AC 2: Zero "do not guess" matches in the deployment guide
 * - AC 3: Option A.2 pins verified CLI flags with provenance
 * - AC 4: Provenance line is machine-checkable (regex + resolved version)
 * - AC 5: --help snapshots committed with provenance header
 * - AC 6 (partial): Integration test file EXISTS at the expected path and
 *         contains the canary regeneration-hint substring. The actual
 *         spawn-and-diff behavior is exercised by the integration suite
 *         itself, not here — this acceptance test only asserts the file is
 *         present and shaped correctly (the R-14 skip guard string is also
 *         grep-checked here so that a dev who deletes the skip path breaks
 *         this acceptance test even before the integration test runs).
 * - AC 7: Each flag annotated with its consumer story
 * - AC 8: Option B cross-references the audit
 * - AC 9 (partial): No files changed under packages/connector/src/ (static
 *         presence check — the full git-diff scope audit remains a dev-run
 *         verification per Task 7.5; jest has no authoritative access to
 *         the story-start SHA without conflating with prior-story commits
 *         in the same branch).
 *
 * Excluded (verified by other artifacts):
 * - AC 6 snapshot-diff runtime behavior       → integration test spawns CLI
 * - AC 9 git-log file-list check              → shell-level, Task 7.5
 * - AC 10 operator-verbatim command smoke     → shell-level, Task 7.6
 *
 * @module test/acceptance/story-36-2
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOCS_FILE = path.join(PROJECT_ROOT, 'docs', 'ator-transport.md');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'docs', 'ator-transport');
const PROXY_SNAPSHOT = path.join(SNAPSHOT_DIR, 'anyone-proxy-help.txt');
const CLIENT_SNAPSHOT = path.join(SNAPSHOT_DIR, 'anyone-client-help.txt');
const INTEGRATION_TEST = path.join(
  PROJECT_ROOT,
  'packages',
  'connector',
  'test',
  'integration',
  'story-36-2-anon-cli-snapshot.test.ts'
);
const CHANGELOG = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const CONNECTOR_SRC_DIR = path.join(PROJECT_ROOT, 'packages', 'connector', 'src');

// The resolved SDK version from the repo's pinned dependency. The provenance
// line in the doc MUST equal this string. We read it at test time so that a
// future SDK bump that refreshes package-lock.json also forces the doc
// refresh (or else this test fails on the unchanged doc).
//
// If the optional dep is not installed on this platform (R-14), fall back to
// a string that will not match the regex — forcing the dev who authored the
// provenance line to verify they ran this on a machine that can install the
// SDK. We deliberately do NOT silently skip the whole AC 4 check.
function getResolvedSdkVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@anyone-protocol/anyone-client/package.json').version as string;
  } catch {
    return '__SDK_NOT_INSTALLED__';
  }
}

// ---------------------------------------------------------------------------
// Lazy file readers (so test discovery does not fail when files are absent)
// ---------------------------------------------------------------------------

function readDocs(): string {
  return fs.readFileSync(DOCS_FILE, 'utf8');
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AC 1: No hedge-phrase matches (consult docs.anyone.io / docs.anyone.io for
//       current/flag/CLI)
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 1: docs/ator-transport.md — zero hedge-phrase matches', () => {
  it('contains no "consult docs.anyone.io" / "docs.anyone.io for current|flag|CLI" hedge', () => {
    const contents = readDocs();
    // Regex matches the hedge pattern the AC names AND the real hedge shape
    // that currently exists on line 68 of the pre-story doc.
    const hedgeRe =
      /consult[^\n]*docs\.anyone\.io|docs\.anyone\.io[^\n]*for[^\n]*(current|current CLI|flag)/gi;
    const matches = contents.match(hedgeRe) ?? [];
    expect(matches).toEqual([]);
  });

  it('still contains at least one plain link to https://docs.anyone.io (background reference)', () => {
    const contents = readDocs();
    // The ban is on the HEDGE pattern, not on linking to upstream. AC 1
    // specifies the file must still contain an upstream link.
    expect(contents).toMatch(/https:\/\/docs\.anyone\.io/);
  });
});

// ---------------------------------------------------------------------------
// AC 2: Zero "do not guess" matches
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 2: docs/ator-transport.md — zero "do not guess" matches', () => {
  it('contains no occurrences of the literal phrase "do not guess"', () => {
    const contents = readDocs();
    const matches = contents.match(/do not guess/g) ?? [];
    expect(matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC 3: Option A.2 section pins verified CLI flags
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 3: Option A.2 documents both CLIs and the key flag surface', () => {
  it('mentions both `anyone-proxy` and `anyone-client` binaries in the Option A.2 section', () => {
    const contents = readDocs();
    // Constrain to Option A.2 section (between "Option A.2" header and the
    // next "### Option" boundary or "**With system tor" sibling block).
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    expect(sectionMatch).not.toBeNull();
    const section = sectionMatch?.[0] ?? '';
    expect(section).toMatch(/anyone-proxy/);
    expect(section).toMatch(/anyone-client/);
  });

  it('disambiguates which CLI an operator should pick (prose, not just a list)', () => {
    const contents = readDocs();
    // Heuristic: after this story lands, the Option A.2 section MUST contain
    // a sentence comparing the two CLIs (daemon vs orchestrator). We check
    // for both "daemon" / "proxy" language and "orchestrator" / "process"
    // language in proximity to the binary names.
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    const section = sectionMatch?.[0] ?? '';
    // Either "SOCKS" appears (the daemon purpose of anyone-proxy) and some
    // "orchestrat" / "process" descriptor appears (the purpose of
    // anyone-client). Phrasing flexibility is intentional — we are not
    // prescribing exact prose.
    expect(section).toMatch(/SOCKS/i);
    expect(section).toMatch(/orchestrat|process/i);
  });

  it('lists at minimum the SOCKS-port, control-port, data-dir, and log-level flags', () => {
    const contents = readDocs();
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    const section = sectionMatch?.[0] ?? '';
    // Exact flag spellings come from the --help capture. These checks are
    // lowercase-tolerant substring checks. If the SDK's flag is hyphenated
    // differently than expected, update both the doc and this test in the
    // same PR — do NOT loosen the assertion to "any port-like token".
    expect(section.toLowerCase()).toMatch(/socks[- ]?port/);
    expect(section.toLowerCase()).toMatch(/control[- ]?port/);
    expect(section.toLowerCase()).toMatch(/data[- ]?dir/);
    expect(section.toLowerCase()).toMatch(/log[- ]?level/);
  });

  it('links to the committed --help snapshot for anyone-proxy', () => {
    const contents = readDocs();
    expect(contents).toMatch(/docs\/ator-transport\/anyone-proxy-help\.txt/);
  });
});

// ---------------------------------------------------------------------------
// AC 4: Machine-checkable provenance line
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 4: provenance line is grep-able and tied to the resolved SDK version', () => {
  const PROVENANCE_RE =
    /Flag surface verified against @anyone-protocol\/anyone-client@(\d+\.\d+\.\d+) on (\d{4}-\d{2}-\d{2})/g;

  it('contains exactly one provenance line matching the canonical regex', () => {
    const contents = readDocs();
    const matches = [...contents.matchAll(PROVENANCE_RE)];
    expect(matches).toHaveLength(1);
  });

  it('carries a concrete date (not a YYYY-MM-DD placeholder) on or before today', () => {
    const contents = readDocs();
    const match = PROVENANCE_RE.exec(contents);
    // Reset regex state from the `global` flag before re-using
    PROVENANCE_RE.lastIndex = 0;
    expect(match).not.toBeNull();
    const dateStr = match![2];
    expect(dateStr).not.toBe('YYYY-MM-DD');
    // Audit must be in the past or today. A future-dated line is a smell.
    const auditDate = new Date(dateStr + 'T00:00:00Z').getTime();
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    expect(auditDate).toBeLessThanOrEqual(today);
  });

  it('pins the same SDK version that the monorepo currently resolves', () => {
    const contents = readDocs();
    const match = PROVENANCE_RE.exec(contents);
    PROVENANCE_RE.lastIndex = 0;
    expect(match).not.toBeNull();
    const pinnedVersion = match![1];
    const resolvedVersion = getResolvedSdkVersion();
    // If the optional dep is not installed, surface a descriptive failure
    // instead of a silent pass. Dev reruns on a supported platform.
    expect(resolvedVersion).not.toBe('__SDK_NOT_INSTALLED__');
    expect(pinnedVersion).toBe(resolvedVersion);
  });
});

// ---------------------------------------------------------------------------
// AC 5: --help snapshots committed under docs/ator-transport/
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 5: --help snapshots committed with provenance header', () => {
  it('docs/ator-transport/anyone-proxy-help.txt exists', () => {
    expect(fs.existsSync(PROXY_SNAPSHOT)).toBe(true);
  });

  it('docs/ator-transport/anyone-client-help.txt exists', () => {
    expect(fs.existsSync(CLIENT_SNAPSHOT)).toBe(true);
  });

  it('anyone-proxy snapshot first non-blank line starts with the canonical provenance header', () => {
    const body = readIfExists(PROXY_SNAPSHOT) ?? '';
    const firstNonBlank = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    expect(firstNonBlank).toMatch(
      /^# Flag surface captured from @anyone-protocol\/anyone-client@\d+\.\d+\.\d+ on \d{4}-\d{2}-\d{2}\b/
    );
  });

  it('anyone-client snapshot first non-blank line starts with the canonical provenance header', () => {
    const body = readIfExists(CLIENT_SNAPSHOT) ?? '';
    const firstNonBlank = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    expect(firstNonBlank).toMatch(
      /^# Flag surface captured from @anyone-protocol\/anyone-client@\d+\.\d+\.\d+ on \d{4}-\d{2}-\d{2}\b/
    );
  });

  it('snapshots end with a trailing newline (LF) per repo convention', () => {
    const proxy = readIfExists(PROXY_SNAPSHOT) ?? '';
    const client = readIfExists(CLIENT_SNAPSHOT) ?? '';
    expect(proxy.endsWith('\n')).toBe(true);
    expect(client.endsWith('\n')).toBe(true);
  });

  it('snapshots contain no absolute paths from the monorepo (Task 2.4 normalization)', () => {
    const proxy = readIfExists(PROXY_SNAPSHOT) ?? '';
    const client = readIfExists(CLIENT_SNAPSHOT) ?? '';
    // Guard against /Users/..., /home/runner/..., and similar. <HOME> is the
    // accepted sentinel per Task 2.4.
    const absRe = /\/(Users|home\/runner|root|builds)\//;
    expect(proxy).not.toMatch(absRe);
    expect(client).not.toMatch(absRe);
  });

  it('snapshots contain no ANSI escape sequences (Task 2.4 normalization)', () => {
    const proxy = readIfExists(PROXY_SNAPSHOT) ?? '';
    const client = readIfExists(CLIENT_SNAPSHOT) ?? '';
    // Matches the CSI introducer literally; any SGR leftover trips this.
    // eslint-disable-next-line no-control-regex
    const ansiRe = /\x1b\[[0-9;]*m/;
    expect(proxy).not.toMatch(ansiRe);
    expect(client).not.toMatch(ansiRe);
  });
});

// ---------------------------------------------------------------------------
// AC 6 (partial): Integration test file exists & carries canary hint
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 6 (partial): snapshot-diff integration test authored', () => {
  it('packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts exists', () => {
    expect(fs.existsSync(INTEGRATION_TEST)).toBe(true);
  });

  it('integration test contains the Task 3.4 canary regeneration-hint substring', () => {
    const body = readIfExists(INTEGRATION_TEST) ?? '';
    // AC 6 requires this literal substring in the test source so that a dev
    // who weakens the hint to a bare `>` redirect breaks this gate.
    expect(body).toContain('Regenerate with: NO_COLOR=1');
  });

  it('integration test implements a conditional-skip branch when the optional dep is missing (R-14)', () => {
    const body = readIfExists(INTEGRATION_TEST) ?? '';
    // Canary: the file must mention BOTH the package name and a skip-style
    // token so that a dev who drops the R-14 guard trips this gate. We
    // intentionally accept multiple idioms (describe.skip, test.skip, the
    // RUN_X ternary pattern used elsewhere in the suite) so the assertion
    // does not over-prescribe implementation.
    expect(body).toMatch(/@anyone-protocol\/anyone-client/);
    expect(body).toMatch(/\.skip|describe\.skip|test\.skip/);
  });
});

// ---------------------------------------------------------------------------
// AC 7: Each flag annotated with the story that introduced its consumer
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 7: flag-row annotations name consumer story', () => {
  it('Option A.2 references the [story 35.5] annotation at least once', () => {
    const contents = readDocs();
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    const section = sectionMatch?.[0] ?? '';
    expect(section).toContain('[story 35.5]');
  });

  it('Option A.2 references the [story 36.2] annotation at least once', () => {
    const contents = readDocs();
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    const section = sectionMatch?.[0] ?? '';
    expect(section).toContain('[story 36.2]');
  });

  it('Option A.2 references the [operator-only] annotation at least once', () => {
    const contents = readDocs();
    const sectionMatch = contents.match(
      /Option A\.2[\s\S]*?(?=(?:###?\s*Option\b|\*\*With system tor\b|##\s))/i
    );
    const section = sectionMatch?.[0] ?? '';
    expect(section).toContain('[operator-only]');
  });

  it('each of the managed-client-consumed flags (socksPort, binaryPath, configFilePath, hiddenServiceDir, hiddenServicePort) is mentioned', () => {
    const contents = readDocs();
    // Names are the SDK's programmatic-option names; the --help flag
    // spellings may hyphenate differently but the doc must SOMEWHERE tie
    // those programmatic names back to the CLI surface per AC 7's intent.
    const managedOptions = [
      'socksPort',
      'binaryPath',
      'configFilePath',
      'hiddenServiceDir',
      'hiddenServicePort',
    ];
    for (const opt of managedOptions) {
      expect(contents).toContain(opt);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 8: Option B cross-references the audit
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 8: Option B section cross-references the audit', () => {
  it('contains an Option B section', () => {
    const contents = readDocs();
    expect(contents).toMatch(/Option B\b/);
  });

  it('Option B section names the audit date so freshness is visible at a glance', () => {
    const contents = readDocs();
    const optBMatch = contents.match(/Option B[\s\S]*?(?=(?:###?\s*Option\b|##\s|$(?![\s\S])))/i);
    expect(optBMatch).not.toBeNull();
    const section = optBMatch?.[0] ?? '';
    // The exact date is the one on the provenance line. Extract it and
    // assert Option B mentions it.
    const provRe =
      /Flag surface verified against @anyone-protocol\/anyone-client@\d+\.\d+\.\d+ on (\d{4}-\d{2}-\d{2})/;
    const provMatch = contents.match(provRe);
    expect(provMatch).not.toBeNull();
    const auditDate = provMatch![1];
    expect(section).toContain(auditDate);
  });

  it('Option B section directs readers to Option A.2 for the flag table', () => {
    const contents = readDocs();
    const optBMatch = contents.match(/Option B[\s\S]*?(?=(?:###?\s*Option\b|##\s|$(?![\s\S])))/i);
    const section = optBMatch?.[0] ?? '';
    expect(section).toMatch(/Option A\.2/);
  });
});

// ---------------------------------------------------------------------------
// AC 9 (partial): No connector source code changes in this story's diff
// ---------------------------------------------------------------------------

describe('Story 36.2 / AC 9 (static portion): no new source files under packages/connector/src', () => {
  it('CHANGELOG.md mentions the 36-2 audit entry (story-level tracer)', () => {
    const body = readIfExists(CHANGELOG) ?? '';
    // A one-line entry per Task 6.1 — intentionally loose on category tag
    // (### Documentation or ### Added both acceptable).
    expect(body).toMatch(/36-?2/i);
    expect(body.toLowerCase()).toMatch(/anyone-client|flag surface|anon cli|cli flag/);
  });

  it('no file under packages/connector/src/ was authored as part of this story (tripwire)', () => {
    // We cannot run `git log` from inside jest against a story-start SHA
    // without knowing that SHA at test time (it is in the story body, not
    // the repo). Instead, we encode the bright-line as a tripwire: if a
    // file under packages/connector/src/ carries a "Story 36.2" tag in its
    // header comment, that is evidence of an illicit source-code change
    // and this test fails.
    //
    // This is an asymmetric guard — it catches the most common accidental
    // violation (copy-pasting a story banner into a new source file) and
    // complements (does not replace) the shell-level git-log check in
    // Task 7.5.
    function walk(dir: string, acc: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // Defensive: reject dirents whose name contains path separators or
        // traversal segments. readdirSync returns basenames on all supported
        // platforms, but we assert the invariant before path.join to close
        // the OWASP A01 (path traversal / CWE-22) audit finding.
        if (
          entry.name.includes('/') ||
          entry.name.includes('\\') ||
          entry.name === '..' ||
          entry.name === '.'
        ) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__mocks__')
            continue;
          walk(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          acc.push(full);
        }
      }
      return acc;
    }
    const sourceFiles = fs.existsSync(CONNECTOR_SRC_DIR) ? walk(CONNECTOR_SRC_DIR) : [];
    const violators: string[] = [];
    for (const f of sourceFiles) {
      const head = fs.readFileSync(f, 'utf8').slice(0, 4096);
      if (/Story\s+36\.2\b/i.test(head)) {
        violators.push(path.relative(PROJECT_ROOT, f));
      }
    }
    expect(violators).toEqual([]);
  });
});
