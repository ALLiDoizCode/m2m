#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into the TOON connector node.
# Runs: connector (proxy/relay) + relay + faucet + nginx/TLS.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run as root on a clean Ubuntu box:
#   git clone https://github.com/toon-protocol/connector.git
#   cd connector/infra/linode-node && cp .env.example .env && $EDITOR .env
#   ./bootstrap.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

echo "==> [1/5] System packages"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
apt-get install -y git jq gettext-base openssl ufw curl iptables

echo "==> [2/5] Firewall (public = 22/80/443 only)"
"$HERE/firewall.sh"

echo "==> [3/5] Pull images + build faucet"
( cd "$ROOT" && docker compose -f infra/linode-node/docker-compose.node.yml pull --ignore-pull-failures )
( cd "$ROOT" && docker compose -f infra/linode-node/docker-compose.node.yml build faucet )

echo "==> [4/5] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/node.conf.template" > "$HERE/nginx/conf.d/node.conf"

echo "==> [5/5] Start services + issue TLS certs"
( cd "$ROOT" && docker compose -f infra/linode-node/docker-compose.node.yml up -d )

echo "Waiting for connector health..."
for i in $(seq 1 30); do
  curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Connector healthy." && break || true
  sleep 3
done

"$HERE/init-letsencrypt.sh"

echo
echo "✅ TOON connector node up."
echo "   Relay WS : wss://relay-ws.${DOMAIN}"
echo "   Proxy    : https://proxy.${DOMAIN}/ilp"
echo "   Faucet   : https://faucet.${DOMAIN}"
