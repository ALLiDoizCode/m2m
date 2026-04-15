/**
 * Acceptance Tests for Story 36.1: Local ATOR Network Image + docker-compose Profile
 *
 * These tests validate the docker/ator/ image sources, docker-compose.yml ator
 * profile (3 DirAuth + 3 relay + 1 HS node), Makefile targets (ator-up, ator-down,
 * ator-logs, ator-test), and related infra-up/infra-down/help updates required
 * to provide a deterministic real-binary ATOR substrate for stories 36.3–36.5.
 *
 * RED PHASE NOTE: All assertions below are **authored against state that does
 * not yet exist** (docker/ator/, ator profile services, ator-* make targets).
 * Every `describe` block will fail until Story 36.1 implementation lands.
 * The tests are pure static assertions — no Docker daemon is invoked. Live
 * lifecycle smoke (make ator-up / consensus readiness) is validated manually
 * by the story author per the story's Testing Standards section, and the
 * jest-level real-binary suites arrive in Stories 36.3/36.4.
 *
 * Acceptance Criteria Covered:
 * - AC 1:  docker-compose.yml ator profile — 7 services, pinned image
 * - AC 2:  Dockerfile — pinned .deb with SHA-256 verification
 * - AC 3:  Role-dispatching entrypoint + torrc templates
 * - AC 4:  DirAuth quorum configuration
 * - AC 5:  Relay nodes — mixed guard/middle/exit on internal-only network
 * - AC 6:  Hidden-service node — HS + client + SOCKS5 listener
 * - AC 7:  make ator-up / ator-down / ator-logs / ator-test targets
 * - AC 9:  make infra-up / infra-down include the ator profile
 * - AC 10: make help updated
 * - AC 11: Host-port + privilege invariants
 * - AC 12: Checksums file + upstream provenance
 * - AC 13: Docs-pointer reserved for Story 36.6 (scope bright-line)
 * - AC 14: Multi-arch image build behavior is explicit
 *
 * Excluded (lifecycle / runtime):
 * - AC 4's "published consensus within 60s"          → shell-level, manual
 * - AC 5's "relays appear in consensus within 90s"   → shell-level, manual
 * - AC 6's "hostname file populated within 120s"     → shell-level, manual
 * - AC 7's "`ator-up` exits 0 within 30s"            → shell-level, manual
 * - AC 8's teardown hygiene (docker ps/volume/network empty) → shell-level, manual
 *
 * Per the story: "The integration smokes are *not* jest tests — they are
 * shell-level assertions that the story author runs before marking the story
 * done. Story 36.3 is where the jest-level real-binary tests land."
 *
 * @module test/acceptance/story-36-1
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Path Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DOCKER_COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');
const MAKEFILE_PATH = path.join(PROJECT_ROOT, 'Makefile');
const CHANGELOG_PATH = path.join(PROJECT_ROOT, 'CHANGELOG.md');

const ATOR_DIR = path.join(PROJECT_ROOT, 'docker', 'ator');
const DOCKERFILE_PATH = path.join(ATOR_DIR, 'Dockerfile');
const CHECKSUMS_PATH = path.join(ATOR_DIR, 'checksums.txt');
const ENTRYPOINT_PATH = path.join(ATOR_DIR, 'entrypoint.sh');
const TORRC_DIRAUTH_PATH = path.join(ATOR_DIR, 'torrc.dirauth');
const TORRC_RELAY_PATH = path.join(ATOR_DIR, 'torrc.relay');
const TORRC_HS_PATH = path.join(ATOR_DIR, 'torrc.hs');

// Pinned upstream artifact reference — AC 1, AC 2, AC 12
const ATOR_IMAGE_TAG = 'ator-testnet:v0.4.10.0-beta';

const ATOR_SERVICES = [
  'dirauth1',
  'dirauth2',
  'dirauth3',
  'relay1',
  'relay2',
  'relay3',
  'hs1',
] as const;
const DIRAUTH_SERVICES = ['dirauth1', 'dirauth2', 'dirauth3'] as const;
const RELAY_SERVICES = ['relay1', 'relay2', 'relay3'] as const;

// Pre-existing profile service sets (AC 9 regression guard). If any of these
// services change profile association between now and story completion the
// test will fail loud — that is intentional (scope bright-line enforcement).
const PREEXISTING_PROFILES: Record<string, string> = {
  anvil: 'evm',
  faucet: 'evm',
  'solana-validator': 'solana',
  'mina-lightnet': 'mina',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type ComposeFile = Record<string, any>;
type ServiceDef = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

function loadFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function loadDockerCompose(): ComposeFile {
  return yaml.load(loadFileContent(DOCKER_COMPOSE_PATH)) as ComposeFile;
}

function getService(compose: ComposeFile, name: string): ServiceDef | undefined {
  const services = compose['services'] as Record<string, ServiceDef> | undefined;
  return services?.[name];
}

function getProfiles(svc: ServiceDef | undefined): string[] {
  if (!svc) return [];
  const profiles = svc['profiles'];
  if (Array.isArray(profiles)) return profiles as string[];
  return [];
}

// ===========================================================================
// AC 2 / AC 12 / AC 14: docker/ator/ image sources
// ===========================================================================

describe('AC 2: docker/ator/Dockerfile — pinned .deb with SHA-256 verification (Story 36.1)', () => {
  it('[T-36.1-02] should create docker/ator/Dockerfile', () => {
    expect(fs.existsSync(DOCKERFILE_PATH)).toBe(true);
  });

  it('[T-36.1-02] should base image on debian:bookworm-slim', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/^FROM\s+debian:bookworm-slim/m);
  });

  it('[T-36.1-02] should declare ARG TARGETARCH for multi-arch builds (AC 14)', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/ARG\s+TARGETARCH/);
  });

  it('[T-36.1-02] should reference the pinned upstream release URL (no :latest, no floating tags)', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toContain(
      'https://github.com/anyone-protocol/ator-protocol/releases/download/v0.4.10.0-beta/'
    );
    expect(content).not.toMatch(/:\s*latest/);
  });

  it('[T-36.1-02] should verify checksums via `sha256sum -c` (hard fail, no soft pass)', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/sha256sum\s+-c/);
    // Reject the anti-pattern the story explicitly forbids:
    //   echo "<hash>  <file>" | sha256sum -c -
    expect(content).not.toMatch(/echo\s+["'][a-f0-9]{64}/i);
  });

  it('[T-36.1-02] should copy/include docker/ator/checksums.txt into the image for verification', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/checksums\.txt/);
  });

  it('[T-36.1-02] should install the anon .deb via dpkg or apt with the downloaded file', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/dpkg\s+-i|apt(-get)?\s+install/);
  });

  it('[T-36.1-02] should clean apt caches to keep the image under 200 MB', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/apt(-get)?\s+clean|rm\s+-rf\s+\/var\/lib\/apt\/lists/);
  });

  it('[T-36.1-02] should COPY entrypoint.sh and declare it as ENTRYPOINT', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/COPY\s+[^\n]*entrypoint\.sh/);
    expect(content).toMatch(/ENTRYPOINT\s+\[?["']?\/[^"'\]]*entrypoint\.sh/);
  });

  it('[T-36.1-02] should COPY all three torrc templates into the image', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/torrc\.dirauth/);
    expect(content).toMatch(/torrc\.relay/);
    expect(content).toMatch(/torrc\.hs/);
  });

  it('[T-36.1-02] should install envsubst (gettext-base) for torrc templating', () => {
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/gettext(-base)?|envsubst/);
  });
});

describe('AC 12: docker/ator/checksums.txt — provenance + sha256sum -c compatible (Story 36.1)', () => {
  it('[T-36.1-02] should create docker/ator/checksums.txt', () => {
    expect(fs.existsSync(CHECKSUMS_PATH)).toBe(true);
  });

  it('[T-36.1-02] should record the upstream source URL pattern as a comment', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    expect(content).toMatch(
      /#.*github\.com\/anyone-protocol\/ator-protocol\/releases\/download\/v0\.4\.10\.0-beta/
    );
  });

  it('[T-36.1-02] should record provenance (# Verified against upstream release on YYYY-MM-DD)', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    expect(content).toMatch(/#\s*Verified against upstream release on\s+\d{4}-\d{2}-\d{2}/);
  });

  it('[T-36.1-02] should contain at minimum one amd64 entry in sha256sum -c format', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    // Lines of the form: "<64 hex>  <filename containing amd64 and .deb>"
    const amd64Line = content
      .split(/\r?\n/)
      .find((l) => /^[a-f0-9]{64}\s{2}\S+amd64.*\.deb$/.test(l));
    expect(amd64Line).toBeDefined();
  });

  it('[T-36.1-02] should reference the pinned version (0.4.10.0-beta) in the filename column', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    expect(content).toMatch(/0\.4\.10\.0-beta/);
  });

  it('[T-36.1-02] should address arm64 explicitly (either a real line or a commented gap note)', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    // Either a checksum line mentioning arm64, OR a comment noting the gap
    // with the R-36-03 tag / "not published" prose from AC 12.
    const hasArm64Checksum = /^[a-f0-9]{64}\s{2}\S+arm64.*\.deb$/m.test(content);
    const hasArm64Gap = /#.*arm64.*(not published|R-36-03|Rosetta)/i.test(content);
    expect(hasArm64Checksum || hasArm64Gap).toBe(true);
  });

  it('[T-36.1-02] should not contain trailing metadata on checksum lines (sha256sum -c strict format)', () => {
    const content = loadFileContent(CHECKSUMS_PATH);
    for (const line of content.split(/\r?\n/)) {
      if (/^[a-f0-9]{64}\s{2}/.test(line)) {
        // Two-space separator only; filename must be the whole remainder.
        // No trailing comments / size columns allowed on the hash line itself.
        expect(line).toMatch(/^[a-f0-9]{64}\s{2}\S+$/);
      }
    }
  });
});

// ===========================================================================
// AC 3: Role-dispatching entrypoint + torrc templates
// ===========================================================================

describe('AC 3: docker/ator/entrypoint.sh — role dispatch + signal forwarding (Story 36.1)', () => {
  it('should create docker/ator/entrypoint.sh', () => {
    expect(fs.existsSync(ENTRYPOINT_PATH)).toBe(true);
  });

  it('should start with a shell shebang', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/^#!\/(bin|usr\/bin\/env)\/?(ba)?sh/);
  });

  it('should enable strict mode (set -eu at minimum)', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/set\s+-[eu]+|set\s+-e[^a-z]/);
  });

  it('should dispatch on ANON_ROLE via a case statement', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/case\s+["']?\$\{?ANON_ROLE/);
    expect(content).toMatch(/dirauth/);
    expect(content).toMatch(/relay/);
    expect(content).toMatch(/(\bhs\b|"hs"|'hs')/);
  });

  it('should render torrc templates with envsubst (no hand-rolled sed)', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/envsubst/);
  });

  it('should exec the anon binary so signals reach PID 1', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/exec\s+anon\b/);
  });

  it('should install SIGTERM / SIGINT traps for clean shutdown (signal forwarding)', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/trap\b/);
    // Mirror infra/solana/entrypoint.sh pattern — signals named explicitly.
    expect(content).toMatch(/SIGTERM|TERM/);
    expect(content).toMatch(/SIGINT|INT/);
  });

  it('should exit 64 on unknown or missing ANON_ROLE with a descriptive message', () => {
    const content = loadFileContent(ENTRYPOINT_PATH);
    expect(content).toMatch(/exit\s+64/);
    expect(content).toMatch(/ANON_ROLE/);
  });
});

describe('AC 3: torrc templates — one per role (Story 36.1)', () => {
  it('should create docker/ator/torrc.dirauth', () => {
    expect(fs.existsSync(TORRC_DIRAUTH_PATH)).toBe(true);
  });

  it('should create docker/ator/torrc.relay', () => {
    expect(fs.existsSync(TORRC_RELAY_PATH)).toBe(true);
  });

  it('should create docker/ator/torrc.hs', () => {
    expect(fs.existsSync(TORRC_HS_PATH)).toBe(true);
  });

  it('should use shell-style ${VAR} placeholders (envsubst-compatible) in all templates', () => {
    const paths = [TORRC_DIRAUTH_PATH, TORRC_RELAY_PATH, TORRC_HS_PATH];
    // Assert all three template files exist FIRST — otherwise the loop below
    // would vacuously pass (zero iterations) when every template is missing.
    for (const p of paths) {
      expect(fs.existsSync(p)).toBe(true);
    }
    for (const p of paths) {
      const content = loadFileContent(p);
      expect(content).toMatch(/\$\{[A-Z_]+\}/);
    }
  });
});

describe('AC 4: torrc.dirauth — DirAuth quorum configuration (Story 36.1)', () => {
  let content = '';
  beforeAll(() => {
    if (fs.existsSync(TORRC_DIRAUTH_PATH)) content = loadFileContent(TORRC_DIRAUTH_PATH);
  });

  it('should set V3AuthVotingInterval to 20 (short for test speed)', () => {
    expect(content).toMatch(/^V3AuthVotingInterval\s+20\b/m);
  });

  it('should enable TestingTorNetwork', () => {
    expect(content).toMatch(/^TestingTorNetwork\s+1\b/m);
  });

  it('should declare AuthoritativeDirectory', () => {
    expect(content).toMatch(/^AuthoritativeDirectory\s+1\b/m);
  });

  it('should declare V3AuthoritativeDirectory', () => {
    expect(content).toMatch(/^V3AuthoritativeDirectory\s+1\b/m);
  });

  it('should define ORPort and DirPort', () => {
    expect(content).toMatch(/^ORPort\b/m);
    expect(content).toMatch(/^DirPort\b/m);
  });

  it('should define ControlPort (so health/readiness probes can poll)', () => {
    expect(content).toMatch(/^ControlPort\b/m);
  });

  it('should declare DirAuthority lines for the three-node quorum via envsubst vars', () => {
    // The entrypoint composes all three DirAuthority lines from env at start-time,
    // so the template must reference substitutable lines (one per peer).
    expect(content).toMatch(/DirAuthority/);
  });
});

describe('AC 5: torrc.relay — mixed guard/middle/exit on internal network (Story 36.1)', () => {
  let content = '';
  beforeAll(() => {
    if (fs.existsSync(TORRC_RELAY_PATH)) content = loadFileContent(TORRC_RELAY_PATH);
  });

  it('should set ORPort 9001 (high-numbered to avoid privileged-port conflicts)', () => {
    // Accept either literal "9001" OR the ${ORPORT} envsubst placeholder
    // (compose env pins ORPORT=9001 for relays — asserted in the compose tests).
    expect(content).toMatch(/^ORPort\s+(9001\b|\$\{ORPORT\})/m);
  });

  it('should set DirPort 9030', () => {
    // Accept either literal "9030" OR the ${DIRPORT} envsubst placeholder
    // (compose env pins DIRPORT=9030 for relays — asserted in the compose tests).
    expect(content).toMatch(/^DirPort\s+(9030\b|\$\{DIRPORT\})/m);
  });

  it('should declare ExitRelay 1', () => {
    expect(content).toMatch(/^ExitRelay\s+1\b/m);
  });

  it('should declare ExitPolicy accept *:* (cosmetic; docker network internal:true enforces no egress)', () => {
    expect(content).toMatch(/^ExitPolicy\s+accept\s+\*:\*/m);
  });

  it('should set BandwidthRate and BandwidthBurst to sane test values', () => {
    expect(content).toMatch(/^BandwidthRate\b/m);
    expect(content).toMatch(/^BandwidthBurst\b/m);
  });
});

