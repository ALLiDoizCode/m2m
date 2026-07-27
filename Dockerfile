# =============================================================================
# connector — container image for the Rust connector (ADR 0001)
# =============================================================================
# One static binary, one config file, no JavaScript runtime anywhere in the
# final image.
#
# WHY THIS FILE CHANGED (issue #457):
# This used to be a three-stage Node build that compiled packages/connector's
# embedded `ConnectorNode` and ran `packages/connector/dist/main.js`. That
# runtime no longer exists — @toon-protocol/connector is now a thin HTTP
# client library for the Rust connector's client edge, with no `main.ts`, no
# native dependencies (the libsql/sharp prebuild pinning that used to live
# here has nothing left to pin — both dropped out of the lockfile with the
# embedded node), and nothing that can be started as a server. The only
# connector runtime this repository still builds is the Rust one, so that is
# what the `connector` image is.
#
# Build (from the repository root — the context needs crates/ and
# packages/solana-program/):
#   docker build -t connector .
#
# Build for both target platforms:
#   docker buildx build --platform linux/amd64,linux/arm64 -t connector .
#
# `cargo build` compiles natively for whichever architecture buildx/QEMU
# presents as the container's own — there is no cross-compilation step, and
# none of the $BUILDPLATFORM pinning the old Node build needed to dodge the
# QEMU SIGILL crashes that broke the v3.28.6 release image.
#
# Run:
#   docker run --rm -p 3000:3000 \
#     -v "$(pwd)/deploy/connector-rust/connector.toml:/app/config/connector.toml:ro" \
#     -v "$(pwd)/deploy/connector-rust/signer.key:/app/data/signer.key:ro" \
#     connector
#
# See deploy/connector-rust/README.md for the full key-generation and
# configuration walkthrough.
# =============================================================================

# ============================================
# Stage 1: builder
# ============================================
# Base pinned to a Rust >= 1.85 line: the locked dependency graph pulls in
# `idna_adapter` 1.2.2, whose manifest requires the edition2024 Cargo
# feature. The 1.82 base this build previously used fails to even parse it
# ("feature `edition2024` is required"). CI's rust-gate uses `stable`, so
# pinning a recent stable here keeps the image build and the gate on the
# same footing.
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

# The connector serves one HTTP port; the bind address comes from the config
# file's `client_edge_addr`.
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/connector"]
CMD ["/app/config/connector.toml"]
