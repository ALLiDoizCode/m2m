#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into the TOON faucet box.
# Runs: faucet + nginx/TLS. NO connector, NO ILP config of any kind — the
# faucet gets its OWN box per toon-meta `docs/two-node-architecture.md` §4
# (that doc lives in toon-meta, not this repo; connector#898 tracks the
# faucet box here). USDC only (§4.6): no native-gas/native-token drip of any
# kind ships on this box.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run as root on a clean Ubuntu box:
#   git clone https://github.com/toon-protocol/connector.git
#   cd connector/infra/linode-faucet && cp .env.example .env && $EDITOR .env
#   # Generate FRESH keys on this box (never copy box 1's — §4.4) and place
#   # the Solana treasury keypair at /root/keys/solana-usdc-treasury.json
#   # before running this script, or the Solana leg boots disabled.
#   ./bootstrap.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

COMPOSE=(docker compose -f infra/linode-faucet/docker-compose.faucet.yml)

echo "==> [1/5] System packages"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
apt-get install -y git jq gettext-base openssl ufw curl iptables

echo "==> [2/5] Firewall (public = 22/80/443 only)"
"$HERE/firewall.sh"

echo "==> [3/5] Pull base images (nginx, certbot — the faucet itself is built, not pulled)"
( cd "$ROOT" && "${COMPOSE[@]}" pull --ignore-pull-failures nginx certbot )

echo "==> [4/5] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/node.conf.template" > "$HERE/nginx/conf.d/node.conf"

echo "==> [5/5] Build the faucet image + start services + issue TLS certs"
( cd "$ROOT" && "${COMPOSE[@]}" up -d --build )

echo "Waiting for faucet health..."
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:3500/health >/dev/null 2>&1 && echo "Faucet healthy." && break || true
  sleep 3
done

chmod +x "$HERE/init-letsencrypt.sh"
"$HERE/init-letsencrypt.sh"

echo
echo "✅ TOON faucet box up."
echo "   Faucet: https://faucet.${DOMAIN}"
echo "   (faucet.${DOMAIN} DNS still points at box 1 until the ordered runbook"
echo "    in docs/operators/faucet-box-bringup.md cuts over — this box is not"
echo "    yet the live one.)"