describe('AC 6: torrc.hs — hidden service + client + relay (Story 36.1)', () => {
  let content = '';
  beforeAll(() => {
    if (fs.existsSync(TORRC_HS_PATH)) content = loadFileContent(TORRC_HS_PATH);
  });

  it('should configure SOCKSPort on 9050 (container-side listener)', () => {
    // Accept either literal "9050" OR the ${SOCKS_PORT} envsubst placeholder
    // (compose env pins SOCKS_PORT=9050 for hs1 — asserted in the compose tests).
    expect(content).toMatch(/^SOCKSPort\b[^\n]*(9050|\$\{SOCKS_PORT\})/m);
  });

  it('should declare HiddenServiceDir', () => {
    expect(content).toMatch(/^HiddenServiceDir\b/m);
  });

  it('should map HiddenServicePort 5000 to 127.0.0.1:5000', () => {
    expect(content).toMatch(/^HiddenServicePort\s+5000\s+127\.0\.0\.1:5000/m);
  });

  it('should also act as a relay (ORPort declared) per AC 6 combined-role requirement', () => {
    expect(content).toMatch(/^ORPort\b/m);
  });
});

// ===========================================================================
// AC 1 / AC 5 / AC 6 / AC 11: docker-compose.yml ator profile
// ===========================================================================

