# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Faucet image — EVM + Solana + Mina (native MINA + USDC treasury drip)
# ---------------------------------------------------------------------------
# BASE IMAGE: glibc, NOT alpine. The Mina USDC drip path (src/mina-usdc.mjs:
# treasury self-mint + transfer against the rate-limited public-devnet token)
# uses o1js zk-PROVING (`tx.prove()`), and o1js's native bindings do NOT work on
# node:22-alpine (musl). `node:22-bookworm-slim` is glibc and proves correctly.
#
# BUILD CONTEXT: the repo ROOT (`.`), not packages/faucet — see docker-compose.yml
# `faucet.build` (context: ., dockerfile: packages/faucet/Dockerfile). The image
# needs the mina-zkapp source to build its parallel ESM bundle (dist-esm/) that
# the ESM faucet imports, so o1js stays a SINGLE module instance (see
# src/mina-usdc.mjs header for why CJS dist/ would double-load o1js and break it).
#
# Runtime layout mirrors the repo so the faucet's relative import
# `../../mina-zkapp/dist-esm/...` resolves:
#   /app/packages/faucet/src/mina-usdc.mjs -> /app/packages/mina-zkapp/dist-esm/

# ── Stage 1: build the mina-zkapp ESM bundle (needs TS + dev deps) ──────────
FROM node:22-bookworm-slim AS zkapp-build
WORKDIR /build/packages/mina-zkapp
# Install mina-zkapp deps (o1js, mina-fungible-token, typescript, ...) and build
# the ESM bundle (dist-esm/). package.json first for layer caching.
COPY packages/mina-zkapp/package*.json ./
RUN npm install
COPY packages/mina-zkapp/tsconfig.json packages/mina-zkapp/tsconfig.esm.json ./
COPY packages/mina-zkapp/scripts ./scripts
COPY packages/mina-zkapp/src ./src
RUN npm run build:esm

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# Install the faucet's production deps at /app (NOT /app/packages/faucet) so
# /app/node_modules is a COMMON ANCESTOR of BOTH the faucet code
# (/app/packages/faucet/src) and the mina-zkapp ESM bundle
# (/app/packages/mina-zkapp/dist-esm). The bundle imports o1js/mina-fungible-token
# as BARE specifiers, which Node resolves by walking UP the directory tree — so
# both must hoist to the SAME node_modules to share ONE o1js instance (mirrors
# how the workspace hoists o1js to the repo-root node_modules locally).
WORKDIR /app
COPY packages/faucet/package*.json ./
RUN npm install --omit=dev

# Faucet app code + the compiled mina-zkapp ESM bundle, laid out so the faucet's
# relative import `../../mina-zkapp/dist-esm/...` resolves and the bundle's bare
# o1js/mina-fungible-token imports resolve up to /app/node_modules.
COPY packages/faucet/src ./packages/faucet/src
COPY packages/faucet/public ./packages/faucet/public
COPY packages/faucet/package*.json ./packages/faucet/
COPY --from=zkapp-build /build/packages/mina-zkapp/dist-esm ./packages/mina-zkapp/dist-esm

WORKDIR /app/packages/faucet

EXPOSE 3500

# Health check (wget present on bookworm-slim; mirrors compose healthcheck).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# `npm start` runs `node src/index.js` (cwd /app/packages/faucet).
CMD ["npm", "start"]
