#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into the TOON relay box.
# Runs: connector-rust (with its apex<->relay peering, issue #820) + relay +
# faucet (issue #870, toon-meta#310's apex-retirement spec) + nginx/TLS. No
# TypeScript connector — there is no predecessor to run alongside and one is
# prohibited on this fleet. No store, no Mina lightnet.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run as root on a clean Ubuntu box:
#   git clone https://github.com/toon-protocol/connector.git
#   cd connector/infra/linode-relay && cp .env.example .env && $EDITOR .env
#   ./bootstrap.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

# Includes the rust overlay from the start — unlike infra/linode-store/'s
# bootstrap.sh, whose omission of it is historical (that box grew a Rust
# connector well after its TypeScript one was already live) rather than a
# shape to copy. This box has no TypeScript connector to stand up beside.
COMPOSE=(docker compose -f infra/linode-relay/docker-compose.relay.yml -f infra/linode-relay/docker-compose.relay.rust.yml)

echo "==> [1/5] System packages"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
apt-get install -y git jq gettext-base openssl ufw curl iptables

echo "==> [2/5] Firewall (public = 22/80/443 only)"
"$HERE/firewall.sh"

# Pulls the PINNED images only (connector-rust, relay, nginx, certbot). The
# faucet has no `image:` — it is built from `packages/faucet/Dockerfile` with
# the repo root as context, which `up -d` below does on first bring-up.
echo "==> [3/5] Pull images (connector-rust + relay; the faucet builds at [5/5])"
( cd "$ROOT" && "${COMPOSE[@]}" pull --ignore-pull-failures )

echo "==> [4/5] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/node.conf.template" > "$HERE/nginx/conf.d/node.conf"

echo "==> [5/5] Start services + issue TLS certs"
( cd "$ROOT" && "${COMPOSE[@]}" up -d )

echo "Waiting for connector health..."
for i in $(seq 1 30); do
  # The Rust connector has no /health route (/ilp, /ilp/btp, /ilp/probe,
  # /ilp/identity, /ilp/routes/price, /ilp/claim-state only) — GET
  # /ilp/identity 200s only once the process is serving AND has read its
  # signer key file, same liveness check both other boxes' nginx use.
  curl -sf http://127.0.0.1:4000/ilp/identity >/dev/null 2>&1 && echo "Connector healthy." && break || true
  sleep 3
done

chmod +x "$HERE/init-letsencrypt.sh"
"$HERE/init-letsencrypt.sh"

echo
echo "✅ TOON relay node up."
echo "   ILP edge : https://proxy.relay.${DOMAIN}/ilp"
echo "   Relay ws : wss://relay-ws.${DOMAIN}"
# Served by this box's nginx as of #870, but the A-record still points at the
# apex until the live cutover — so this URL reaches the apex's copy, not this
# one, until DNS moves.
echo "   Faucet   : https://faucet.${DOMAIN}  (once DNS points here — #870)"