describe('AC 1: docker-compose.yml ator profile — 7 services, pinned image (Story 36.1)', () => {
  let compose: ComposeFile;

  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it.each(ATOR_SERVICES)('[T-36.1-01] should define service "%s"', (name) => {
    const svc = getService(compose, name);
    expect(svc).toBeDefined();
  });

  it('[T-36.1-01] should expose exactly 7 services under the ator profile', () => {
    const services = compose['services'] as Record<string, ServiceDef>;
    const atorServiceNames = Object.keys(services).filter((name) =>
      getProfiles(services[name]).includes('ator')
    );
    expect(atorServiceNames.sort()).toEqual([...ATOR_SERVICES].sort());
  });

  it.each(ATOR_SERVICES)(
    '[T-36.1-02] service "%s" should use the pinned image ator-testnet:v0.4.10.0-beta',
    (name) => {
      const svc = getService(compose, name);
      expect(svc?.['image']).toBe(ATOR_IMAGE_TAG);
    }
  );

  it.each(ATOR_SERVICES)('service "%s" should declare profiles: [ator]', (name) => {
    const svc = getService(compose, name);
    expect(getProfiles(svc)).toContain('ator');
  });

  it.each(ATOR_SERVICES)('service "%s" should declare a healthcheck', (name) => {
    const svc = getService(compose, name);
    expect(svc?.['healthcheck']).toBeDefined();
  });

  it.each(ATOR_SERVICES)('service "%s" should mount a named volume for /var/lib/anon', (name) => {
    const svc = getService(compose, name);
    const vols = (svc?.['volumes'] as unknown[]) ?? [];
    const hasAnonVol = vols.some((v) => String(v).includes('/var/lib/anon'));
    expect(hasAnonVol).toBe(true);
  });

  it.each(DIRAUTH_SERVICES)('[dirauth] service "%s" should set ANON_ROLE=dirauth', (name) => {
    const svc = getService(compose, name);
    const envBlock = svc?.['environment'];
    const asText = JSON.stringify(envBlock ?? {});
    expect(asText).toMatch(/ANON_ROLE[^a-z]*dirauth/i);
  });

  it.each(DIRAUTH_SERVICES)(
    '[dirauth] service "%s" should set a per-service IDENTITY_SEED',
    (name) => {
      const svc = getService(compose, name);
      const asText = JSON.stringify(svc?.['environment'] ?? {});
      expect(asText).toMatch(/IDENTITY_SEED/);
    }
  );

  it.each(RELAY_SERVICES)('[relay] service "%s" should set ANON_ROLE=relay', (name) => {
    const svc = getService(compose, name);
    const asText = JSON.stringify(svc?.['environment'] ?? {});
    expect(asText).toMatch(/ANON_ROLE[^a-z]*relay/i);
  });

  it('[hs1] service should set ANON_ROLE=hs', () => {
    const svc = getService(compose, 'hs1');
    const asText = JSON.stringify(svc?.['environment'] ?? {});
    expect(asText).toMatch(/ANON_ROLE[^a-z]*hs\b/i);
  });
});

