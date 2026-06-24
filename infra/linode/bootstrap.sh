#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Provision a fresh Linode (Ubuntu/Debian) into a TOON public devnet.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run as root on a clean box:
#   git clone https://github.com/toon-protocol/connector.git
#   cd connector/infra/linode && cp .env.example .env && $EDITOR .env
#   ./bootstrap.sh
#
# Idempotent: safe to re-run to pick up image/code updates. DNS A-records for
# all five subdomains must already point at this box before TLS issuance.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"          # connector repo root
[ -f "$HERE/.env" ] || { echo "Missing $HERE/.env — copy .env.example and edit."; exit 1; }
set -a; . "$HERE/.env"; set +a

echo "==> [1/7] System packages (docker, git, make, jq, envsubst, openssl)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get update -y
# NB: no iptables-persistent — it conflicts with ufw on Ubuntu 24.04 (ufw Breaks
# iptables-persistent). firewall.sh persists the DOCKER-USER drops via a systemd unit.
apt-get install -y git make jq gettext-base openssl ufw curl iptables

# Swapfile so the one-time Rust builds (Solana program via solana-build, and
# spl-token-cli via cargo install) don't OOM on a small 2GB box. Steady-state
# (anvil + solana-test-validator + faucet + nginx) fits in RAM; swap just absorbs
# the compile peaks. Idempotent.
if ! swapon --show 2>/dev/null | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    4G swapfile enabled"
fi

echo "==> [2/7] Firewall (public = 22/80/443 only; raw RPC ports blocked)"
"$HERE/firewall.sh"

echo "==> [3/7] Build the Solana program + ensure host CLIs (solana, spl-token)"
# `make solana-build` compiles packages/solana-program into target/deploy so the
# entrypoint can deploy it at its deterministic id. The host also needs the
# `solana` + `spl-token` CLIs to create/fund the mock-USDC mint (the validator
# image has neither). Skipped entirely for EVM-only deployments.
case ",${COMPOSE_PROFILES}," in
  *,solana,*)
    # The Solana installer ships `cargo-build-sbf` (the backend for `cargo
    # build-sbf` that `make solana-build` invokes). Install it FIRST and put its
    # bin dir on PATH before building, otherwise the build fails with
    # "cargo-build-sbf: command not found" (Error 127) and target/deploy stays
    # empty (issue #238). Prepend idempotently without clobbering existing PATH.
    SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
    if ! command -v solana >/dev/null 2>&1; then
      echo "    Installing Solana CLI…"; sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
    fi
    case ":${PATH}:" in
      *":${SOLANA_BIN}:"*) ;;
      *) export PATH="${SOLANA_BIN}:$PATH" ;;
    esac
    make -C "$ROOT" solana-build || echo "    solana-build failed — solana chain may come up without its program"
    if ! command -v spl-token >/dev/null 2>&1; then
      echo "    Installing spl-token CLI (cargo)…"
      command -v cargo >/dev/null 2>&1 || { echo "    NEED Rust/cargo for spl-token-cli — install rustup, then re-run."; }
      cargo install spl-token-cli 2>/dev/null || echo "    spl-token-cli install failed — USDC mint step will be skipped until it's on PATH."
    fi
    ;;
esac

echo "==> [4/7] Render nginx config for ${DOMAIN}"
mkdir -p "$HERE/nginx/conf.d"
envsubst '${DOMAIN}' < "$HERE/nginx/${NGINX_TEMPLATE:-devnet.conf.template}" > "$HERE/nginx/conf.d/devnet.conf"

echo "==> [5/7] Start the chains (${COMPOSE_PROFILES})"
DC=(docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/infra/linode/docker-compose.linode.yml")
profile_args=(); IFS=',' read -ra _p <<< "$COMPOSE_PROFILES"; for p in "${_p[@]}"; do profile_args+=(--profile "$p"); done

# Bring up every service in the active profiles. The explicit-named first attempt
# (EVM-only optimisation) is kept as a fast path; its failure (e.g. solana-validator
# absent under evm-only) falls through to a full profile up.
( cd "$ROOT" && "${DC[@]}" "${profile_args[@]}" up -d anvil faucet solana-validator 2>/dev/null; "${DC[@]}" "${profile_args[@]}" up -d )

echo "==> [6/7] Wait for chain health + bootstrap the mock-USDC SPL mint"
"$HERE/devnet.sh" wait
"$HERE/devnet.sh" mint

echo "==> [7/7] Issue TLS certs + write endpoints.json"
"$HERE/init-letsencrypt.sh"
"$HERE/devnet.sh" endpoints

echo
echo "✅ Devnet up. Public endpoints (see infra/linode/endpoints.json):"
echo "   EVM RPC   : https://evm-rpc.${DOMAIN}"
echo "   Solana RPC: https://solana-rpc.${DOMAIN}   WS: wss://solana-ws.${DOMAIN}"
echo "   Faucet    : https://faucet.${DOMAIN}"
echo "   Mina (proxy of public devnet): https://mina.${DOMAIN}/graphql"
