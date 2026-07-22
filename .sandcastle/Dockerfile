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

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