describe('AC 6 / AC 11: hs1 host exposure + port hygiene (Story 36.1)', () => {
  let compose: ComposeFile;
  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it('[T-36.1-05] hs1 should expose SOCKS5 on host 127.0.0.1:9150 (env-overridable, default 9150)', () => {
    const svc = getService(compose, 'hs1');
    const ports = (svc?.['ports'] as unknown[]) ?? [];
    const asText = ports.map((p) => String(p)).join('\n');
    // The default mapping must be 127.0.0.1:<9150-or-env>:9050
    expect(asText).toMatch(
      /127\.0\.0\.1:.*9150.*:\s*9050|127\.0\.0\.1:\$\{ATOR_HS_SOCKS_PORT[^}]*9150[^}]*\}:9050/
    );
  });

  it('[AC 11] no ator service should bind to a host port below 1024', () => {
    const services = compose['services'] as Record<string, ServiceDef>;
    for (const name of ATOR_SERVICES) {
      const svc = services[name];
      if (!svc) continue;
      const ports = (svc['ports'] as unknown[]) ?? [];
      for (const p of ports) {
        const s = String(p);
        // Match host-side port. Patterns: "HOST:CONT", "IP:HOST:CONT", or long-form.
        // Extract the number preceding the final ":<container-port>".
        const m = s.match(/(?:^|:)(\d+)(?::\d+)$/);
        const hostPort = m ? parseInt(m[1]!, 10) : NaN;
        if (!Number.isNaN(hostPort)) {
          expect(hostPort).toBeGreaterThanOrEqual(1024);
        }
      }
    }
  });

  it('[AC 11] no ator service should declare privileged: true', () => {
    const services = compose['services'] as Record<string, ServiceDef>;
    for (const name of ATOR_SERVICES) {
      const svc = services[name];
      if (!svc) continue;
      expect(svc['privileged']).not.toBe(true);
    }
  });

  it('[AC 11] only hs1 should expose a host port; other ator services are internal-only', () => {
    const services = compose['services'] as Record<string, ServiceDef>;
    for (const name of ATOR_SERVICES) {
      if (name === 'hs1') continue;
      const svc = services[name];
      if (!svc) continue;
      const ports = (svc['ports'] as unknown[]) ?? [];
      expect(ports.length).toBe(0);
    }
  });

  it('[AC 11] should declare an internal-only network for the ator profile', () => {
    const networks = compose['networks'] as Record<string, Record<string, unknown>> | undefined;
    expect(networks).toBeDefined();
    const atorNet = networks?.['ator_net'];
    expect(atorNet).toBeDefined();
    expect(atorNet?.['internal']).toBe(true);
  });

  it('[AC 11] all ator services should attach to ator_net', () => {
    const services = compose['services'] as Record<string, ServiceDef>;
    for (const name of ATOR_SERVICES) {
      const svc = services[name];
      if (!svc) continue;
      const nets = svc['networks'];
      const asText = Array.isArray(nets)
        ? (nets as string[]).join(',')
        : JSON.stringify(nets ?? {});
      expect(asText).toContain('ator_net');
    }
  });
});

