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

echo "==> SSH hardening (key-only; no password auth)"
# Runs AFTER the firewall and AFTER provisioning has installed the operator's
# key, because harden-ssh.sh refuses to disable password auth on a box with no
# usable authorized key. See infra/harden-ssh.sh for why this is mandatory.
"$HERE/../harden-ssh.sh"

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

# ── Deploy the Mina zkApps to the (fresh) lightnet + wire connector.yaml/faucet ──
# The lightnet RESETS on box recreate, so this runs every provisioning. It is
# idempotent (skips when the configured USDC token is already live). Non-fatal:
# the connector's Mina verify hot-path only needs the per-claim channelAccount, so
# a transient deploy hiccup must not block bringing the node up (re-run manually:
#   ./infra/linode-node/provision-mina-lightnet.sh ).
chmod +x "$HERE/provision-mina-lightnet.sh"
echo "==> Deploying Mina lightnet zkApps + wiring config"
DOMAIN="$DOMAIN" "$HERE/provision-mina-lightnet.sh" || \
  echo "⚠️  Mina lightnet provisioning failed — re-run infra/linode-node/provision-mina-lightnet.sh"

echo
echo "✅ TOON connector node up."
echo "   Proxy    : https://proxy.${DOMAIN}/ilp"
echo "   Faucet   : https://faucet.${DOMAIN}"
