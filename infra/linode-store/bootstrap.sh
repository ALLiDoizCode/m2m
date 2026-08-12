#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into the TOON store (Arweave DVM) box.
# Runs: store (DVM) + nginx/TLS. NOT the connector — issue #901 deleted this
# box's retired TypeScript one, and its replacement lives in the sibling
# docker-compose.store.rust.yml overlay, which this script does not bring up
# because that overlay first needs key files provisioned by hand on the box
# (see its header). Bringing it in here the way infra/linode-relay/bootstrap.sh
# does is a separate, deliberate step.
# No relay, no faucet, no Mina lightnet — this box settles against the existing
# devnet chain boxes (see connector-rust.toml's [settlement.*] sections).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run as root on a clean Ubuntu box:
#   git clone https://github.com/toon-protocol/connector.git
#   cd connector/infra/linode-store && cp .env.example .env && $EDITOR .env
#   ./bootstrap.sh
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

echo "==> SSH hardening (key-only; no password auth)"
# Runs AFTER the firewall and AFTER provisioning has installed the operator's
# key, because harden-ssh.sh refuses to disable password auth on a box with no
# usable authorized key. See infra/harden-ssh.sh for why this is mandatory.
"$HERE/../harden-ssh.sh"

echo "==> [3/5] Pull images (store + nginx/TLS)"
( cd "$ROOT" && "${COMPOSE[@]}" pull --ignore-pull-failures )

echo "==> [4/5] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/node.conf.template" > "$HERE/nginx/conf.d/node.conf"

echo "==> [5/5] Start services + issue TLS certs"
( cd "$ROOT" && "${COMPOSE[@]}" up -d )

# No connector health wait: the only thing that ever answered
# http://localhost:8080/health here was the TypeScript connector's published
# healthcheck port, and issue #901 deleted that service — nothing this script
# starts listens on the host any more except nginx, which init-letsencrypt.sh
# brings up on its own before it asks for certs.
chmod +x "$HERE/init-letsencrypt.sh"
"$HERE/init-letsencrypt.sh"

echo
echo "✅ TOON store node up."
echo "   ILP edge : https://proxy.ario.${DOMAIN}/ilp   (g.toon.ario — 502s until"
echo "              docker-compose.store.rust.yml is brought up beside this)"
echo "   DVM      : https://dvm.${DOMAIN}/health"