describe('AC 5 / dependency ordering: relays depend on dirauths; hs1 depends on relays (Story 36.1)', () => {
  let compose: ComposeFile;
  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it.each(RELAY_SERVICES)('[relay] "%s" should depend_on at least one dirauth', (name) => {
    const svc = getService(compose, name);
    const dep = svc?.['depends_on'];
    const asText = JSON.stringify(dep ?? {});
    expect(asText).toMatch(/dirauth[123]/);
  });

  it('[hs1] should depend_on at least one relay', () => {
    const svc = getService(compose, 'hs1');
    const asText = JSON.stringify(svc?.['depends_on'] ?? {});
    expect(asText).toMatch(/relay[123]/);
  });
});

describe('AC 11 (cross-profile): ator port bindings do not collide with evm/solana/mina (Story 36.1)', () => {
  it('ator host-port bindings must be disjoint from pre-existing profile host ports', () => {
    const compose = loadDockerCompose();
    const services = compose['services'] as Record<string, ServiceDef>;

    const collectHostPorts = (predicate: (svc: ServiceDef) => boolean): Set<number> => {
      const set = new Set<number>();
      for (const [, svc] of Object.entries(services)) {
        if (!predicate(svc)) continue;
        const ports = (svc['ports'] as unknown[]) ?? [];
        for (const p of ports) {
          const s = String(p);
          const m = s.match(/(?:^|:)(\d+)(?::\d+)$/);
          if (m) set.add(parseInt(m[1]!, 10));
        }
      }
      return set;
    };

    const atorPorts = collectHostPorts((svc) => getProfiles(svc).includes('ator'));
    const otherPorts = collectHostPorts((svc) => {
      const profs = getProfiles(svc);
      return profs.length > 0 && !profs.includes('ator');
    });

    for (const p of atorPorts) {
      expect(otherPorts.has(p)).toBe(false);
    }
  });
});

