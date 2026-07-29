# =============================================================================
# connector-rust — container image for the Rust connector (issue #429)
#
# DELIBERATELY A SEPARATE IMAGE from the published `connector` one. Per ADR 0013
# the cutover runs the Rust fleet in PARALLEL under its own address prefix, with
# both networks live at once — so the Rust binary must not be published under the
# TypeScript node's name and tag series. `connector:3.44.0` means "TS node, YAML/
# CONFIG_FILE"; this takes a TOML path as argv. Swapping what a tag means in
# place is the one shape that cutover design rules out.
#
# Published to GHCR as ghcr.io/toon-protocol/connector-rust by
# .github/workflows/publish-connector-rust-image.yml (issue #487), tagged by
# content (`sha-<short-sha>`) rather than by version — no crate under crates/
# has a release process yet (every Cargo.toml is still 0.1.0), so a semver tag
# here would assert a stability contract this binary hasn't earned. `latest`
# on `ghcr.io/toon-protocol/connector` is untouched and stays frozen on the
# last TypeScript build.
#
# The base is rust:1.90 (matching CI's stable toolchain), NOT the 1.82 this file
# originally pinned: 1.82 cannot build the locked graph at all — idna_adapter
# 1.2.2 requires the edition2024 Cargo feature. Nothing in CI ever built this
# file, so that was undetected until #465.
#
# One static binary, one config file, no JavaScript runtime anywhere in the
# final image -- contrast the TypeScript connector's root ./Dockerfile, whose
# Node >= 22.12 pin exists solely for Mina/o1js's ESM packaging (a dependency
# ADR 0002 drops entirely from this rewrite).
#
# Build (single platform, from the repository root so the build context
# includes crates/ and packages/solana-program/):
#   docker build -f deploy/connector-rust/Dockerfile -t connector-rust .
#
# Build for both target platforms (per this ticket's AC):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f deploy/connector-rust/Dockerfile -t connector-rust .
#
# `cargo build` compiles natively for whichever architecture buildx/QEMU
# presents as the container's own -- there is no cross-compilation step and
# no BUILDPLATFORM pinning to work around here.
# =============================================================================

# ============================================
# Stage 1: builder
# ============================================
FROM rust:1.90-alpine3.22 AS builder

RUN apk add --no-cache musl-dev

WORKDIR /workspace

# The workspace root and every crate the connector binary's dependency
# closure can reach. `packages/solana-program` (the `payment-channel`
# crate) is a workspace member too -- Cargo needs its manifest present to
# resolve the workspace graph -- but `-p connector` below never adds it to
# the build plan, so the separate Solana BPF toolchain it needs is never
# installed in this image.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY packages/solana-program ./packages/solana-program

RUN cargo build --release --locked -p connector

# ============================================
# Stage 2: runtime -- no JavaScript runtime, no build toolchain
# ============================================
FROM alpine:3.22 AS runtime

# ca-certificates: the connector's HTTP app client (reqwest, rustls-tls)
# verifies TLS against the system root store when an app's handler_url is
# https.
RUN apk add --no-cache ca-certificates && \
    adduser -D -u 10001 connector && \
    # /app/state must exist in the image, owned by the runtime user, BEFORE
    # any volume is mounted over it: a named volume mounted on a path the
    # image does not provide is created root-owned, uid 10001 cannot write
    # it, and the connector refuses to start (state_dir fails closed, issue
    # #605). Providing the path here is what makes a fresh named volume
    # inherit 10001 ownership on first mount.
    mkdir -p /app/state && chown connector:connector /app/state

COPY --from=builder /workspace/target/release/connector /usr/local/bin/connector

USER connector
ENTRYPOINT ["/usr/local/bin/connector"]
CMD ["/app/config/connector.toml"]
