# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Announcer sidecar (connector#681) — a standalone kind:10032 announcer for
# the Rust connector's client edge. ADR 0022 forbids the connector itself
# pushing an announcement; this is the "component that owns them has to
# exist somewhere else" ADR 0006 anticipated. It never touches the connector
# binary or crates — it only POLLS the edge's public `GET /ilp/identity` and
# `POST /ilp` (x402 greeting) answers, then publishes a kind:10032 event it
# signs with its OWN dedicated announce identity.
#
# BUILD CONTEXT: the repo ROOT (`.`), not packages/announcer — this package's
# tsconfig.json extends the repo's shared ../../tsconfig.base.json, so that
# file needs to land two directories above this package inside the image too
# (see the COPY below). Deliberately standalone otherwise (no npm-workspaces
# linking in the image) — this package has no dependency on any other
# workspace member.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS build
WORKDIR /build/packages/announcer
COPY packages/announcer/package*.json ./
RUN npm install
COPY tsconfig.base.json /build/tsconfig.base.json
COPY packages/announcer/tsconfig.json ./
COPY packages/announcer/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY packages/announcer/package*.json ./
RUN npm install --omit=dev
COPY --from=build /build/packages/announcer/dist ./dist

# Overridden by docker-compose's ANNOUNCER_HEALTH_PORT if changed — keep in sync.
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.ANNOUNCER_HEALTH_PORT || 8090) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