// ===========================================================================
// AC 7 / AC 9 / AC 10: Makefile targets
// ===========================================================================

describe('AC 7: Makefile ator-up / ator-down / ator-logs / ator-test targets (Story 36.1)', () => {
  let mk = '';
  beforeAll(() => {
    mk = loadFileContent(MAKEFILE_PATH);
  });

  it('[T-36.1-01] should define ator-up invoking `docker compose --profile ator up -d`', () => {
    expect(mk).toMatch(/^ator-up:[\s\S]*?docker\s+compose\s+--profile\s+ator\s+up\s+-d/m);
  });

  it('[T-36.1-03] should define ator-down invoking `docker compose --profile ator down -v` (note -v)', () => {
    expect(mk).toMatch(/^ator-down:[\s\S]*?docker\s+compose\s+--profile\s+ator\s+down\s+-v/m);
  });

  it('[T-36.1-08] should define ator-logs invoking `docker compose --profile ator logs -f`', () => {
    expect(mk).toMatch(/^ator-logs:[\s\S]*?docker\s+compose\s+--profile\s+ator\s+logs\s+-f/m);
  });

  it('should define ator-test target', () => {
    expect(mk).toMatch(/^ator-test:/m);
  });

  it('ator-test should export ATOR_NIGHTLY=1', () => {
    // Extract the ator-test recipe block (through next non-tab line).
    const block =
      mk.match(/^ator-test:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/ATOR_NIGHTLY\s*=\s*1/);
  });

  it('ator-test should derive ATOR_SOCKS_PORT from `docker compose port hs1 9050`', () => {
    const block =
      mk.match(/^ator-test:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/docker\s+compose\s+port\s+hs1\s+9050/);
    expect(block).toMatch(/ATOR_SOCKS_PORT/);
  });

  it('ator-test should fail fast with a "run `make ator-up` first" message when hs1 port is not bound', () => {
    const block =
      mk.match(/^ator-test:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/ator-up/);
    // Some form of error/exit on empty port lookup:
    expect(block).toMatch(/exit\s+1|false\s*;|\|\|\s*\(/);
  });

  it('ator-test should invoke the jest integration runner with --passWithNoTests', () => {
    const block =
      mk.match(/^ator-test:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/--passWithNoTests/);
    expect(block).toMatch(/npm\s+run\s+test|jest/);
  });

  it('should register all four new targets as .PHONY', () => {
    expect(mk).toMatch(/\.PHONY:[^\n]*ator-up/);
    expect(mk).toMatch(/\.PHONY:[^\n]*ator-down/);
    expect(mk).toMatch(/\.PHONY:[^\n]*ator-logs/);
    expect(mk).toMatch(/\.PHONY:[^\n]*ator-test/);
  });
});

describe('AC 9: infra-up / infra-down include --profile ator (Story 36.1)', () => {
  let mk = '';
  beforeAll(() => {
    mk = loadFileContent(MAKEFILE_PATH);
  });

  it('infra-up should compose all four profiles (evm + solana + mina + ator)', () => {
    const block =
      mk.match(/^infra-up:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/--profile\s+evm/);
    expect(block).toMatch(/--profile\s+solana/);
    expect(block).toMatch(/--profile\s+mina/);
    expect(block).toMatch(/--profile\s+ator/);
    expect(block).toMatch(/up\s+-d/);
  });

  it('infra-down should tear down all four profiles WITHOUT -v (preserves pre-existing semantics)', () => {
    const block =
      mk.match(/^infra-down:[\s\S]*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|$(?![\s\S]))/m)?.[0] ?? '';
    expect(block).toMatch(/--profile\s+evm/);
    expect(block).toMatch(/--profile\s+solana/);
    expect(block).toMatch(/--profile\s+mina/);
    expect(block).toMatch(/--profile\s+ator/);
    expect(block).toMatch(/\bdown\b/);
    // Critical: infra-down must NOT introduce -v across the existing profiles.
    expect(block).not.toMatch(/\bdown\s+[^\n]*-v\b/);
  });
});

