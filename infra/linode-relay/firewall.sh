#!/usr/bin/env bash
# Firewall for TOON relay box — allow 22/80/443 only.
#
# Depends on `ufw` and nothing else. In particular it does NOT depend on Docker
# and must not be reordered after it "for correctness": ufw applies its rules
# with `iptables-restore -n` (noflush) and only touches the built-in chains when
# /etc/default/ufw sets MANAGE_BUILTINS=yes, which Ubuntu ships as `no` — so
# enabling ufw never disturbs Docker's chains, and Docker reinstalls its own on
# daemon start regardless. The one thing ufw genuinely cannot govern is a
# container port published with `ports:`, which Docker routes ahead of ufw's
# INPUT chain; that is true in either order, and the answer to it is the
# loopback bind in docker-compose.relay.rust.yml, not this file.
#
# It deliberately does not read .env: nothing here is configurable, and
# infra/harden-box.sh runs this before a bootstrap has validated .env, so that
# a missing config file cannot be the reason a box is left open.
set -euo pipefail

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP (ACME)'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status verbose
