# =============================================================================
# connector-rust — container image for the Rust connector (issue #429)
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
FROM rust:1.82-alpine3.20 AS builder

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
FROM alpine:3.20 AS runtime

# ca-certificates: the connector's HTTP app client (reqwest, rustls-tls)
# verifies TLS against the system root store when an app's handler_url is
# https.
RUN apk add --no-cache ca-certificates && \
    adduser -D -u 10001 connector

COPY --from=builder /workspace/target/release/connector /usr/local/bin/connector

USER connector
ENTRYPOINT ["/usr/local/bin/connector"]
CMD ["/app/config/connector.toml"]
