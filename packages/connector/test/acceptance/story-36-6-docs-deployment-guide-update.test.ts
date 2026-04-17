/**
 * Acceptance Tests for Story 36.6: Documentation + Deployment-Guide Update
 *
 * These tests validate the documentation acceptance criteria for Epic 36 Story 36.6:
 *   - Zero hedge phrases remaining ("consult docs.anyone.io", "do not guess")
 *   - Verification Status section with pinned ATOR binary version and nightly CI link
 *   - Local Development Network section with 7-service topology and make targets
 *   - Prerequisites split into operational vs development sub-sections
 *   - Troubleshooting expanded with at least 3 real-binary failure modes
 *   - Platform Matrix section consistent with nightly workflow
 *   - All file paths and Makefile targets mentioned in the guide exist
 *   - Zero src/ or test/ changes (documentation-only bright line)
 *   - CHANGELOG and sprint-status updates
 *
 * RED PHASE NOTE: All assertions below are authored against state that does
 * NOT YET EXIST (new sections in docs/ator-transport.md, CHANGELOG entry,
 * sprint-status update). Every `describe` block will FAIL until Story 36.6
 * implementation lands. These tests are pure static assertions against text
 * files -- no child processes, no docker, no network.
 *
 * @module test/acceptance/story-36-6
 */

import * as fs from 'fs';
import * as path from 'path';

// Filesystem checks are fast -- 30 seconds is more than enough
jest.setTimeout(30000);

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOCS_FILE = path.join(PROJECT_ROOT, 'docs', 'ator-transport.md');
const CHANGELOG = path.join(PROJECT_ROOT, 'CHANGELOG.md');
const SPRINT_STATUS = path.join(
  PROJECT_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'sprint-status.yaml'
);
const NIGHTLY_WORKFLOW = path.join(PROJECT_ROOT, '.github', 'workflows', 'nightly-ator.yml');
const DOCKER_COMPOSE = path.join(PROJECT_ROOT, 'docker-compose.yml');
const MAKEFILE = path.join(PROJECT_ROOT, 'Makefile');
const CONNECTOR_SRC_DIR = path.join(PROJECT_ROOT, 'packages', 'connector', 'src');
const CONNECTOR_TEST_DIR = path.join(PROJECT_ROOT, 'packages', 'connector', 'test');

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

/**
 * Extract a section from the doc by heading text. Returns all content from
 * the heading line until the next heading of equal or higher level (or EOF).
 */
function extractSection(doc: string, headingText: string): string | null {
  // Match heading at any level (##, ###, etc.) containing the text
  const headingRe = new RegExp(
    `^(#{1,6})\\s+.*${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`,
    'mi'
  );
  const match = headingRe.exec(doc);
  if (!match || !match[1]) return null;
  const level = match[1].length;
  const startIdx = match.index;
  // Find the next heading of equal or higher level, skipping fenced code blocks
  // so that bash comments starting with # are not mistaken for markdown headings.
  const rest = doc.slice(startIdx + match[0].length);
  const nextHeadingRe = new RegExp(`^#{1,${level}}\\s`, 'm');
  // Strip fenced code blocks before scanning for headings. Match both
  // unindented and indented fenced blocks (list items indent with spaces)
  // so that bash comments (# ...) inside code blocks are not mistaken for
  // markdown headings.
  const stripped = rest.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, (m) =>
    '\n'.repeat(m.split('\n').length - 1)
  );
  const nextMatch = nextHeadingRe.exec(stripped);
  if (nextMatch) {
    return doc.slice(startIdx, startIdx + match[0].length + nextMatch.index);
  }
  return doc.slice(startIdx);
}

