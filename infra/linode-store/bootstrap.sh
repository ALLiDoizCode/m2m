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

# Hardening first, and asserted at exit. Read infra/harden-box.sh before
# reordering anything below it: under `set -e` every later step is a step that
# can abort this script, and the Docker install used to sit ahead of the
# firewall and the SSH hardening — so one apt hiccup left a fresh box with no
# firewall and password SSH still on, reported only by a line in a log.
# shellcheck source=infra/harden-box.sh
. "$HERE/../harden-box.sh"
require_hardened_on_exit

echo "==> [1/5] Firewall + SSH hardening (before anything that can fail)"
# Ahead of the .env check on purpose: neither half reads .env, so a missing
# config file must not be the reason this box is left open.
harden_box "$HERE"

[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

COMPOSE=(docker compose -f infra/linode-store/docker-compose.store.yml)

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
