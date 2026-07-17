# Multi-stage Dockerfile for Connector
#
# Stage 1 (builder):  Compiles TypeScript to JavaScript with all dependencies
# Stage 2 (proddeps): Installs production node_modules for the TARGET platform
# Stage 3 (runtime):  Runs compiled connector with production dependencies only
#
# Cross-platform note: stages 1 and 2 are pinned to $BUILDPLATFORM so that
# node/npm ALWAYS execute natively on the build host — node running under
# QEMU emulation (multi-arch buildx of the linux/arm64 leg) intermittently
# dies with SIGILL ("qemu: uncaught target signal 4", exit 132), which broke
# the v3.28.6 release image build. The runtime stage is the only
# target-platform stage and never executes node at build time (only apk /
# busybox, which are safe under emulation). Target-arch native binaries
# (libsql, sharp) are installed in the proddeps stage as explicit pinned
# packages instead of by running npm under emulation.
#
# Build: docker build -t connector .
# Run:   docker run -e NODE_ID=connector-a -e BTP_SERVER_PORT=3000 -p 3000:3000 connector

# ============================================
# Stage 1: Builder (build platform — native)
# ============================================
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Copy dependency manifests first (for layer caching)
# Root package files define the workspace structure
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy workspace package.json files to preserve monorepo structure
COPY packages/connector/package.json ./packages/connector/
COPY packages/shared/package.json ./packages/shared/
COPY packages/mina-zkapp/package.json ./packages/mina-zkapp/

# Install all dependencies (including devDependencies for TypeScript compilation)
# Use npm ci for reproducible builds
# Use --ignore-scripts to skip prepare script (git hooks not needed in Docker builds)
RUN npm install --ignore-scripts

# Copy TypeScript configuration and source code
COPY packages/connector/tsconfig.json ./packages/connector/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/mina-zkapp/tsconfig.json ./packages/mina-zkapp/
COPY packages/connector/src ./packages/connector/src
COPY packages/shared/src ./packages/shared/src
COPY packages/mina-zkapp/src ./packages/mina-zkapp/src

# Build all packages (TypeScript compilation)
# Build shared and mina-zkapp before connector — connector imports both via
# dynamic import but its tsc step still needs their .d.ts files on disk.
# Use direct cd instead of --workspace to avoid npm workspace resolution
# issues when not all workspace dirs have package.json (contracts, solana-program).
RUN cd packages/shared && npm run build && \
    cd ../mina-zkapp && npm run build && \
    cd ../connector && npm run build

# ============================================
# Stage 2: Production deps (build platform — native)
# ============================================
# Installs the runtime node_modules tree FOR the target platform while
# running natively on the build platform (no node under QEMU — see header).
# The target platform's prebuilt native modules are installed explicitly:
# package-lock.json was generated on macOS and omits linux platform-optional
# packages (npm/cli#4828), so a locked `npm install` never materializes them
# regardless of host platform. Explicit pinned installs with --force bypass
# npm's EBADPLATFORM check (we install arm64 binaries on the x64 build host;
# they are never executed at build time):
# - @libsql/linux-{x64,arm64}-musl (issue #79 — libsql ships N-API prebuilds,
#   replacing native better-sqlite3 which needed a python3/make/g++ build)
# - @img/sharp-linuxmusl-{x64,arm64} + matching sharp-libvips package
FROM --platform=$BUILDPLATFORM node:22-alpine AS proddeps

ARG TARGETARCH

# Set production environment
ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Copy dependency manifests for production installation
COPY package.json package-lock.json ./
COPY packages/connector/package.json ./packages/connector/
COPY packages/shared/package.json ./packages/shared/
COPY packages/mina-zkapp/package.json ./packages/mina-zkapp/

# Install production dependencies only (excludes devDependencies like TypeScript)
# - Remove the 'prepare' script first (it runs husky, a devDependency).
# - Map Docker's $TARGETARCH (amd64|arm64) to npm/node arch (x64|arm64).
# - Supplemental install: pin the target-arch native prebuilds to the exact
#   versions resolved in the installed tree (libsql's own version; sharp's
#   optionalDependencies pins), --no-save so manifests stay untouched.
# - The trailing `test -d` lines make the build FAIL LOUDLY if the target
#   platform's native prebuilds are missing (the old code swallowed that
#   failure with `|| true` and would ship a broken image).
RUN NPM_ARCH=$(case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac) && \
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.scripts.prepare;fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");' && \
    npm install --omit=dev --ignore-scripts && \
    SPECS=$(node -e ' \
      const arch = process.argv[1]; \
      const out = []; \
      const libsql = require("/app/node_modules/libsql/package.json"); \
      out.push(`@libsql/linux-${arch}-musl@${libsql.version}`); \
      const sharp = require("/app/node_modules/sharp/package.json"); \
      for (const name of [`@img/sharp-linuxmusl-${arch}`, `@img/sharp-libvips-linuxmusl-${arch}`]) { \
        const v = (sharp.optionalDependencies || {})[name]; \
        if (!v) { console.error(`sharp has no optionalDependency ${name}`); process.exit(1); } \
        out.push(`${name}@${v}`); \
      } \
      console.log(out.join(" ")); \
    ' "$NPM_ARCH") && \
    npm install $SPECS --no-save --ignore-scripts --force && \
    test -d "node_modules/@libsql/linux-${NPM_ARCH}-musl" && \
    test -d "node_modules/@img/sharp-linuxmusl-${NPM_ARCH}" && \
    test -d "node_modules/@img/sharp-libvips-linuxmusl-${NPM_ARCH}"

# ============================================
# Stage 3: Runtime (target platform)
# ============================================
# No node/npm execution happens in this stage at build time — only apk and
# busybox commands, which run fine under QEMU emulation.
FROM node:22-alpine AS runtime

# Set production environment
ENV NODE_ENV=production

# Set working directory
WORKDIR /app

# Copy package manifests + the fully-resolved production node_modules
# (including workspace symlinks and target-arch native prebuilds) from the
# proddeps stage.
COPY --from=proddeps /app ./

# Copy compiled JavaScript from builder stage
# Only copy dist directories, not source code
COPY --from=builder /app/packages/connector/dist ./packages/connector/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/mina-zkapp/dist ./packages/mina-zkapp/dist

# Install wget for health check (minimal package, available in Alpine)
# Used by Docker HEALTHCHECK to query HTTP health endpoint
RUN apk add --no-cache wget

# Security hardening: Run as non-root user
# Alpine's node image includes a 'node' user by default
# Create data directory for SQLite databases and change ownership
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to non-root user (prevents privilege escalation attacks)
USER node

# Expose BTP server port (WebSocket)
# Default: 3000 (configurable via BTP_SERVER_PORT environment variable)
EXPOSE 3000

# Expose health check HTTP port
# Default: 8080 (configurable via HEALTH_CHECK_PORT environment variable)
EXPOSE 8080

# Health check: Query HTTP health endpoint
# Interval: Check every 30 seconds (balance between responsiveness and overhead)
# Timeout: Health endpoint must respond within 10 seconds
# Start period: Allow 40 seconds for connector startup (BTP connections establishment)
# Retries: Mark unhealthy after 3 consecutive failures
#
# The health endpoint returns:
# - 200 OK when connector is healthy (>=50% peers connected)
# - 503 Service Unavailable when unhealthy or starting
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start connector
# Environment variables:
# - NODE_ID: Connector identifier (default: 'connector-node')
# - BTP_SERVER_PORT: BTP server listening port (default: 3000)
# - LOG_LEVEL: Pino log level (default: 'info', options: debug|info|warn|error)
CMD ["node", "packages/connector/dist/main.js"]