// ---------------------------------------------------------------------------
// AC 1: Zero remaining hedges
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 1: docs/ator-transport.md -- zero remaining hedges', () => {
  it('contains no "consult docs.anyone.io" hedge phrase', () => {
    const contents = readDocs();
    const matches = contents.match(/consult[^\n]*docs\.anyone\.io/gi) ?? [];
    expect(matches).toEqual([]);
  });

  it('contains no "do not guess" hedge phrase', () => {
    const contents = readDocs();
    const matches = contents.match(/do not guess/gi) ?? [];
    expect(matches).toEqual([]);
  });

  it('contains no TBD/TODO/unverified hedging language', () => {
    const contents = readDocs();
    // Build a set of character ranges covered by fenced code blocks so we can
    // distinguish prose matches from code-block matches by position -- not by
    // string value, which would miss a hedge that happens to also appear in a
    // code block.
    const codeBlockRanges: Array<[number, number]> = [];
    const codeBlockRe = /```[\s\S]*?```/g;
    let cbMatch: RegExpExecArray | null;
    while ((cbMatch = codeBlockRe.exec(contents)) !== null) {
      codeBlockRanges.push([cbMatch.index, cbMatch.index + cbMatch[0].length]);
    }
    function insideCodeBlock(idx: number): boolean {
      return codeBlockRanges.some(([start, end]) => idx >= start && idx < end);
    }

    const hedgePatterns = [/\bTBD\b/g, /\bTODO\b/g, /\bunverified\b/gi];
    for (const pattern of hedgePatterns) {
      let m: RegExpExecArray | null;
      const proseMatches: string[] = [];
      while ((m = pattern.exec(contents)) !== null) {
        if (!insideCodeBlock(m.index)) {
          proseMatches.push(`${m[0]} at offset ${m.index}`);
        }
      }
      // Allow TBD/TODO inside code blocks but not in prose
      expect(proseMatches).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 2: Verification Status section exists
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 2: Verification Status section', () => {
  it('contains a "Verification Status" heading', () => {
    const contents = readDocs();
    expect(contents).toMatch(/^#{1,3}\s+Verification Status/m);
  });

  it('names the pinned ATOR binary version v0.4.10.0-beta', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    expect(section!).toContain('v0.4.10.0-beta');
  });

  it('links to the nightly workflow file', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/nightly-ator\.yml/);
  });

  it('references the real-binary test files', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/transport-ator-real-binary/);
    expect(section!).toMatch(/transport-ator-hidden-service/);
  });

  it('states verification coverage areas (circuit build, HS rendezvous, managed lifecycle)', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    // At least two of the five coverage areas should be mentioned
    const coverageTerms = [
      /circuit/i,
      /hidden.?service|HS.?rendezvous/i,
      /managed.?lifecycle/i,
      /DNS/i,
      /fragmentation|cell/i,
    ];
    const matchCount = coverageTerms.filter((re) => re.test(section!)).length;
    expect(matchCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC 3: Local Development Network section exists
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 3: Local Development Network section', () => {
  it('contains a "Local Development Network" heading', () => {
    const contents = readDocs();
    expect(contents).toMatch(/^#{1,3}\s+Local Development Network/m);
  });

  it('describes the 7-service topology (3 DirAuth + 3 relay + 1 HS)', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    // Must mention DirAuth, relay, and HS in the topology description
    expect(section!).toMatch(/DirAuth/i);
    expect(section!).toMatch(/relay/i);
    expect(section!).toMatch(/HS|hidden.?service/i);
    // Must mention the count (3+3+1 or "7")
    expect(section!).toMatch(/3.*DirAuth|DirAuth.*3|3.*relay|relay.*3|7.?service|seven/i);
  });

  it('documents make ator-up, ator-down, ator-logs, and ator-test targets', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    const targets = ['ator-up', 'ator-down', 'ator-logs', 'ator-test'];
    for (const target of targets) {
      expect(section!).toContain(target);
    }
  });

  it('documents ATOR_NIGHTLY and ATOR_SOCKS_PORT env vars', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toContain('ATOR_NIGHTLY');
    expect(section!).toContain('ATOR_SOCKS_PORT');
  });

  it('references docker-compose.yml ator profile', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/docker.?compose/i);
    expect(section!).toMatch(/ator.*profile|profile.*ator/i);
  });

  it('references docker/ator/Dockerfile', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/docker\/ator\/Dockerfile/);
  });

  it('mentions the image tag ator-testnet:v0.4.10.0-beta', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toContain('ator-testnet:v0.4.10.0-beta');
  });
});