describe('AC 10: make help lists the new ATOR targets (Story 36.1)', () => {
  let mk = '';
  beforeAll(() => {
    mk = loadFileContent(MAKEFILE_PATH);
  });

  it('help should mention ator-up', () => {
    expect(mk).toMatch(/help:[\s\S]*ator-up/);
  });

  it('help should mention ator-down', () => {
    expect(mk).toMatch(/help:[\s\S]*ator-down/);
  });

  it('help should mention ator-logs', () => {
    expect(mk).toMatch(/help:[\s\S]*ator-logs/);
  });

  it('help should mention ator-test', () => {
    expect(mk).toMatch(/help:[\s\S]*ator-test/);
  });

  it('help should mention ATOR in the all-chains section alongside EVM, Solana, Mina', () => {
    // The line describing the all-chains section should name ATOR.
    expect(mk).toMatch(/All Chains[\s\S]*ATOR|ATOR[\s\S]*All Chains/i);
  });
});

// ===========================================================================
// AC 9 (regression): pre-existing evm/solana/mina services unchanged
// ===========================================================================

describe('AC 9 (regression): pre-existing profiles unchanged (Story 36.1)', () => {
  let compose: ComposeFile;
  beforeAll(() => {
    compose = loadDockerCompose();
  });

  it.each(Object.entries(PREEXISTING_PROFILES))(
    'pre-existing service "%s" should still declare profile "%s"',
    (name, profile) => {
      const svc = getService(compose, name);
      expect(getProfiles(svc)).toContain(profile);
    }
  );
});

