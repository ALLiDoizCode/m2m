#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into the TOON STORE node.
# Runs: connector (payment proxy) + store (Arweave DVM) + nginx/TLS.
#
# Chain config: EVM/Solana are literal in connector.yaml.template; the Mina
# block is rendered from ${MINA_*} in .env (the `apps` deploy injects them,
# captured from the toon node's live lightnet deploy). The store does NOT deploy
# Mina zkApps — it consumes the toon node's deploy.
#
# Run as root on a clean Ubuntu box (devnet-manage.sh does this over SSH):
#   cd connector && ./infra/linode-store/bootstrap.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

COMPOSE=(docker compose -f infra/linode-store/docker-compose.store.yml)

echo "==> [1/5] System packages"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
apt-get install -y git jq gettext-base openssl ufw curl iptables

echo "==> [2/5] Firewall (public = 22/80/443 only)"
"$HERE/firewall.sh"

echo "==> [3/5] Render connector.yaml (inject Mina addrs) + nginx config"
# Only the ${MINA_*} placeholders are substituted — every other value is literal.
envsubst '${MINA_GRAPHQL_URL} ${MINA_ZKAPP_ADDRESS} ${MINA_TOKEN_ADDRESS} ${MINA_TOKEN_ID}' \
  < "$HERE/connector.yaml.template" > "$HERE/connector.yaml"
if grep -q '\${MINA_' "$HERE/connector.yaml"; then
  echo "⚠️  connector.yaml still has unfilled \${MINA_*} placeholders — Mina settlement will fail." >&2
  echo "    Re-run the 'apps' deploy AFTER 'chains' has deployed the Mina lightnet." >&2
fi
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/store.conf.template" > "$HERE/nginx/conf.d/store.conf"

echo "==> [4/5] Pull images"
( cd "$ROOT" && "${COMPOSE[@]}" pull --ignore-pull-failures )

echo "==> [5/5] Start services + issue TLS cert"
( cd "$ROOT" && "${COMPOSE[@]}" up -d )

echo "Waiting for connector health..."
for _ in $(seq 1 30); do
  ( cd "$ROOT" && "${COMPOSE[@]}" exec -T connector wget -q --spider http://localhost:8080/health ) 2>/dev/null \
    && echo "Connector healthy." && break || true
  sleep 3
done

chmod +x "$HERE/init-letsencrypt.sh"
"$HERE/init-letsencrypt.sh"

echo
echo "✅ TOON store node up."
echo "   Store /ilp : https://store.${DOMAIN}/ilp  (route g.proxy.store → store:3300)"
