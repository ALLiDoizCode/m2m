# Connector Release Contract

> **Historical — describes the retired TypeScript connector.** Its source, its
> `.releaserc.json`, and the `release.yml` / `build-and-publish.yml` pipelines
> referenced below were removed by ADR
> [0017](docs/adr/0017-the-typescript-connector-is-a-prototype.md). Already-published
> `@toon-protocol/connector` versions and `ghcr.io/toon-protocol/connector` tags are
> unaffected and the guarantees below still hold for them. The Rust connector's image
> is published by `.github/workflows/publish-connector-rust-image.yml` to that same
> `ghcr.io/toon-protocol/connector` package, under `rust-sha-<short>` and `rust-main`
> tags (#645, #989; the separate `ghcr.io/toon-protocol/connector-rust`
> package it used to write to is retired and receives no new builds). A third tag,
> `rust-release`, is not published by that workflow: it is the devnet fleet's promotion
> tag, moved only by `.github/workflows/promote-to-fleet.yml` after a validation gate
> (ADR 0041). It does not yet have a written contract.
>
> The Rust image does now have a **release series**, and it deliberately is not the one
> described below. `.github/workflows/release-connector.yml` (ADR
> [0055](docs/adr/0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md)) cuts a
> **monotonic handle** — `2026.08.21.1`, a UTC date and that day's ordinal — published as a
> GitHub Release and as an immutable `rust-<handle>` image alias. It is not semver, for the
> reason `deploy/connector-rust/README.md` gives: every crate under `crates/` is `0.1.0`
> with no release process, and a semver series would claim exactly the stability contract
> this document describes for an image that no longer exists. The one guarantee below that
> the handle **does** keep is label correctness: `org.opencontainers.image.version` on a
> released manifest equals the handle it was cut under, so `docker inspect` on a box
> answers "which release is this?". Nothing else here binds the Rust image: there is no
> cosign signature, no npm artifact, and no API-stability promise.

This document describes the supply-chain guarantees the connector project makes
about its published artifacts (npm package and GHCR container image), and the
recommended pinning strategy for downstream consumers.

## Artifacts

Each release publishes two artifacts:

| Artifact        | Location                                                       | Architectures                                                      |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| npm package     | `@toon-protocol/connector` on npmjs.com                        | n/a (pure JS)                                                      |
| Container image | `ghcr.io/toon-protocol/connector` on GitHub Container Registry | `linux/amd64`, `linux/arm64` (from the first release after PR #63) |

Releases are cut by [semantic-release](https://github.com/semantic-release/semantic-release)
on every push to `main`, when the conventional-commit history warrants a version
bump. The release pipeline is defined in `.github/workflows/release.yml`.

Multi-arch images (`linux/amd64` + `linux/arm64`) ship from the first release after PR [#63](https://github.com/toon-protocol/connector/pull/63); adding architectures is a build-only change (no semver bump). Removing an architecture is a breaking change requiring a MAJOR bump.

## Stability guarantees

For releases cut **after** PR [#60](https://github.com/toon-protocol/connector/pull/60)
merged (i.e. the first release cut from a connector main containing the
`docker-release` `ref: main` checkout fix):

- **Container image, semver tag → digest stability:** the digest a semver tag
  resolves to (e.g. `ghcr.io/toon-protocol/connector:3.5.1`) is stable for the
  lifetime of that tag. Releases never reuse a previously-published version
  number, so a given `vX.Y.Z` tag points to a single digest forever.
- **Container image, label correctness:** the
  `org.opencontainers.image.version` label on the manifest equals the semver
  tag the image was published under. This is enforced by a post-publish
  assertion in the release workflow that fails the run on mismatch.
- **npm package, version stability:** `@toon-protocol/connector@X.Y.Z` is
  immutable on npmjs.com per npm's package-management rules.

## API stability

The connector's HTTP admin API surface (everything under `/admin/*`) follows
strict semver discipline. The rules below tell consumers what kind of
version bump to expect for any change.

| Change                                     | Bump  | Example                  |
| ------------------------------------------ | ----- | ------------------------ |
| `/admin/*` field addition                  | MINOR | `v3.3.x → v3.4.0`        |
| `/admin/*` field rename or removal         | MAJOR | `v3.x → v4.0`            |
| `/admin/*` endpoint addition               | MINOR | `v3.3.x → v3.4.0`        |
| `/admin/*` endpoint rename or removal      | MAJOR | `v3.x → v4.0`            |
| ILP packet wire-format change              | MAJOR | `v3.x → v4.0`            |
| Image architecture addition (e.g. `arm64`) | none  | build-only change        |
| Image architecture removal                 | MAJOR | breaks pinning consumers |

### Connector pin discipline

Connector pins the connector image **by digest** in
`packages/connector/dist/image-manifest.json` (built by the publish
workflow — Story 45.1). Each MINOR connector release triggers a manual
digest-pin bump in connector, gated on the contract canary
(`pnpm --filter @toon-protocol/sdk test:integration -- tests/integration/connector-contract.test.ts`)
passing at the new digest. Patch releases (`vX.Y.z → vX.Y.z+1`) do not
require a connector bump unless the patch fixes a behavior connector
actively relied on being broken. Major bumps require a deliberate
connector migration cycle and a CONNECTOR_MIGRATION.md row.

## Supply-chain signing

Starting from `v3.6.0` (cut after PR [#66](https://github.com/toon-protocol/connector/pull/66) merged), every connector image is cosign-signed via **keyless OIDC** — no static keys, no secrets beyond the default `GITHUB_TOKEN`.

### Verifying a release image

```bash
# Connector
DIGEST=$(docker buildx imagetools inspect ghcr.io/toon-protocol/connector:<tag> \
  --format '{{ json .Manifest }}' | jq -r '.digest')

cosign verify "ghcr.io/toon-protocol/connector@${DIGEST}" \
  --certificate-identity-regexp \
    'https://github\.com/toon-protocol/connector/\.github/workflows/(build-and-publish|release)\.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

Expected output: `Verification for ... -- The following checks were performed: ... certificate identity is ...` and exit 0.

### Notes

- Signatures cover the **multi-arch manifest index digest** (not per-platform sub-manifests). Verifying against the index digest is sufficient; `docker pull <image>@<index-digest>` resolves to the correct per-platform sub-manifest at pull time.
- Each signature is **automatically published to the [Sigstore Rekor transparency log](https://rekor.sigstore.dev)**. `cosign verify` consults the log automatically — no separate flag is needed.
- The signing certificate's SAN encodes the exact workflow path (e.g. `https://github.com/toon-protocol/connector/.github/workflows/build-and-publish.yml@refs/tags/v3.6.0`). The `--certificate-identity-regexp` flag is required; omitting identity flags causes cosign to reject the verification — by design.
- The `(build-and-publish|release)\.yml` regex tolerates both signers: `release.yml` fires on the merge-commit-to-main and `build-and-publish.yml` fires on the tag push. Both produce valid signatures on the same digest.

## Recommended pinning strategy

For maximum supply-chain integrity, **pin by content digest** rather than by
semver tag:

```
ghcr.io/toon-protocol/connector@sha256:<digest>
```

Digest pinning gives byte-for-byte reproducibility regardless of any future
tag-pointer changes (re-tagging, deletion, or registry compromise). Combined with [Supply-chain signing](#supply-chain-signing), digest pinning is verifiable end-to-end.

For non-production use where tag mutability is acceptable, semver tags
(`:3.5.1`, `:3.5`, `:3`, `:latest`) are produced by `docker/metadata-action`
and follow standard semver-tag floating semantics.

## Staying current

Downstream consumers (notably `toon-protocol/town`'s connector package)
learn about new connector releases via:

1. **GitHub UI subscription** — preferred: `Watch → Custom → Releases` on
   `toon-protocol/connector`. Releases-only is a UI-side filter the REST API does
   not expose.
2. **`gh` CLI subscription** — fallback: subscribes to all repository events
   (not releases-only):
   ```bash
   gh api -X PUT /repos/toon-protocol/connector/subscription \
     -f subscribed=true -f ignored=false
   ```

Automated subscription (e.g. a GitHub Actions cron polling `gh release
view` and opening a digest-bump PR into connector) is OUT OF SCOPE for
v1 and tracked as Open Thread #2 in the Connector HS-Mode v1 epic.

## Historical tag corruption (releases prior to first post-#60 release)

A bug in `docker-release` (introduced when the job was added in PR [#45](https://github.com/toon-protocol/connector/pull/45),
fixed in PR [#60](https://github.com/toon-protocol/connector/pull/60)) caused
`actions/checkout` to resolve the workflow trigger SHA — the _parent_ of the
`chore(release): X.Y.Z [skip ci]` commit semantic-release creates — instead of
`main`'s tip. As a result, `git describe --tags --abbrev=0` returned the
_previous_ release's tag, and `docker/build-push-action` silently overwrote
that tag's GHCR pointer with the new release's content.

**Net effect:** every semver-tagged GHCR image published between PR #45 and
PR #60 carries content one release _ahead_ of what its tag and
`org.opencontainers.image.version` label claim. The corruption is upward
(newer content under older label), so consumers of these tags are not running
stale code — but the tag-to-content mapping is unreliable for audit and
compliance purposes.

The `:latest`, `:<major>` (e.g. `:3`), and commit-SHA (e.g. `:f87d7b9`) tags
are not affected, because `docker/metadata-action` derives them from
out-of-band sources rather than the broken `git describe` value.

| GHCR tag | Label `org.opencontainers.image.version` | Manifest revision (commit)                                                      | Actual release contents                |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `:3.4.2` | `3.4.2`                                  | `f87d7b9b` (PR [#59](https://github.com/toon-protocol/connector/pull/59) merge) | **v3.5.0**                             |
| `:3.4.1` | `3.4.1`                                  | `541a38ee` (PR [#57](https://github.com/toon-protocol/connector/pull/57) merge) | **v3.4.2**                             |
| `:3.4.0` | `3.4.0`                                  | `5059807a` (PR [#55](https://github.com/toon-protocol/connector/pull/55) merge) | **v3.4.1**                             |
| `:3.3.3` | `3.3.3`                                  | `c0068b4a`                                                                      | **v3.4.0**                             |
| `:3.3.2` | `3.3.2`                                  | `2bed61c2`                                                                      | one release ahead                      |
| `:3.3.1` | `3.3.1`                                  | `96be4e78`                                                                      | one release ahead                      |
| `:3.3.0` | `3.3.0`                                  | `057b332c` (PR [#45](https://github.com/toon-protocol/connector/pull/45) merge) | first release with this workflow shape |

**No semver tag exists for v3.5.0** — the build that should have been published
under `:3.5.0` was published under `:3.4.2` instead. Consumers needing v3.5.0
content must pin by digest (the same digest currently at `:3.4.2` and
`:latest`) until the next release after PR #60 fires, which will be the first
cleanly-tagged release.

Historical tags will not be re-tagged or backfilled; doing so would silently
swap content under tags some consumers may already be pinning, with
unpredictable blast radius. From the first post-#60 release forward, the
guarantees in [Stability guarantees](#stability-guarantees) apply.

## Verification

Three mechanisms guard against future tag-vs-content drift:

1. **Pre-publish (issue [#61](https://github.com/toon-protocol/connector/issues/61) /
   PR [#60](https://github.com/toon-protocol/connector/pull/60)):** the
   `docker-release` job checks out `main`'s tip so `git describe` resolves to
   the just-cut tag, mirroring the same fix applied to `npm-release` in PR
   [#48](https://github.com/toon-protocol/connector/pull/48).
2. **Post-publish (issue [#61](https://github.com/toon-protocol/connector/issues/61)):**
   after `docker/build-push-action`, the workflow inspects the just-pushed
   manifest with `docker buildx imagetools inspect` and asserts that
   `org.opencontainers.image.version` equals the tag. Any mismatch fails the
   workflow run.
3. **Town mirror drift detection:** The doc body is mirrored at
   `packages/sdk/CONNECTOR_RELEASE_CONTRACT.md` in `toon-protocol/town`.
   The town copy prepends a 3-line comment header; verify body equivalence
   from the `toon-protocol/connector` repo root (with `toon-protocol/town`
   cloned alongside as a sibling directory, e.g. `../town`):

   ```bash
   diff CONNECTOR_RELEASE_CONTRACT.md \
        <(tail -n +4 ../town/packages/sdk/CONNECTOR_RELEASE_CONTRACT.md)
   ```

   Expected output: empty. Any diff is a drift defect — open a follow-up PR in
   both repos to restore equivalence.

## References

- Issue [#61](https://github.com/toon-protocol/connector/issues/61) — historical
  GHCR tag corruption analysis and remediation options
- PR [#60](https://github.com/toon-protocol/connector/pull/60) —
  `docker-release` `ref: main` fix
- PR [#48](https://github.com/toon-protocol/connector/pull/48) — earlier
  `npm-release` fix for the same class of bug
- [PR #66 — cosign keyless OIDC signing](https://github.com/toon-protocol/connector/pull/66) (Story 44.3)
- Connector Story 44.4 — downstream consumer-facing release contract
- [Interledger Protocol V4 (RFC 0027)](https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md) — defines the ILP packet wire format referenced by the MAJOR-bump rule in [API stability](#api-stability)