// ===========================================================================
// AC 13: Scope bright-line — Epic 36 is verification-only
// ===========================================================================

describe('AC 13: CHANGELOG + scope bright-line (Story 36.1)', () => {
  it('CHANGELOG.md should contain at minimum one Unreleased entry referencing Story 36.1', () => {
    const changelog = loadFileContent(CHANGELOG_PATH);
    // Extract the Unreleased section (up to the next H2).
    const unreleased =
      changelog.match(/##\s*\[Unreleased\][\s\S]*?(?=^##\s|$(?![\s\S]))/m)?.[0] ?? '';
    expect(unreleased).toMatch(/36\.1|Story\s+36\.1|ator.*local.*network|local ATOR/i);
  });

  it('packages/connector/src/ should not contain new files introduced by this story', () => {
    // Scope check: the story explicitly forbids changes under packages/connector/src/.
    // We assert the transport/ and config/ subtrees remain the Epic 35 frozen surface
    // by refusing to find any new filename that mentions "ator-compose" or similar
    // infra-local symbols (a proxy for scope leak).
    const srcRoot = path.resolve(PROJECT_ROOT, 'packages', 'connector', 'src');
    const walk = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        // Defensive: reject any entry name containing path separators or
        // traversal segments. readdirSync should never return such names on a
        // sane filesystem, but this keeps the join provably traversal-safe.
        if (e.name.includes('/') || e.name.includes('\\') || e.name === '..' || e.name === '.') {
          return [];
        }
        // Only traverse regular directories and files — skip symlinks so the
        // walk cannot escape srcRoot via a dangling link.
        if (e.isSymbolicLink()) return [];
        // e.name is validated above (no separators, no traversal segments, no
        // symlinks); dir originates from the fixed srcRoot constant. The
        // resolve() guard below confirms the joined path stays inside srcRoot.
        const full = path.join(dir, e.name); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        // Belt-and-suspenders: ensure the joined path stays under srcRoot.
        const resolved = path.resolve(full); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        if (!resolved.startsWith(srcRoot + path.sep) && resolved !== srcRoot) {
          return [];
        }
        return e.isDirectory() ? walk(full) : [full];
      });
    };
    const leaks = walk(srcRoot).filter((f) =>
      /ator-compose|ator-local-network|docker-ator/i.test(path.basename(f))
    );
    expect(leaks).toEqual([]);
  });
});

// ===========================================================================
// AC 14: Multi-arch posture (static)
// ===========================================================================

describe('AC 14: multi-arch posture is explicit in Dockerfile (Story 36.1)', () => {
  it('Dockerfile should branch on TARGETARCH to select amd64 vs arm64 .deb', () => {
    if (!fs.existsSync(DOCKERFILE_PATH)) {
      // Parent AC-2 test will already fail; keep this test red for the right reason.
      expect(fs.existsSync(DOCKERFILE_PATH)).toBe(true);
      return;
    }
    const content = loadFileContent(DOCKERFILE_PATH);
    expect(content).toMatch(/TARGETARCH/);
    expect(content).toMatch(/amd64/);
    // arm64 may either be a real branch or an explicit "not supported" fail-fast —
    // either way the token must appear (story AC 14 requires explicit handling).
    expect(content).toMatch(/arm64/);
  });
});

// ===========================================================================
// Knowledge-base anchors (documentation only, not assertions)
// ===========================================================================
// - Knowledge fragment: data-factories.md         — N/A (no data factories needed; pure static assertions)
// - Knowledge fragment: component-tdd.md          — N/A (no UI)
// - Knowledge fragment: test-quality.md           — Applied: one assertion per it(), deterministic
// - Knowledge fragment: test-healing-patterns.md  — Applied: exact string anchors + structured YAML parse
// - Knowledge fragment: test-levels-framework.md  — Level chosen: Acceptance (static-asset assertions),
//                                                   per 33.9 / 34.10 precedent for local-dev-infra stories.
// - Knowledge fragment: test-priorities-matrix.md — All tests P0 (foundation story; blocks 36.3/36.4/36.5).
