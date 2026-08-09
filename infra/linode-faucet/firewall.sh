#!/usr/bin/env bash
# Firewall for TOON faucet box — allow 22/80/443 only. No connector, so no
# other public port to consider (connector#898, toon-meta §4.5).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$HERE/.env"; set +a

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP (ACME)'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status verbose
