# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Faucet image — Base Sepolia + Solana devnet, USDC only
# ---------------------------------------------------------------------------
# One stage. The o1js cross-build that used to precede it went with Mina
# (ADR 0065); nothing in this image proves a circuit any more, which is also
# why the box it runs on no longer needs a 4 GB plan.
#
# BUILD CONTEXT: the repo ROOT (`.`), not packages/faucet — see
# docker-compose.yml and infra/linode-faucet/docker-compose.faucet.yml, both of
# which pass `context: .` / `context: ../..`. The COPY paths below are
# repo-relative for that reason.
#
# BASE IMAGE: node:22-bookworm-slim (glibc). Alpine would now work — the musl
# incompatibility was o1js's native bindings — but swapping it is an unrelated
# change and this base is the one the live box has run for weeks.

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Production deps first, for layer caching.
COPY packages/faucet/package*.json ./
RUN npm install --omit=dev

COPY packages/faucet/src ./src
COPY packages/faucet/public ./public

EXPOSE 3500

# Health check (wget present on bookworm-slim; mirrors compose healthcheck).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3500/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# `npm start` runs `node src/index.js` (cwd /app).
CMD ["npm", "start"]