// ---------------------------------------------------------------------------
// AC 4: Prerequisites split into operational vs development
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 4: Prerequisites split into operational vs development', () => {
  it('contains an "Operational" prerequisites sub-section or label', () => {
    const contents = readDocs();
    const prereqSection = extractSection(contents, 'Prerequisites');
    expect(prereqSection).not.toBeNull();
    expect(prereqSection!).toMatch(/operational/i);
  });

  it('contains a "Development" prerequisites sub-section or label', () => {
    const contents = readDocs();
    const prereqSection = extractSection(contents, 'Prerequisites');
    expect(prereqSection).not.toBeNull();
    expect(prereqSection!).toMatch(/development/i);
  });

  it('operational prereqs include Node.js and npm (unchanged)', () => {
    const contents = readDocs();
    const prereqSection = extractSection(contents, 'Prerequisites');
    expect(prereqSection).not.toBeNull();
    expect(prereqSection!).toMatch(/Node\.js/);
    expect(prereqSection!).toMatch(/npm/);
  });

  it('development prereqs include Docker and make ator-up', () => {
    const contents = readDocs();
    const prereqSection = extractSection(contents, 'Prerequisites');
    expect(prereqSection).not.toBeNull();
    expect(prereqSection!).toMatch(/Docker/i);
    expect(prereqSection!).toContain('ator-up');
  });

  it('development prereqs mention ATOR_NIGHTLY env var', () => {
    const contents = readDocs();
    const prereqSection = extractSection(contents, 'Prerequisites');
    expect(prereqSection).not.toBeNull();
    expect(prereqSection!).toContain('ATOR_NIGHTLY');
  });
});

