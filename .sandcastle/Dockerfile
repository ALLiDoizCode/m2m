# connector is an npm-WORKSPACES monorepo (NOT pnpm) — so, unlike the pnpm
# repos' sandcastle images, there is deliberately NO `corepack prepare pnpm`
# line here. The stock node:22 image already ships npm, which is all connector
# needs (`npm ci` in the onSandboxReady hook).
#
# mina-zkapp NATIVE DEPS: connector's `packages/mina-zkapp` (o1js) and its
# transitive native modules (e.g. bigint-buffer's `node-gyp rebuild`) need a C
# toolchain + python3. We verified empirically that the FULL `node:22-bookworm`
# image already provides them — it is built on `buildpack-deps:bookworm`, which
# bundles build-essential (gcc/g++/make) and python3. Inside this image `npm ci`
# and the ordered `shared → mina-zkapp` build both succeed with NO extra apt
# packages, so none are added. (If you ever switch this FROM to a `-slim`
# variant, you MUST add `build-essential python3` before the USER switch.)
FROM node:22-bookworm

# Links the published GHCR package (ghcr.io/toon-protocol/sandcastle-connector,
# see the pull step in .github/workflows/agent-implement.yml) to this repo.
LABEL org.opencontainers.image.source="https://github.com/toon-protocol/connector"

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# ── Rust + Foundry ──────────────────────────────────────────────────────────
# WHY: the #409 rewrite is Rust, and without these the implementer cannot run
# `cargo check`, `cargo test` or `cargo clippy` on the code it is writing — it
# commits, and CI is the first thing that ever compiles it. That is not a
# hypothetical cost: #441, #444, #446, #449 and #454 are all remediation tickets
# for agent PRs that did not compile or conflicted, discovered only after the
# expensive work was done.
#
# The C toolchain cargo needs to LINK is already here — see the header note: the
# full node:22-bookworm is built on buildpack-deps:bookworm, which bundles
# build-essential. A `-slim` base would need it added explicitly.
#
# VERSIONS ARE PINNED TO THE GATE. ci.yml's Rust Workspace Gate uses
# `dtolnay/rust-toolchain@stable` with clippy+rustfmt, and
# `foundry-rs/foundry-toolchain@v1` at v1.7.1. Matching them here is the entire
# point: an agent that passes locally on a different toolchain than the gate runs
# has learned nothing. If you bump one, bump the other.
#
# `--profile minimal` keeps this to the toolchain plus the two components the
# gate actually invokes, rather than pulling docs and every default extra.
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable --component clippy,rustfmt

# Foundry provides `anvil` (and `cast`, which the chain tests use to poll it).
# Per ADR 0007 the integration tier spawns its own disposable local chain, so the
# agent needs the binary present — there is no shared chain to point at, by
# design. Pinned to the same v1.7.1 the gate installs.
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
  && /home/agent/.foundry/bin/foundryup --install v1.7.1

# Solana CLI provides `solana-test-validator` (and `solana-keygen`, used to resolve the
# checked-in program keypair's pubkey) for connector-settlement-solana's tests (issue #428) —
# the same role Foundry plays above, needed for the same reason: without it the implementer
# cannot run this crate's tests locally and only finds out they're broken once CI does.
#
# Pinned to v2.1.21, NOT the newer v3.x line ci.yml's pre-existing `solana-integration` job
# installs: v3's solana-test-validator hard-requires io_uring, which this container's sandbox
# runtime does not permit (verified directly here — it panics with
# `assertion failed: io_uring_supported()` even though the kernel itself supports io_uring).
# v2.1.21 needs no io_uring and also matches the `=2.1.0` solana-program/solana-client/
# solana-sdk pin in crates/connector-settlement-solana{,-program}/Cargo.toml, so the CLI
# deploying and driving the program is the same release line the program is built against.
# `.github/workflows/ci.yml`'s `rust-gate` job installs this exact version for the same reason
# its Foundry install matches this image's.
RUN curl -sSfL https://release.anza.xyz/v2.1.21/install | sh

# Add Claude, cargo, foundry and the Solana CLI to PATH
ENV PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:/home/agent/.foundry/bin:/home/agent/.local/share/solana/install/active_release/bin:$PATH"

# ENV PATH covers the engine, which execs non-login shells. But claude-code
# spawns its own shells for the agent's own commands, and a LOGIN shell sources
# /etc/profile, which rebuilds PATH from scratch and drops anything set only via
# ENV. rustup already appends itself to ~/.profile (which is why cargo survives
# `bash -lc` and foundry would not), and the Solana installer does the same for itself — but
# neither touches ~/.bashrc, so do that explicitly for both rather than leaving a difference
# that shows up as "anvil: command not found" (or "solana-test-validator: command not found")
# in exactly one shell mode. Verified against both `bash -c` and `bash -lc`.
RUN printf '\n# Foundry (anvil/cast) — see .sandcastle/Dockerfile\nexport PATH="$HOME/.foundry/bin:$PATH"\n' \
  | tee -a /home/agent/.profile >> /home/agent/.bashrc \
  && printf '\n# Solana CLI (solana-test-validator/solana-keygen) — see .sandcastle/Dockerfile\nexport PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"\n' \
  | tee -a /home/agent/.profile >> /home/agent/.bashrc

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
