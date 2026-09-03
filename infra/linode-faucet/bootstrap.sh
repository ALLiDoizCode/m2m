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

# Hardening first, and asserted at exit. Read infra/harden-box.sh before
# reordering anything below it: under `set -e` every later step is a step that
# can abort this script, and the Docker install used to sit ahead of the
# firewall and the SSH hardening — so one apt hiccup left a fresh box with no
# firewall and password SSH still on, reported only by a line in a log. This
# box matters most of the three: it holds the devnet USDC treasuries, and
# `devnet-manage.sh faucet` deliberately stops after the create and leaves a
# human to run this script, so its unhardened window is open for however long
# that takes rather than for the minutes the other two get.
# shellcheck source=infra/harden-box.sh
. "$HERE/../harden-box.sh"
require_hardened_on_exit

echo "==> [1/5] Firewall + SSH hardening (before anything that can fail)"
# Ahead of the .env check on purpose: neither half reads .env, so a missing
# config file must not be the reason this box is left open. On this box that
# is not hypothetical — the runbook has a human filling .env in by hand.
harden_box "$HERE"

[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

COMPOSE=(docker compose -f infra/linode-faucet/docker-compose.faucet.yml)

echo "==> [2/5] System packages"
apt-get update -y
apt-get install -y git jq gettext-base openssl ufw curl iptables

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
#   3. It would add a hard failure for nothing: the script `exit 1`s when the
#      requested version is not among the `apt-cache madison` results, and
#      Docker does not promise to keep old versions in its apt repo, so a pin
#      would eventually abort every reprovision. This used to be the worst of
#      the three — the step ran ahead of firewall.sh and harden-ssh.sh, so any
#      abort here left the box open-ported and password-SSH-able. It no longer
#      does — infra/harden-box.sh moved the hardening in front of everything
#      that can fail — but an abort still strands a box short of serving.
#
# If a specific engine version ever does become load-bearing, it must arrive
# with a bump owner: pin `docker-ce`/`docker-ce-cli` out of the apt repo this
# script leaves configured (`apt-get install --only-upgrade docker-ce
# docker-ce-cli containerd.io` is the upgrade path Docker's own docs give for
# a convenience-script install), record the version in git, and name whoever
# moves it. A pin with no bump story rots into a known-vulnerable daemon.
#
# The install runs after the apt-get above, not before it: the pipe below needs
# `curl`, which that line is what guarantees.
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

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
