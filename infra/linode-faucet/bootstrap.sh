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
# Docker is UNPINNED BY DESIGN; do not "fix" this with VERSION= or --version.
# Three reasons, each sufficient on its own:
#
#   1. The `command -v docker` guard means this only ever runs on a blank
#      disk, so a pin could never change the daemon on a live box -- it would
#      only decide what a REBUILD gets. Nothing on these boxes upgrades the
#      host engine: there is no unattended-upgrades, no `apt-get upgrade`
#      anywhere in this repo, and the label-scoped Watchtower recreates
#      containers, never the engine under them. A reprovision is therefore the
#      ONLY event that ever patches Docker here, and a pin would spend it
#      reinstalling a frozen version forever.
#   2. It would not pin what this script actually uses. get.docker.com's
#      VERSION/--version applies to `docker-ce`, `docker-ce-cli` and
#      `docker-ce-rootless-extras`; `containerd.io`, `docker-buildx-plugin`
#      and `docker-compose-plugin` are installed unversioned -- and every step
#      below is `docker compose`. A pin would read as reproducible in review
#      while the runtime and the compose plugin still floated.
#   3. It would add a hard failure at this point, ahead of firewall.sh and
#      harden-ssh.sh: the script `exit 1`s when the requested version is not
#      among the `apt-cache madison` results, Docker does not promise to keep
#      old versions in its apt repo, and `set -e` would abort a rebuild with
#      the box still open-ported and password-SSH-able.
#
# If a specific engine version ever does become load-bearing, it must arrive
# with a bump owner: pin `docker-ce`/`docker-ce-cli` out of the apt repo this
# script leaves configured (`apt-get install --only-upgrade docker-ce
# docker-ce-cli containerd.io` is the upgrade path Docker's own docs give for
# a convenience-script install), record the version in git, and name whoever
# moves it. A pin with no bump story rots into a known-vulnerable daemon.
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

echo "==> [3/5] Pull base images (nginx, certbot — the faucet itself is built, not pulled)"
( cd "$ROOT" && "${COMPOSE[@]}" pull --ignore-pull-failures nginx certbot )

echo "==> [4/5] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/node.conf.template" > "$HERE/nginx/conf.d/node.conf"

echo "==> [5/5] Build the faucet image + start services + issue TLS certs"
( cd "$ROOT" && "${COMPOSE[@]}" up -d --build )

echo "Waiting for faucet health..."
# Probed from INSIDE the container, not from the host: unlike box 1's compose
# file this one publishes no `3500:3500` (the only public ports on this box are
# nginx's 80/443 — a published container port would also punch straight through
# ufw's deny-by-default, since docker writes its own iptables rules), so
# `curl http://127.0.0.1:3500/health` on the host could never succeed. This is
# the same check the service's own healthcheck runs.
for _ in $(seq 1 30); do
  ( cd "$ROOT" && "${COMPOSE[@]}" exec -T faucet node -e \
      "fetch('http://localhost:3500/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    ) >/dev/null 2>&1 && echo "Faucet healthy." && break || true
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
