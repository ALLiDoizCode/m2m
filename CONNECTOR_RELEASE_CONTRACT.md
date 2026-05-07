# Connector Release Contract

This document describes the supply-chain guarantees the connector project makes
about its published artifacts (npm package and GHCR container image), and the
recommended pinning strategy for downstream consumers.

## Artifacts

Each release publishes two artifacts:

| Artifact        | Location                                                       | Architectures                                                      |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| npm package     | `@toon-protocol/connector` on npmjs.com                        | n/a (pure JS)                                                      |
| Container image | `ghcr.io/toon-protocol/connector` on GitHub Container Registry | `linux/amd64`, `linux/arm64` (from the first release after PR #62) |

Releases are cut by [semantic-release](https://github.com/semantic-release/semantic-release)
on every push to `main`, when the conventional-commit history warrants a version
bump. The release pipeline is defined in `.github/workflows/release.yml`.

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

## Recommended pinning strategy

For maximum supply-chain integrity, **pin by content digest** rather than by
semver tag:

```
ghcr.io/toon-protocol/connector@sha256:<digest>
```

Digest pinning gives byte-for-byte reproducibility regardless of any future
tag-pointer changes (re-tagging, deletion, or registry compromise). Cosign
signing of release artifacts (tracked in townhouse Story 44.3) makes this
pinning strategy verifiable end-to-end.

For non-production use where tag mutability is acceptable, semver tags
(`:3.5.1`, `:3.5`, `:3`, `:latest`) are produced by `docker/metadata-action`
and follow standard semver-tag floating semantics.

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

Two mechanisms guard against future tag-vs-content drift:

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

## References

- Issue [#61](https://github.com/toon-protocol/connector/issues/61) — historical
  GHCR tag corruption analysis and remediation options
- PR [#60](https://github.com/toon-protocol/connector/pull/60) —
  `docker-release` `ref: main` fix
- PR [#48](https://github.com/toon-protocol/connector/pull/48) — earlier
  `npm-release` fix for the same class of bug
- Townhouse Story 44.3 — cosign signing of release artifacts
- Townhouse Story 44.4 — downstream consumer-facing release contract