// ---------------------------------------------------------------------------
// AC 5: Troubleshooting updated with real-binary failure modes
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 5: Troubleshooting with real-binary failure modes', () => {
  it('Troubleshooting section exists', () => {
    const contents = readDocs();
    expect(contents).toMatch(/^#{1,3}\s+Troubleshooting/m);
  });

  it('contains at least 3 new real-binary failure mode entries (sub-headings or bold entries)', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Troubleshooting');
    expect(section).not.toBeNull();

    // Count real-binary-specific failure modes. Each should appear as a
    // sub-heading (### or ####) or bold entry within the troubleshooting section.
    // We look for keywords that indicate real-binary failure modes from 36.3/36.4/36.5.
    const realBinaryIndicators = [
      /consensus/i,
      /HS.?descriptor|hidden.?service.*(propagat|publish)/i,
      /circuit.?build.?timeout|circuit.?timeout/i,
      /docker.*ator|ator.*docker|image.?build/i,
      /nightly.?CI|CI.?fail/i,
      /port.?conflict/i,
      /container.?not.?start/i,
      /DirAuth.*vot|vot.*timeout/i,
      /SOCKS.?port.*in.?use|port.*already.?in.?use/i,
      /workflow.?dispatch/i,
    ];
    const matchCount = realBinaryIndicators.filter((re) => re.test(section!)).length;
    // AC requires "at least 3 new failure modes" -- we check for at least 3 matches
    expect(matchCount).toBeGreaterThanOrEqual(3);
  });

  it('each real-binary entry provides a diagnostic command or resolution', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Troubleshooting');
    expect(section).not.toBeNull();

    // Real-binary troubleshooting entries should contain at least one code
    // block (diagnostic command) or explicit resolution text
    const codeBlockCount = (section!.match(/```/g) ?? []).length / 2;
    // The pre-existing troubleshooting section already has code blocks;
    // after 36.6 lands there should be MORE code blocks than the original ~5
    expect(codeBlockCount).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// AC 6: Platform Matrix section exists and is consistent
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 6: Platform Matrix section', () => {
  it('contains a "Platform Matrix" heading', () => {
    const contents = readDocs();
    expect(contents).toMatch(/^#{1,3}\s+Platform Matrix/m);
  });

  it('Platform Matrix references the nightly-ator.yml workflow file', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Platform Matrix');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/nightly-ator\.yml/);
  });

  it('Platform Matrix covers ubuntu-latest and macos platforms', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Platform Matrix');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/ubuntu/i);
    expect(section!).toMatch(/macos/i);
  });

  it('Platform Matrix distinguishes real-binary vs system-tor-fallback coverage', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Platform Matrix');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/real.?binary/i);
    expect(section!).toMatch(/system.?tor|fallback/i);
  });
});

// ---------------------------------------------------------------------------
// AC 7: All file paths and flags mentioned exist and work
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 7: file paths mentioned in the guide exist in the codebase', () => {
  // Extract all file paths from the doc that look like project-relative paths
  function extractReferencedPaths(doc: string): string[] {
    const paths: string[] = [];
    // Match backtick-enclosed paths that look like project files
    const backtickPaths =
      doc.match(
        /`((?:packages|docker|\.github|docs|Makefile|docker-compose\.yml|CHANGELOG\.md)[^`]*?)`/g
      ) ?? [];
    for (const m of backtickPaths) {
      const p = m.replace(/^`|`$/g, '');
      // Skip patterns with wildcards, variables, example content, or shell commands
      if (p.includes('*') || p.includes('{') || p.includes('$')) continue;
      if (p.includes(' ')) continue; // commands like "docker compose ..." are not file paths
      paths.push(p);
    }
    return [...new Set(paths)];
  }

  it('every backtick-enclosed project path in the guide resolves to an existing file or directory', () => {
    const contents = readDocs();
    const referencedPaths = extractReferencedPaths(contents);
    // Must reference at least some paths (sanity check)
    expect(referencedPaths.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const p of referencedPaths) {
      const fullPath = path.join(PROJECT_ROOT, p);
      if (!fs.existsSync(fullPath)) {
        missing.push(p);
      }
    }
    expect(missing).toEqual([]);
  });

  it('nightly-ator.yml workflow file exists', () => {
    expect(fs.existsSync(NIGHTLY_WORKFLOW)).toBe(true);
  });

  it('docker-compose.yml exists', () => {
    expect(fs.existsSync(DOCKER_COMPOSE)).toBe(true);
  });

  it('docker/ator/Dockerfile exists', () => {
    const dockerfile = path.join(PROJECT_ROOT, 'docker', 'ator', 'Dockerfile');
    expect(fs.existsSync(dockerfile)).toBe(true);
  });

  it('Makefile contains ator-up, ator-down, ator-logs, and ator-test targets', () => {
    const makefile = readIfExists(MAKEFILE) ?? '';
    const targets = ['ator-up', 'ator-down', 'ator-logs', 'ator-test'];
    for (const target of targets) {
      expect(makefile).toContain(`${target}:`);
    }
  });

  it('referenced test files exist', () => {
    const testFiles = [
      'packages/connector/test/integration/transport-ator-real-binary.test.ts',
      'packages/connector/test/integration/transport-ator-hidden-service.test.ts',
      'packages/connector/test/integration/transport-system-tor-fallback.test.ts',
    ];
    for (const testFile of testFiles) {
      const fullPath = path.join(PROJECT_ROOT, testFile);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 8: Zero src/ or test/ changes (documentation-only bright line)
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 8: no source or test file changes', () => {
  it('no file under packages/connector/src/ carries a "Story 36.6" tag (tripwire)', () => {
    function walk(dir: string, acc: string[] = []): string[] {
      if (!fs.existsSync(dir)) return acc;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
      if (/Story\s+36\.6\b/i.test(head)) {
        violators.push(path.relative(PROJECT_ROOT, f));
      }
    }
    expect(violators).toEqual([]);
  });

  it('no file under packages/connector/test/ (other than acceptance/) carries a "Story 36.6" tag (tripwire)', () => {
    function walk(dir: string, acc: string[] = []): string[] {
      if (!fs.existsSync(dir)) return acc;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
          // Skip acceptance/ (that is where THIS test lives) and node_modules
          if (entry.name === 'acceptance' || entry.name === 'node_modules') continue;
          walk(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          acc.push(full);
        }
      }
      return acc;
    }

    const testFiles = fs.existsSync(CONNECTOR_TEST_DIR) ? walk(CONNECTOR_TEST_DIR) : [];
    const violators: string[] = [];
    for (const f of testFiles) {
      const head = fs.readFileSync(f, 'utf8').slice(0, 4096);
      if (/Story\s+36\.6\b/i.test(head)) {
        violators.push(path.relative(PROJECT_ROOT, f));
      }
    }
    expect(violators).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC 9: CHANGELOG + sprint-status updates
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 9: CHANGELOG and sprint-status updates', () => {
  it('CHANGELOG.md under ## [Unreleased] mentions Story 36.6 or 36-6', () => {
    const body = readIfExists(CHANGELOG) ?? '';
    // Extract the Unreleased section
    const unreleasedMatch = body.match(/## \[Unreleased\][\s\S]*?(?=## \[|$)/);
    expect(unreleasedMatch).not.toBeNull();
    const unreleased = unreleasedMatch![0];
    expect(unreleased).toMatch(/36[-.]6/i);
  });

  it('CHANGELOG entry references deployment guide or documentation update', () => {
    const body = readIfExists(CHANGELOG) ?? '';
    const unreleasedMatch = body.match(/## \[Unreleased\][\s\S]*?(?=## \[|$)/);
    expect(unreleasedMatch).not.toBeNull();
    const unreleased = unreleasedMatch![0];
    expect(unreleased.toLowerCase()).toMatch(
      /deployment guide|documentation|verification status|troubleshooting/
    );
  });

  it('sprint-status.yaml has 36.6 status set to done', () => {
    const body = readIfExists(SPRINT_STATUS) ?? '';
    // The YAML file should have the story status as done
    // Match the 36.6 story block and check status
    const storyMatch = body.match(/36\.6:[\s\S]*?status:\s*([\w-]+)/);
    expect(storyMatch).not.toBeNull();
    expect(storyMatch![1]).toBe('done');
  });

  it('sprint-status.yaml retrospective status remains pending (not flipped by this story)', () => {
    const body = readIfExists(SPRINT_STATUS) ?? '';
    // The retrospective should still be pending
    const retroMatch = body.match(/epic-36:[\s\S]*?retrospective:[\s\S]*?status:\s*([\w-]+)/);
    expect(retroMatch).not.toBeNull();
    expect(retroMatch![1]).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Table of Contents: new sections are linked
// ---------------------------------------------------------------------------

describe('Story 36.6 / ToC: new sections are linked in Table of Contents', () => {
  it('Table of Contents includes a Verification Status entry', () => {
    const contents = readDocs();
    // ToC entries are typically markdown links like [Verification Status](#...)
    const tocMatch = contents.match(/## Table of Contents[\s\S]*?(?=\n---|\n## [^T])/);
    expect(tocMatch).not.toBeNull();
    expect(tocMatch![0]).toMatch(/Verification Status/);
  });

  it('Table of Contents includes a Local Development Network entry', () => {
    const contents = readDocs();
    const tocMatch = contents.match(/## Table of Contents[\s\S]*?(?=\n---|\n## [^T])/);
    expect(tocMatch).not.toBeNull();
    expect(tocMatch![0]).toMatch(/Local Development Network/);
  });
});

// ---------------------------------------------------------------------------
// Gap-fill: additional AC coverage (Story 36.6 test automation pass)
// ---------------------------------------------------------------------------

describe('Story 36.6 / AC 2 (extended): Verification Status completeness', () => {
  it('references workflow run history or last-green date', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    // AC 2 requires: "shows last-green date or references workflow run history"
    expect(section!).toMatch(/workflow run history|last.?green|actions\/workflows/i);
  });

  it('states that all real-binary tests pass against the pinned binary', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Verification Status');
    expect(section).not.toBeNull();
    // AC 2 requires: "states that all real-binary tests (36.3 + 36.4) pass against pinned binary"
    expect(section!).toMatch(/real.?binary.*pass|pass.*pinned/i);
  });
});

describe('Story 36.6 / AC 3 (extended): Local Development Network completeness', () => {
  it('documents the quick-start sequence (ator-up -> ator-test -> ator-down)', () => {
    const contents = readDocs();
    // Extract the Local Development Network section by finding its heading and the next ## heading
    const sectionStart = contents.indexOf('## Local Development Network');
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionEnd = contents.indexOf('\n## ', sectionStart + 1);
    const section =
      sectionEnd > -1 ? contents.slice(sectionStart, sectionEnd) : contents.slice(sectionStart);
    // The quick-start should show the sequence in order
    const upIdx = section.indexOf('make ator-up');
    const testIdx = section.indexOf('make ator-test', upIdx);
    const downIdx = section.indexOf('make ator-down', testIdx);
    expect(upIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeGreaterThan(upIdx);
    expect(downIdx).toBeGreaterThan(testIdx);
  });

  it('documents infra-up and infra-down targets', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toContain('infra-up');
    expect(section!).toContain('infra-down');
  });

  it('references docker/ator/entrypoint.sh', () => {
    const contents = readDocs();
    const section = extractSection(contents, 'Local Development Network');
    expect(section).not.toBeNull();
    expect(section!).toMatch(/entrypoint\.sh/);
  });
});

describe('Story 36.6 / AC 5 (extended): Troubleshooting subsection structure', () => {
  /**
   * Helper: extract the full Troubleshooting section using simple ## boundary
   * detection, bypassing the extractSection helper which has a known issue with
   * indented fenced code blocks containing bash comments (# lines).
   */
  function getTroubleshootingSection(): string {
    const contents = readDocs();
    const start = contents.indexOf('## Troubleshooting');
    expect(start).toBeGreaterThan(-1);
    const end = contents.indexOf('\n## ', start + 1);
    return end > -1 ? contents.slice(start, end) : contents.slice(start);
  }

  it('contains a "Real-binary test suite failures" subsection', () => {
    const section = getTroubleshootingSection();
    expect(section).toMatch(/real.?binary.*test.*suite.*fail/i);
  });

  it('contains a "Docker / make ator-up issues" subsection', () => {
    const section = getTroubleshootingSection();
    expect(section).toMatch(/docker.*ator-up|ator-up.*issues/i);
  });

  it('contains a "Nightly CI failures" subsection', () => {
    const section = getTroubleshootingSection();
    expect(section).toMatch(/nightly.*CI.*fail/i);
  });

  it('each real-binary failure entry includes both a symptom and a diagnostic or resolution', () => {
    const section = getTroubleshootingSection();

    // Each real-binary failure mode entry should have Symptom AND (Diagnostic OR Resolution)
    // We verify the bold-label pattern used in the doc: **Symptom:**, **Diagnostic:**, **Resolution:**
    const symptomCount = (section.match(/\*\*Symptom/gi) ?? []).length;
    const diagnosticCount = (section.match(/\*\*Diagnostic/gi) ?? []).length;
    const resolutionCount = (section.match(/\*\*Resolution/gi) ?? []).length;

    // At least 3 symptom entries (one per required failure mode)
    expect(symptomCount).toBeGreaterThanOrEqual(3);
    // Each entry should have a diagnostic or resolution
    expect(diagnosticCount + resolutionCount).toBeGreaterThanOrEqual(3);
  });
});

describe('Story 36.6 / AC 7 (extended): additional file path and target verification', () => {
  it('Makefile contains infra-up and infra-down targets', () => {
    const makefile = readIfExists(MAKEFILE) ?? '';
    expect(makefile).toContain('infra-up:');
    expect(makefile).toContain('infra-down:');
  });

  it('docker/ator/entrypoint.sh exists', () => {
    const entrypoint = path.join(PROJECT_ROOT, 'docker', 'ator', 'entrypoint.sh');
    expect(fs.existsSync(entrypoint)).toBe(true);
  });

  it('docker/ator/torrc.dirauth exists', () => {
    const torrc = path.join(PROJECT_ROOT, 'docker', 'ator', 'torrc.dirauth');
    expect(fs.existsSync(torrc)).toBe(true);
  });

  it('docker/ator/torrc.relay exists', () => {
    const torrc = path.join(PROJECT_ROOT, 'docker', 'ator', 'torrc.relay');
    expect(fs.existsSync(torrc)).toBe(true);
  });

  it('docker/ator/torrc.hs exists', () => {
    const torrc = path.join(PROJECT_ROOT, 'docker', 'ator', 'torrc.hs');
    expect(fs.existsSync(torrc)).toBe(true);
  });
});
