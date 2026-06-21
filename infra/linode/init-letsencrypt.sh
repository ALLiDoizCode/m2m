#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# One-time Let's Encrypt issuance for the devnet subdomains.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# nginx won't start without a cert at the ssl_certificate path, and certbot
# can't get a cert without nginx serving the ACME challenge — classic chicken &
# egg. Resolve it the standard way: drop a throwaway self-signed cert, start
# nginx, ask certbot for the real cert over HTTP-01, swap it in, reload.
# Re-running is safe (certbot just renews/no-ops). Run from the CONNECTOR REPO
# ROOT after the chains are up. Requires .env (DOMAIN, LETSENCRYPT_EMAIL).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"          # connector repo root
cd "$ROOT"
set -a; . "$HERE/.env"; set +a

DC=(docker compose -f docker-compose.yml -f infra/linode/docker-compose.linode.yml)
PRIMARY="evm-rpc.${DOMAIN}"
DOMAINS=("evm-rpc.${DOMAIN}" "solana-rpc.${DOMAIN}" "solana-ws.${DOMAIN}" "faucet.${DOMAIN}" "mina.${DOMAIN}")
CERT_PATH="/etc/letsencrypt/live/${PRIMARY}"

echo "==> Seeding a temporary self-signed cert for ${PRIMARY}"
"${DC[@]}" run --rm --entrypoint sh certbot -c "
  mkdir -p '${CERT_PATH}' &&
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '${CERT_PATH}/privkey.pem' \
    -out    '${CERT_PATH}/fullchain.pem' \
    -subj '/CN=${PRIMARY}'"

echo "==> Starting nginx (serves the ACME challenge over HTTP)"
"${DC[@]}" up -d nginx

echo "==> Deleting the dummy cert"
"${DC[@]}" run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/${PRIMARY} /etc/letsencrypt/archive/${PRIMARY} /etc/letsencrypt/renewal/${PRIMARY}.conf"

# Build -d args and the staging flag.
d_args=(); for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done
staging_arg=""; [ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

echo "==> Requesting the real certificate (${staging_arg:-production})"
"${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  $staging_arg \
  --cert-name "${PRIMARY}" \
  "${d_args[@]}" \
  --email "${LETSENCRYPT_EMAIL}" \
  --rsa-key-size 2048 --agree-tos --no-eff-email --force-renewal

echo "==> Reloading nginx with the real cert"
"${DC[@]}" exec nginx nginx -s reload

echo "Done. If LETSENCRYPT_STAGING=1, browsers will warn (untrusted staging CA)."
echo "Set LETSENCRYPT_STAGING=0 in .env and re-run for trusted certs."
