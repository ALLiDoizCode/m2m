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
RAW_PORTS=(8545 8899 8900 3500)   # anvil, solana RPC, solana WS, faucet

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

echo "==> DOCKER-USER: drop internet access to raw chain ports on $IFACE"
# Ensure the chain exists (it does once Docker is installed).
iptables -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER || true
for port in "${RAW_PORTS[@]}"; do
  # Remove any prior copy of this rule, then insert — keeps the script idempotent.
  iptables -D DOCKER-USER -i "$IFACE" -p tcp --dport "$port" -j DROP 2>/dev/null || true
  iptables -I DOCKER-USER -i "$IFACE" -p tcp --dport "$port" -j DROP
  echo "    dropped $IFACE:$port"
done

echo "==> Persisting iptables rules"
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
else
  echo "    netfilter-persistent not installed — install 'iptables-persistent'"
  echo "    so the DOCKER-USER drops survive reboot, then re-run this script."
fi

echo "Firewall configured. Public ports: 22, 80, 443. Raw RPC ports blocked."
