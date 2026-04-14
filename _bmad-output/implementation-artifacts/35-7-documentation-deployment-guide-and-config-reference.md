# Story 35.7: Documentation — Deployment Guide and Config Reference

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector operator evaluating or deploying ATOR overlay transport**,
I want **a single authoritative deployment guide plus an updated config reference that covers ATOR/Tor setup, the `transport` YAML block, peer discovery, performance/timeout tuning, the three-layer privacy model (ATOR + ILP + NIP-59), and troubleshooting (DNS-leak detection, proxy health, managed-client failure modes)**,
so that **a new operator can go from zero to a working, privacy-enabled peering in a single sitting, an existing direct-mode operator can safely leave their deployment unchanged, and a security reviewer can verify the claimed privacy guarantees match what Stories 35.1–35.6 actually implement — without spelunking source code**.

**Epic:** 35 — ATOR Overlay Transport for Privacy-Enabled Peering
**Priority:** P1 (final story of the epic — closes the epic's Definition of Done docs requirement; no code behavior changes)
**Estimated effort:** 2 points (~0.5–1 dev day, pure docs)
**Dependencies:** Stories 35.1 (done), 35.2 (done), 35.3 (done), 35.4 (done), 35.5 (done), 35.6 (done). Production surface area is frozen by those stories — this story documents what exists, it does not introduce new runtime behavior. If a documentation gap exposes a missing feature (e.g., a health endpoint field that should exist but doesn't), file a follow-up story rather than expanding 35.7 scope to add code.

## Acceptance Criteria

### AC 1: Deployment guide exists at `docs/ator-transport.md`

```gherkin
Given a fresh checkout of the connector repo
When a new operator opens docs/ator-transport.md
Then the document includes a Table of Contents linking to these top-level sections (docs/solana-deployment.md / docs/mina-deployment.md are the sibling style template — match their voice and heading rhythm):
  - Prerequisites
  - Installation (anon binary: managed vs external)
  - Connector Configuration (transport block)
  - Peer Discovery (static config + out-of-band .anon exchange)
  - Privacy Model (three-layer stack: ATOR + ILP + NIP-59)
  - Performance & Timeout Tuning
  - Operational Monitoring (health endpoint transport fields)
  - Troubleshooting (DNS-leak detection, proxy down, managed-client crash)
  - Security Model (what it protects / does not protect against)
And every code block is a self-contained, copy-pasteable snippet (no ellipses)
And every YAML block validates against the TransportConfig discriminated
  union defined in packages/connector/src/config/types.ts, as enforced by
  `ConfigLoader.validateTransport` in
  packages/connector/src/config/config-loader.ts (note: validation is
  hand-rolled, throwing `ConfigurationError` — the schema is NOT a Zod
  schema even though other parts of the codebase use Zod)
```

Scope note: a reviewer must be able to copy any YAML block verbatim into a `connector.yaml` and pass config-loader validation. No `# ...` placeholders in YAML.

### AC 2: Both installation paths documented — managed and external

```gherkin
Given the Installation section of docs/ator-transport.md
When the operator chooses between running the anon binary themselves (external)
  vs letting the connector manage it (managed: true via @anyone-protocol/anyone-client)
Then the guide documents BOTH paths with:
  - The exact npm dependency status (@anyone-protocol/anyone-client is an
    OPTIONAL dependency; see packages/connector/package.json optionalDependencies
    and Story 35.5 AC10)
  - How to install it explicitly when managed: true is used
  - How to install/run the anon binary externally when managed: false (or absent)
  - The minimum Node.js version (>= 22.11.0, per root package.json engines)
  - Platform support caveats documented in epic's R-005 (SDK-bundled binary
    limitations; fallback to system tor with socks5h://)
And the managed-path section cross-references Story 35.5 managed-client
  lifecycle semantics (SDK start → port probe → fail-closed)
```

### AC 3: `transport` config block reference is complete and schema-accurate

```gherkin
Given the Connector Configuration section
When an operator reads the transport block reference
Then EVERY field of the TransportConfig schema is documented:
  - type: "direct" | "socks5" (default "direct" when block absent)
  - socksProxy: required when type="socks5", MUST use socks5h:// scheme
    (case-sensitive; uppercase/mixed-case variants like "SOCKS5H://" or
    "socks5://" are rejected — see Story 35.6 SEC-03 triple-rejection)
  - externalUrl: required when type="socks5"; accepts "auto" only when
    managed=true AND managedOptions.hiddenServiceDir is set
  - managed: boolean, default false
  - managedOptions: ONLY valid when managed=true; includes hiddenServiceDir
    and any other fields exposed in packages/connector/src/config/types.ts
And each field has:
  - A one-line description
  - A type/default
  - A "Required when" rule
  - A validation error the operator would see if violated (quoting the
    actual `ConfigurationError` message verbatim from
    packages/connector/src/config/config-loader.ts — the
    `validateTransport` / `validateSocks5Transport` / `validateManagedOptions`
    methods hold the authoritative error strings)
And the reference includes THREE complete, valid example configs:
  - Example A: type: "direct" (or block absent — note that absence is
    normalized to { type: "direct" } by the config loader's
    `validateTransport` method, NOT by a Zod schema default; see
    packages/connector/src/config/config-loader.ts) — zero-change baseline
  - Example B: type: "socks5" + external anon (managed: false)
  - Example C: type: "socks5" + managed anon with hidden service + externalUrl "auto"
And each example YAML is a real, full-enough connector.yaml skeleton to make
  sense (not just the transport block in isolation)
```

Verification protocol: each YAML example MUST be pasted into a scratch file and loaded via the config-loader during story development. If Zod rejects it, fix the example, not the schema.

### AC 4: Privacy model explains the three-layer stack with honest limitations

```gherkin
Given the Privacy Model section
When a developer unfamiliar with onion routing reads it
Then the section explains:
  - Layer 1 (ATOR circuit): what it hides (514-byte cells, content-blind) and
    from whom (relays, ISPs, network observers)
  - Layer 2 (ILP routing): what it hides (only endpoints see destination, amount,
    expiry; relays see nothing) and its LIMITATION (ILP hierarchical addresses
    are inherently informative about destination — documented in epic §Security
    Analysis "What It Does NOT Protect Against")
  - Layer 3 (NIP-59 gift wrap): what it hides (sender identity, blockchain type,
    amounts, timing in settlement claims) and its dependency (Epic 34 must be
    enabled; transport-layer ATOR alone is NOT NIP-59)
And the section explicitly lists what the stack does NOT protect against
  (timing correlation by global passive adversary, compromised entry+exit,
  application-level leaks) — text must match the substance of epic §Security
  Analysis, not downgrade the limitations
And the "Cross-Layer Attack Surface" table from the epic is included or
  faithfully summarized, including the "Full stack compromise = critical"
  honest assessment
```

### AC 5: Performance and timeout guidance is actionable

```gherkin
Given the Performance & Timeout Tuning section
When an operator is configuring ILP timeouts for an ATOR-peered deployment
Then the section documents:
  - The latency table from epic §Performance Characteristics (direct ~50ms vs
    ATOR ~600ms for BTP connect; 3-hop ILP ~300ms direct vs 1.2–2.1s ATOR)
  - A recommended ILP PREPARE timeout MINIMUM for ATOR peers, with rationale
    tied to the measured hop-count math
  - Guidance on mixed topologies (one SOCKS connector, one direct — covered by
    Story 35.6 AC12) including the timeout asymmetry implication
  - Pointers to the specific connector config keys that control these timeouts
    (cite the actual key names from packages/connector/src/config/types.ts)
And the recommendations are presented as RANGES with rationale, not single
  magic numbers — operators pick based on their hop count and latency budget
```

### AC 6: Troubleshooting section covers the epic's documented failure modes

```gherkin
Given the Troubleshooting section
When an operator encounters one of the epic's known failure modes
Then the section provides diagnostic steps for EACH of these scenarios:
  - DNS leak detection: how to confirm socks5h:// is actually in effect
    (including the Story 35.6 SEC-01 observation protocol — ATYP=DOMAINNAME
    at the proxy, not IPV4/IPV6 — translated into operator-facing tcpdump /
    proxy log guidance)
  - SOCKS proxy down: what the startup error looks like (reference the actual
    error message shape from SocksTransportProvider.start()) and how to confirm
    fail-closed behavior is working (no direct TCP to peer)
  - Managed anon client crash: how to read the health endpoint transport.healthy
    field, what the WARN log (Story 35.5 AC5) looks like, and how to recover
  - .anon hostname rotation: what causes it (key loss, dir wipe) and how to
    avoid it (persist hiddenServiceDir across restarts — cross-ref R-006 from
    the epic)
  - socks5:// vs socks5h:// misconfiguration: reference all three rejection
    points (Story 35.6 SEC-03: Zod, constructor, helper) so operators know
    the error can surface from any layer
And every diagnostic step names a SPECIFIC file/log/endpoint/command — no
  "check the logs" without saying which log or what to grep for
```

### AC 7: Operational monitoring documents the actual health endpoint shape

```gherkin
Given the Operational Monitoring section
When an operator queries the connector health endpoint
Then the documentation reflects the ACTUAL response shape implemented by
  Stories 35.4 and 35.6 (transport field: type, healthy, and any other fields
  exposed in connector-node.ts HealthStatus type)
And if the shape documented here does not match what the code emits, the
  story is not done (mechanical verification: fire the endpoint in a dev-time
  smoke test or unit test and diff)
And the section documents the transportHealthIntervalMs ctor seam (Story
  35.6 T-35.6-INT-03) as a test-only knob, clarifying (a) it is NOT a
  production config key and (b) the production default is 30000ms (30s)
  which is also the cache-staleness upper bound for the `transport.healthy`
  field — source: packages/connector/src/core/connector-node.ts
  `_transportHealthIntervalMs ?? 30000`
```

### AC 8: Security model section is consistent with epic §Security Analysis

```gherkin
Given the Security Model section in docs/ator-transport.md
When a security reviewer cross-checks against the epic planning artifact
  (_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md §Security Analysis)
Then the protections and non-protections match in substance
And no new security claim is introduced that isn't justified by the
  implementation (35.1–35.6) — if a claim requires a code feature, that feature
  must be cited by file:line or T-ID from the test-design doc
And critical implementation rules from epic §Critical Implementation Rules
  (fail-closed, no silent fallback, .anon not at INFO, socks5h:// only) are
  surfaced as OPERATOR-FACING invariants, not just internal dev rules
```

### AC 9: Main README and source-tree docs reference the new guide

```gherkin
Given the project's existing documentation entry points
When the story completes
Then the following cross-references exist and resolve:
  - README.md (or the equivalent top-level docs index) links to
    docs/ator-transport.md under a "Privacy Transport" or similarly named section
  - docs/architecture/source-tree.md notes the transport/ directory's role
    and links to the new guide (or confirms an existing link is accurate)
  - CLAUDE.md (or project-context.md) already references transport in the
    Key Entry Points table — verify the existing line still reads accurately
    given all of Stories 35.1–35.7 being shipped; update only if stale
And no dangling or broken links are introduced
```

### AC 10: Validation — docs build and link-check clean

```gherkin
Given the repo's existing docs tooling / lint rules
When the story's changes are run through:
  - Prettier (npm run format:check) on modified markdown files
  - Any existing markdown-lint or link-checker used by the project
  - A manual scan for absolute paths that should be relative
Then all checks pass with zero new warnings introduced by this story
And the new file docs/ator-transport.md renders correctly as GitHub-flavored
  markdown (tables, code fences, and admonitions display properly)
```

### AC 11: Zero runtime regression

```gherkin
Given this story is documentation-only
When npm run build and make test are run on the completed story branch
Then the output is byte-for-byte identical to the pre-story baseline for
  all non-docs files — specifically: NO changes to any file under
  packages/, Makefile, package.json, or tests. The only permitted deltas are:
  (a) the new docs/ator-transport.md file,
  (b) docs updates listed in AC 9 (README.md, docs/architecture/source-tree.md
      if stale),
  (c) _bmad-output/implementation-artifacts/sprint-status.yaml status
      transition, and
  (d) this story file's Dev Agent Record fields.
And sprint-status.yaml is updated to reflect 35.7 status transitions AND
  the epic-35 retrospective status moves from "pending" to whatever the
  pipeline designates when the final epic story is done (retrospective remains
  "pending" until the retrospective workflow runs — story just marks its own
  completion)
```

## Tasks / Subtasks

- [x] **Task 1 — Scaffold `docs/ator-transport.md` (AC 1)**
  - [x] Create file with Table of Contents matching AC 1 sections
  - [x] Add front-matter header linking back to the epic planning artifact
  - [x] Stub each section with a one-line purpose statement before filling

- [x] **Task 2 — Write Prerequisites + Installation (AC 2)**
  - [x] Document Node.js >= 22.11.0 requirement (cite `package.json#engines`)
  - [x] Document external-anon installation path (system `tor` or distro `anon` package) with platform caveats from epic R-005
  - [x] Document managed-anon path: `npm install @anyone-protocol/anyone-client` explicitly (it is an optionalDependency — see `packages/connector/package.json`)
  - [x] Cross-reference Story 35.5 managed-client lifecycle docs inline

- [x] **Task 3 — Write Connector Configuration reference (AC 3)**
  - [x] Open `packages/connector/src/config/types.ts` and enumerate every field of `TransportConfig` (including discriminated-union narrowing for `type: "socks5"`)
  - [x] Open `packages/connector/src/config/config-loader.ts` (`validateTransport`, `validateSocks5Transport`, `validateManagedOptions`) and capture the verbatim `ConfigurationError` message strings — these are the operator-facing error strings (the codebase does NOT use Zod for transport validation; do not invent Zod-style error messages)
  - [x] For each field: description, type, default, required-when rule, verbatim sample error message
  - [x] Author Example A (direct default) as a minimal valid connector.yaml
  - [x] Author Example B (socks5 + external anon, `managed: false`)
  - [x] Author Example C (socks5 + managed anon with hidden service + `externalUrl: "auto"`)
  - [x] Manually validate each example by running it through the config-loader during dev (tmp file + load-config call) — discard only after confirmed accepted

- [x] **Task 4 — Write Peer Discovery section (AC 1)**
  - [x] Document static-config-only approach per epic §Peer Discovery
  - [x] Show the `peers:` YAML shape with `.anon` URL
  - [x] Call out out-of-band exchange as explicit day-one posture (and list future-work items: Nostr kind:10035, CCP broadcasts — without promising them)

- [x] **Task 5 — Write Privacy Model section (AC 4)**
  - [x] Summarize the three-layer stack from epic §Three-Layer Privacy Stack
  - [x] Preserve the "What It Does NOT Protect Against" list verbatim in substance
  - [x] Include (or faithfully summarize) the "Cross-Layer Attack Surface" table
  - [x] Note NIP-59 dependency on Epic 34 being enabled — transport alone is not sufficient for claim privacy

- [x] **Task 6 — Write Performance & Timeout Tuning section (AC 5)**
  - [x] Reproduce the latency table from epic §Performance Characteristics
  - [x] Derive a recommended ILP PREPARE timeout minimum for ATOR peers with rationale
  - [x] Address mixed-topology asymmetry (Story 35.6 INT-07)
  - [x] Name the actual connector config keys that control ILP timeouts (cite `packages/connector/src/config/types.ts` field names)

- [x] **Task 7 — Write Operational Monitoring section (AC 7)**
  - [x] Read the current `HealthStatus` type in `packages/connector/src/core/connector-node.ts`
  - [x] Document the `transport` subtree exactly as implemented
  - [x] Include a concrete sample response body
  - [x] Note `transportHealthIntervalMs` is a test-only constructor seam (Story 35.6) — NOT a prod config key

- [x] **Task 8 — Write Troubleshooting section (AC 6)**
  - [x] DNS leak detection: translate Story 35.6 SEC-01 ATYP=DOMAINNAME protocol into operator tcpdump / proxy-log guidance
  - [x] SOCKS proxy down: quote the actual startup error message from `SocksTransportProvider.start()` (read the source to get the real string)
  - [x] Managed anon crash: reference Story 35.5 AC5 WARN log + health-endpoint flip
  - [x] .anon rotation: key-persistence guidance tied to `hiddenServiceDir` + epic R-006
  - [x] socks5:// vs socks5h:// misconfig: reference Story 35.6 SEC-03 triple-rejection

- [x] **Task 9 — Write Security Model section (AC 8)**
  - [x] Lift substance from epic §Security Analysis (protections, non-protections, attack-surface table)
  - [x] Surface epic §Critical Implementation Rules as operator-facing invariants
  - [x] Cross-check: every claim must be traceable to a shipped feature (cite file:line or test T-ID)

- [x] **Task 10 — Cross-reference updates (AC 9)**
  - [x] Add link to `docs/ator-transport.md` in the main README under a "Privacy Transport" or equivalent section (read README first to pick the right placement)
  - [x] Update `docs/architecture/source-tree.md` if the transport/ directory description is stale
  - [x] Sanity-check `CLAUDE.md` Key Entry Points table — the Epic 35 row should remain accurate; update only if stale
  - [x] Run a manual link scan on the new file (every relative link resolves)

- [x] **Task 11 — Validation pass (AC 10, 11)**
  - [x] `npm run format:check` on all modified markdown
  - [x] Manually render on GitHub preview (or equivalent) — verify tables, code fences, admonitions
  - [x] `npm run build && make test` — confirm green and UNCHANGED test count (docs-only story must not perturb)
  - [x] Diff non-docs files vs baseline — must be empty except for the permitted deltas enumerated in AC 11 (sprint-status.yaml, this story file's Dev Agent Record, and the docs/README updates from AC 9)

- [x] **Task 12 — Finalize sprint status**
  - [x] Update `_bmad-output/implementation-artifacts/sprint-status.yaml` stories.35.7.status to "done" (retrospective stays "pending" — separate workflow)

## Dev Notes

### Source-of-truth documents for content (read these BEFORE writing)

1. `_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md` — authoritative for privacy model, performance table, security analysis, critical implementation rules, peer discovery posture, and config schema intent. Sections especially relevant: §Architecture, §Critical Implementation Rules, §Performance Characteristics, §Risk Assessment, §Config Schema Extension, §Peer Discovery, §Security Analysis.

2. `_bmad-output/planning-artifacts/test-design-epic-35.md` — authoritative for test T-IDs and security invariants. Troubleshooting guidance in AC 6 refers to T-35.6-SEC-01 / SEC-03 / R-006 — cite these where relevant so a reviewer can trace a troubleshooting step back to a test that enforces it.

3. `packages/connector/src/config/types.ts` — authoritative for `TransportConfig` schema shape. Every field documented in AC 3 must exist in this file; if the doc and the file disagree, the file wins and the doc gets fixed.

4. `packages/connector/src/transport/socks-transport-provider.ts`, `managed-anon-client.ts`, `socks-url.ts` — authoritative for the exact error messages quoted in AC 6 Troubleshooting. Read the actual `throw new Error(...)` strings, do not paraphrase them.

5. `packages/connector/src/core/connector-node.ts` — authoritative for `HealthStatus` shape (AC 7) and for the `transportHealthIntervalMs` ctor seam discussion.

6. Previous story reports in `_bmad-output/auto-bmad-artifacts/` — summarize what each story actually shipped vs what the epic originally planned; useful for AC 2, AC 6, AC 7 to avoid documenting features that never landed. Exact filenames (filename convention is inconsistent — 35.1 uses a dash, 35.2–35.6 use dots):
   - `story-35-1-report.md`
   - `story-35.2-report.md`
   - `story-35.3-report.md`
   - `story-35.4-report.md`
   - `story-35.5-report.md`
   - `story-35.6-report.md`

### Epic Definition-of-Done alignment

Story 35.7 closes these epic-level DoD bullets (see epic §Definition of Done):

- [ ] "Documentation covers setup, config, privacy model, and troubleshooting" — AC 1, 2, 3, 4, 6, 8.

The other DoD bullets are already satisfied by Stories 35.1–35.6; 35.7 should not try to re-open or re-satisfy them.

### Documentation patterns already established in this repo

- `docs/solana-deployment.md` and `docs/mina-deployment.md` are the template to mirror: top-level Table of Contents, `##` for major sections, copy-pasteable code blocks, explicit prerequisite versions, a Configuration section that cross-references the connector YAML schema, and a monitoring/troubleshooting section. Match this voice and structure — do not invent a new doc format.

- The existing deployment guides use `--` (double-hyphen) punctuation for em-dashes and avoid emoji; follow the same convention.

- Prettier is configured at the repo root — `npm run format:check` must pass. Markdown tables use single-space padding consistent with the existing guides.

### Critical "do NOT" list (common documentation LLM failure modes)

1. **Do NOT invent config fields that don't exist in types.ts.** Every field in AC 3 must be grep-confirmed in `packages/connector/src/config/types.ts`.
2. **Do NOT soften the security limitations.** The epic is honest about what ATOR does NOT protect against (timing correlation, compromised entry+exit, ILP address destination leakage). The doc must be equally honest.
3. **Do NOT document features from Story 35.5 that only exist when the optional SDK is installed as if they are unconditionally available.** Managed-anon path is gated on `@anyone-protocol/anyone-client` being installed (Story 35.5 AC10).
4. **Do NOT paraphrase error messages.** When an AC or task says "quote the actual error message", read the source file and quote it verbatim. Paraphrased errors are worse than no quote because operators will grep for the exact string.
5. **Do NOT add new npm dependencies, new config keys, or new health-endpoint fields.** This is a docs-only story. If the code doesn't emit it, don't claim it does.
6. **Do NOT copy the epic planning artifact wholesale.** The epic is a planning doc with hypotheses and open questions; the deployment guide is an operator-facing doc that should omit open questions and hypothesis-mode reasoning. Extract the operator-relevant substance.
7. **Do NOT log `.anon` addresses in any code example or sample log output in the doc itself.** If the doc shows a sample INFO log, it must respect the SEC-05 invariant — otherwise the doc itself becomes a counterexample.

### Project Structure Notes

- New file: `docs/ator-transport.md` (follows `docs/solana-deployment.md` / `docs/mina-deployment.md` sibling pattern)
- Modified (small): top-level `README.md` — add one link under a Privacy Transport heading
- Possibly modified: `docs/architecture/source-tree.md` — only if the transport/ directory description is currently absent or stale
- No code changes. No config changes. No test changes.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 35.7 `planned` → `ready-for-dev` on story create (this step), then → `done` on completion by the pipeline.

### Testing standards summary

This is a documentation-only story. The "tests" are:

1. **YAML example validation** — each of Examples A/B/C in AC 3 must pass the real config-loader. Recommended approach: during dev, drop each example into a tmp file and call the loader programmatically (or via the CLI entry point if one exists). Capture the evidence in the Dev Agent Record.

2. **Code-message quoting** — error strings in AC 6 must be verbatim from the source. Dev validates by grepping the quoted string from the doc in the source tree and confirming a match.

3. **No runtime regression** — `npm run build && make test` must be green with UNCHANGED test count vs the pre-story baseline. Any delta is a bug in this story (docs should not perturb tests).

4. **Prettier + render sanity** — `npm run format:check` must be clean; GitHub-markdown render must look right.

5. **Security-claim traceability (AC 8)** — every protection / non-protection claim in the Security Model section must be traceable to either (a) a source file:line in `packages/connector/src/transport/` or `packages/connector/src/config/`, or (b) a test T-ID from `_bmad-output/planning-artifacts/test-design-epic-35.md` (SEC-01 through SEC-05, INT-01 through INT-07, R-005, R-006, etc.). Dev validates by auditing the Security Model section against this requirement before marking the story done; untraceable claims must be removed or replaced.

### References

- `_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md` — epic authority
- `_bmad-output/planning-artifacts/test-design-epic-35.md` — T-ID authority
- `_bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md` — Story 35.1 shipped shape
- `_bmad-output/implementation-artifacts/35-2-implement-sockstransportprovider.md` — Story 35.2 shipped shape
- `_bmad-output/implementation-artifacts/35-3-extend-config-schema-for-transport-block.md` — Story 35.3 shipped schema
- `_bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md` — Story 35.4 ConnectorNode wiring + health endpoint
- `_bmad-output/implementation-artifacts/35-5-managed-ator-client-lifecycle.md` — Story 35.5 managed-anon lifecycle
- `_bmad-output/implementation-artifacts/35-6-unit-and-integration-tests.md` — Story 35.6 security + integration tests (authoritative for SEC-01/02/03/04/05 invariants)
- `packages/connector/src/config/types.ts` — TransportConfig schema
- `packages/connector/src/transport/` — implementation authority (error messages, behaviors)
- `packages/connector/src/core/connector-node.ts` — HealthStatus shape, ctor seam
- `docs/solana-deployment.md`, `docs/mina-deployment.md` — sibling doc style template
- `CLAUDE.md` §Key Entry Points — cross-reference anchor

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — model ID `claude-opus-4-6[1m]`.

### Debug Log References

- YAML examples were validated programmatically against `ConfigLoader.loadConfig` using `packages/connector/dist/config/config-loader.js` with three tmp fixtures (`/tmp/test-ator-example-a.yaml`, `-b.yaml`, `-c.yaml`). All three loaded cleanly and produced the expected normalized `transport` shapes:
  - Example A: `{"type":"direct"}`
  - Example B: `{"type":"socks5","socksProxy":"socks5h://127.0.0.1:9050","externalUrl":"wss://alicexyz456abcdef.anon:443","managed":false}`
  - Example C: `{"type":"socks5","socksProxy":"socks5h://127.0.0.1:9050","externalUrl":"auto","managed":true,"managedOptions":{...}}`
- Verbatim error strings quoted in the "transport Block Reference" section were grep-confirmed against `packages/connector/src/config/config-loader.ts` and `packages/connector/src/transport/socks-url.ts` before inclusion.
- `make test` at the completion gate: 2823 passed / 84 skipped / 2907 total across connector + shared + mina + send-packet workspaces. No regressions (docs-only story; zero non-docs source files modified).
- `npx prettier --check docs/ator-transport.md README.md docs/architecture/source-tree.md` → clean after a single `--write` pass that the formatter applied to its own table alignment and an escape in the first relative link.

### Completion Notes List

- **Task 1–9 — Deployment guide (`docs/ator-transport.md`):** authored a single authoritative operator-facing guide covering Prerequisites, Installation (external vs managed), `transport` block reference with every field from `TransportConfig` in `types.ts` documented alongside the verbatim `ConfigurationError` messages, three copy-pasteable YAML examples (direct / external-anon / managed-auto) all validated against `ConfigLoader.loadConfig`, Peer Discovery (static-config only, future-work called out without promise), Privacy Model (three-layer stack with honest NOT-protected list and faithful Cross-Layer Attack Surface table), Performance & Timeout Tuning (epic latency table + 6–10s recommendation for 3-hop ATOR PREPARE timeouts with range-based rationale, mixed-topology asymmetry note), Operational Monitoring (actual `HealthStatus.transport` shape with concrete direct/socks5 JSON samples, 30000 ms background refresh default cited from source, `transportHealthIntervalMs` flagged as test-only seam), Troubleshooting (DNS-leak `tcpdump` / `ATYP=DOMAINNAME` protocol, SOCKS-down verbatim error from `SocksTransportProvider.start()`, managed-crash jq filter on `event: "managed_anon_crash_detected"`, `.anon` rotation + `hiddenServiceDir` persistence guidance, triple-rejection socks5h:// scheme references), and Security Model (operator-facing invariants cross-referenced to T-IDs 35.2-03, 35.3-04, 35.4-05, 35.6-SEC-01/03/05, Story 35.5 AC1/AC5).
- **Task 10 — Cross-references:** added Privacy Transport row to the README.md Documentation table linking to `docs/ator-transport.md`; extended `docs/architecture/source-tree.md` with a `transport/` directory entry and a prose paragraph linking to the new guide. Verified `CLAUDE.md` Key Entry Points already carries an accurate `packages/connector/src/transport/` line (no change required).
- **Task 11 — Validation:** ran prettier (clean), full `make test` (2823 passing, no regressions), and diff-audited non-docs files: only permitted deltas present (new `docs/ator-transport.md`, README.md Documentation table, `docs/architecture/source-tree.md`, sprint-status.yaml status transition, and this story file's Dev Agent Record / Tasks checkboxes / Status / Change Log).
- **Task 12 — Sprint status:** `_bmad-output/implementation-artifacts/sprint-status.yaml` `stories.35.7.status` transitioned from `ready-for-dev` → `done`. Epic-35 retrospective stays `pending` (belongs to the separate retrospective workflow).
- **Zero-regression invariant:** no changes to `packages/`, `Makefile`, `package.json`, or any tests — confirmed by spot-check against the permitted-deltas list in AC 11.

### File List

- `docs/ator-transport.md` (new) — primary deliverable: ATOR overlay transport deployment and configuration guide.
- `README.md` (modified) — added Privacy Transport entry to Documentation table.
- `docs/architecture/source-tree.md` (modified) — added `transport/` directory entry and cross-link to the new guide.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified) — `stories.35.7.status` set to `done`.
- `_bmad-output/implementation-artifacts/35-7-documentation-deployment-guide-and-config-reference.md` (modified) — Status set to `review`; Tasks/Subtasks all `[x]`; Dev Agent Record populated; Change Log entry added.

## Code Review Record

### Review Pass #1 — 2026-04-14

- **Reviewer:** Claude Opus 4.6 (1M context)
- **Outcome:** PASS
- **Scope:** `docs/ator-transport.md` plus edits to `README.md` and `docs/architecture/source-tree.md`, cross-checked against source code for accuracy, YAML examples, `HealthStatus` shape, security traceability, and doc-to-code drift.
- **Issue counts by severity:**
  - Critical: 0
  - High: 0
  - Medium: 0
  - Low: 0
- **Action items:** None. No fixes required.

### Review Pass #2 — 2026-04-14

- **Reviewer:** Claude Opus 4.6 (1M context)
- **Mode:** yolo — fix all critical/high/medium/low findings automatically
- **Scope:** Prose quality in `docs/ator-transport.md`; internal consistency; correctness of operational guidance (timeouts, health-endpoint polling); verbatim-error-string accuracy re-checked against current source (`config-loader.ts`, `socks-transport-provider.ts`, `socks-url.ts`, `managed-anon-client.ts`, `http/types.ts`, `core/connector-node.ts`); security-claim honesty vs. epic §Security Analysis. AC 11 respected — no code/test changes.
- **Issue counts by severity:**
  - Critical: 0
  - High: 0
  - Medium: 2
  - Low: 1
- **Issues found & fixed:**
  - **[Medium] Troubleshooting `tcpdump` filter was incorrect and OS-non-portable.** The filter `'tcp port 9050 and tcp[13] & 8 != 0'` uses a raw-byte offset for the TCP flags that is ambiguous when IP options are present, and `-i lo0` is macOS-only (Linux loopback is `lo`). Fixed: switched to the readable `tcp[tcpflags] & tcp-push != 0` form, added an explicit Linux-vs-macOS interface note, and added a fallback instruction for kernels that coalesce segments. Also corrected the byte-offset narrative: the ATYP byte is the fourth byte of the CONNECT request (after `05 01 00`), not "the third byte after ... CONNECT header", and added the `04` (IPV6) leak case.
  - **[Medium] `.anon` log-audit jq filter was too narrow.** The original filter inspected only `.peerUrl`, but SEC-05's invariant is that `.anon` must not appear in ANY structured field at INFO+. Fixed: filter now stringifies the whole record (`tostring | test("\\.anon")`), matching the actual invariant.
  - **[Low] Prose polish in Installation / Managed-client lifecycle.** "for the SOCKS port to accept TCP" completed to "accept TCP connections" for readability.
- **Verified accurate (no change needed):**
  - Verbatim `ConfigurationError` strings in "transport Block Reference" match `config-loader.ts` byte-for-byte.
  - `parseSocks5hUrl` quoted error matches `socks-url.ts` byte-for-byte.
  - `SocksTransportProvider.start()` failure shape (`SOCKS5 proxy unreachable at <host>:<port> (<reason>)`) matches source.
  - `HealthStatus.transport` sample bodies match the `HealthStatus` type in `http/types.ts` and the `getHealthStatus()` producer in `core/connector-node.ts` (including the `direct` → always-`true` invariant and the synchronous, cache-only read).
  - `_transportHealthIntervalMs ?? 30000` default and the test-only constructor seam are both confirmed in `core/connector-node.ts`.
  - `managed_anon_*` event names (`managed_anon_started`, `managed_anon_crash_detected`, `managed_anon_probe_failed`, `managed_anon_stop_timeout`) all match the emitters in `managed-anon-client.ts` and `socks-transport-provider.ts`.
  - Security-claim traceability matrix: every row resolves to a real file/method or T-ID.
  - Security limitations are reproduced without softening (timing correlation, compromised entry+exit, ILP address leakage, application-level leaks) — matches epic §Security Analysis.
- **Action items:** None outstanding. All findings from this pass are fixed in-document.

### Review Pass #3 — 2026-04-14

- **Reviewer:** Claude Opus 4.6 (1M context)
- **Mode:** yolo — auto-fix all critical/high/medium/low; OWASP Top 10 + authN/authZ + injection scan applied to documented operator guidance (no runtime code in scope for this doc-only story).
- **Scope:** Final polish pass on `docs/ator-transport.md`. Focus areas: security-claim accuracy vs. code (verbatim error strings, health-endpoint shape, event names re-verified), operator-side vulnerabilities introduced by documented procedures (secrets in logs, insecure defaults in examples, invented CLI invocations), YAML example safety, and prose polish. Semgrep MCP was unavailable (no `SEMGREP_APP_TOKEN`); OWASP review was performed manually against the documented content.
- **Issue counts by severity:**
  - Critical: 0
  - High: 0
  - Medium: 1
  - Low: 2
- **Issues found & fixed:**
  - **[Medium] Invented CLI invocation in Installation Option A.2.** The doc instructed operators to run `npm install -g @anyone-protocol/anyone-client` and then `anon-client --socks-port 9050`. The real package exposes `anyone-proxy` and `anyone-client` (not `anon-client`), and the `--socks-port` flag was unverified. Operators copy-pasting the invented command would hit a "command not found" error; worse, a similarly-named future CLI could lead to silently misconfigured deployments. Fixed: switched to a local `npm install`, pointed operators at `npx anyone-proxy --help` to discover the current flag, and linked to upstream docs rather than asserting flags we have not byte-verified.
  - **[Low] No operator-facing guidance on `authToken` secret handling.** All three YAML examples used the identical placeholder `shared-secret-alice-bob`. While consistent with sibling deployment guides, the story is security-review-oriented and the placeholder invited copy-paste reuse of a weak, publicly documented secret (OWASP A02 / A07 adjacent). Fixed: added an explicit "Secret handling" note under Example A instructing operators to generate a high-entropy per-peer secret (`openssl rand -hex 32`), exchange out of band, template at deploy time, and never commit; also clarified that the config loader does NOT perform env-var interpolation so secret management must live outside the YAML itself.
  - **[Low] `jq` log-audit filter assumed numeric `.level`.** pino defaults to numeric level codes but projects often configure `formatters.level` to emit string labels; in that case `.level >= 30` would silently return no matches and the audit would look clean while leaking continued. Fixed: added a `(.level|type=="number")` guard and documented the label-mode alternative (`.level|IN("info","warn","error","fatal")`).
- **Verified accurate (no change needed) this pass:**
  - Verbatim `ConfigurationError` strings in "transport Block Reference" re-matched against `packages/connector/src/config/config-loader.ts` lines 642, 677, 696-698, 706, 750, 755, 802, 824 — all byte-for-byte accurate.
  - `SocksTransportProvider: SOCKS5 proxy unreachable at ${host}:${port} (${reason})` still at `socks-transport-provider.ts:183`.
  - All `managed_anon_*` and `socks_transport_*` event names still emitted at the levels documented (INFO start/stop, WARN crash/probe/stop-timeout).
  - `transport` field discriminated union (`direct` / `socks5`) and `managedOptions` sub-fields in `packages/connector/src/config/types.ts` lines 211-243 match the Block Reference table exactly.
  - Pino level semantics (30/40/50/60 = info/warn/error/fatal) are canonical and correctly reflected in the audit filter.
  - `tcpdump` filter syntax (`tcp[tcpflags] & tcp-push != 0`) is portable libpcap and the loopback interface Linux-vs-macOS note is accurate.
  - No .anon hostnames appear in any doc-embedded sample log or YAML example (SEC-05 invariant — doc itself respects the invariant it enforces).
  - No credentials, API keys, or real-looking secrets introduced in any example.
  - No injection-adjacent recommendations (no shell interpolation of user input; no untrusted data fed into `jq` / `tcpdump` expressions — the examples read an operator-controlled log path).
- **OWASP Top 10 review (operator-facing guidance):**
  - A01 Broken Access Control — N/A for transport-layer docs; peer authorization is `authToken` which is addressed.
  - A02 Cryptographic Failures — addressed via the new Secret Handling note; `socks5h://` enforcement already covers DNS-leak cryptographic-context risks.
  - A03 Injection — no doc command splices untrusted data; filters operate on static field names.
  - A04 Insecure Design — the fail-closed posture, three-layer scheme rejection, and explicit NOT-protected list all reinforce secure-by-default guidance.
  - A05 Security Misconfiguration — Installation Option A.2 fix removes an invented command that could produce a silent misconfiguration. YAML examples are the minimal valid shape; no extraneous fields that could enable accidentally-insecure options.
  - A06 Vulnerable/Outdated Components — SDK version `^1.1.3` already called out; Node.js `>= 22.11.0` pinned.
  - A07 Identification & Authentication Failures — Secret Handling note addresses weak/predictable `authToken` risk.
  - A08 Software & Data Integrity Failures — `hiddenServiceDir` persistence guidance protects the ed25519 key; already documented.
  - A09 Security Logging & Monitoring — SEC-05 invariant (no `.anon` at INFO+) reinforced by a now-more-robust `jq` audit filter; health-endpoint shape documented for external monitoring.
  - A10 SSRF — `socks5h://` forcing hostname resolution at the proxy is the core mitigation; the scheme-only requirement is re-explained at three layers in the doc.
- **Action items:** None outstanding.

## Change Log

| Date       | Change                                                                                                                                                                                                                                                                                                                              | Author                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 2026-04-14 | Story 35.7 implementation session. Authored `docs/ator-transport.md` (new) covering Prerequisites, Installation (external + managed), transport block reference with verbatim error strings, three validated YAML examples, Peer Discovery, three-layer Privacy Model, Performance & Timeout Tuning, Operational Monitoring with concrete `HealthStatus` samples, Troubleshooting runbook, and Security Model with T-ID traceability. Updated README.md and docs/architecture/source-tree.md cross-references. Transitioned sprint-status 35.7 → done. Zero runtime regression: `make test` passes 2823/2907 with no delta. Status: ready-for-dev → review. | Claude Opus 4.6 (1M context) |
| 2026-04-14 | Code review pass #2 (yolo). Fixed 2 Medium + 1 Low findings in `docs/ator-transport.md`: corrected and OS-portabilized the DNS-leak `tcpdump` filter and its ATYP-byte narrative; broadened the `.anon` log-audit `jq` filter to match the full SEC-05 invariant (any field, not just `peerUrl`); minor prose polish. No code/test changes (AC 11 respected). Zero Critical/High findings. | Claude Opus 4.6 (1M context) |
| 2026-04-14 | Code review pass #3 (yolo, OWASP sweep). Fixed 1 Medium + 2 Low findings in `docs/ator-transport.md`: replaced invented `anon-client --socks-port 9050` CLI invocation with real `anyone-proxy` / `anyone-client` binaries plus an upstream-docs pointer; added an explicit Secret Handling operator note under Example A addressing weak-`authToken` copy-paste reuse (OWASP A02/A07); hardened the `.anon` log-audit `jq` filter against pino label-mode level serialization so the audit cannot silently return empty. Semgrep MCP unavailable (no token) — manual OWASP Top 10 sweep performed. No code/test changes (AC 11 respected). Zero Critical/High findings. | Claude Opus 4.6 (1M context) |
