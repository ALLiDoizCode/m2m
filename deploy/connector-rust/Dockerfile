# =============================================================================
# connector-rust — container image for the Rust connector (issue #429)
#
# DELIBERATELY A SEPARATE IMAGE from the published `connector` one. Per ADR 0013
# the cutover runs the Rust fleet in PARALLEL under its own address prefix, with
# both networks live at once — so the Rust binary must not be published under the
# TypeScript node's name and tag series. `connector:3.44.0` means "TS node, YAML/
# CONFIG_FILE"; this takes a TOML path as argv. Swapping what a tag means in
# place is the one shape that cutover design rules out. Whether and how this gets
# published to GHCR belongs to #431.
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
    adduser -D -u 10001 connector

COPY --from=builder /workspace/target/release/connector /usr/local/bin/connector

USER connector
ENTRYPOINT ["/usr/local/bin/connector"]
CMD ["/app/config/connector.toml"]
