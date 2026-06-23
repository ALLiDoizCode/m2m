#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Lock down a TOON Linode devnet box.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Public surface = SSH + nginx (22/80/443) ONLY. The base compose publishes the
# raw chain/faucet ports on 0.0.0.0, and Docker writes its own iptables rules
# that BYPASS ufw — so closing them needs explicit DOCKER-USER drops on the
# public interface (ufw alone is not enough). Idempotent; safe to re-run.
set -euo pipefail

cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
IFACE="${PUBLIC_IFACE:-eth0}"
# anvil, solana RPC, solana WS, faucet, + issue #222 app ports:
# connector /ilp (3000) & health (8080), relay free-read WS (7100), relay paid
# store (3100). Belt-and-suspenders: the #221 compose publishes these only to
# 127.0.0.1 (or not at all, for 3100), so they are not internet-reachable to begin
# with — nginx fronts connector:3000 and app:7100 by service name. 3100 (paid
# store) and 8081 (connector admin) are never published and never proxied (AC2).
RAW_PORTS=(8545 8899 8900 3500 3000 8080 7100 3100)

echo "==> ufw: allow SSH + HTTP/HTTPS, deny the rest"
if command -v ufw >/dev/null 2>&1; then
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp  >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
else
  echo "    ufw not installed; skipping (DOCKER-USER rules below still apply)"
fi

echo "==> DOCKER-USER drops for raw chain ports on $IFACE (live + reboot-persistent)"
# Generate a tiny boot script with the drop rules (ports/iface baked in), apply it
# now, and re-apply on boot via a systemd unit. We do NOT use iptables-persistent
# (it conflicts with ufw on Ubuntu 24.04); the unit re-runs after Docker recreates
# the DOCKER-USER chain on each boot.
RULES=/usr/local/sbin/toon-docker-user-drops.sh
{
  echo '#!/bin/sh'
  echo 'iptables -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER || true'
  for port in "${RAW_PORTS[@]}"; do
    echo "iptables -D DOCKER-USER -i $IFACE -p tcp --dport $port -j DROP 2>/dev/null || true"
    echo "iptables -I DOCKER-USER -i $IFACE -p tcp --dport $port -j DROP"
  done
} > "$RULES"
chmod +x "$RULES"
sh "$RULES"
echo "    dropped $IFACE: ${RAW_PORTS[*]}"

cat > /etc/systemd/system/toon-devnet-firewall.service <<UNIT
[Unit]
Description=TOON devnet firewall (DOCKER-USER drops)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$RULES
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable toon-devnet-firewall.service >/dev/null 2>&1 || true

echo "Firewall configured. Public ports: 22, 80, 443. Raw RPC ports blocked."
