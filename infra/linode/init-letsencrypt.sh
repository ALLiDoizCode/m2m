#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# One-time Let's Encrypt issuance for the devnet subdomains.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# nginx won't start without a cert at the ssl_certificate path, and certbot
# can't get a cert without nginx serving the ACME challenge — classic chicken &
# egg. Resolve it the standard way: drop a throwaway self-signed cert, start
# nginx, ask certbot for the real cert over HTTP-01, swap it in, reload.
#
# TOLERANT FIRST RUN: if issuance fails — almost always because DNS for the
# subdomains doesn't point at this box yet — we re-seed the self-signed cert,
# warn, and exit 0. nginx stays up (browsers warn) and the devnet is reachable;
# point your DNS A-record(s) at this VM's IP, then re-run (LETSENCRYPT_STAGING=0)
# to issue real certs. So a first deploy before DNS is set stays GREEN.
#
# Run from the CONNECTOR REPO ROOT after the chains are up. Requires .env
# (DOMAIN, LETSENCRYPT_EMAIL).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)" # connector repo root
cd "$ROOT"
set -a
. "$HERE/.env"
set +a

DC=(docker compose -f docker-compose.yml -f infra/linode/docker-compose.linode.yml)
PRIMARY="evm-rpc.${DOMAIN}"
DOMAINS=("evm-rpc.${DOMAIN}" "solana-rpc.${DOMAIN}" "solana-ws.${DOMAIN}" "faucet.${DOMAIN}" "mina.${DOMAIN}")
CERT_PATH="/etc/letsencrypt/live/${PRIMARY}"

seed_dummy() {
  "${DC[@]}" run --rm --entrypoint sh certbot -c "
    mkdir -p '${CERT_PATH}' &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout '${CERT_PATH}/privkey.pem' \
      -out    '${CERT_PATH}/fullchain.pem' \
      -subj '/CN=${PRIMARY}'"
}

echo "==> Seeding a temporary self-signed cert for ${PRIMARY}"
seed_dummy

echo "==> Starting nginx (serves the ACME challenge over HTTP)"
"${DC[@]}" up -d nginx

echo "==> Clearing the dummy so certbot can create its own lineage"
"${DC[@]}" run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/${PRIMARY} /etc/letsencrypt/archive/${PRIMARY} /etc/letsencrypt/renewal/${PRIMARY}.conf"

# Build -d args and the staging flag.
d_args=()
for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done
staging_arg=""
[ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

echo "==> Requesting the real certificate (${staging_arg:-production})"
if "${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  $staging_arg \
  --cert-name "${PRIMARY}" \
  "${d_args[@]}" \
  --email "${LETSENCRYPT_EMAIL}" \
  --rsa-key-size 2048 --agree-tos --no-eff-email --force-renewal; then
  echo "==> Reloading nginx with the issued cert"
  "${DC[@]}" exec nginx nginx -s reload
  echo "Done.${staging_arg:+ STAGING certs — browsers will warn; re-run with LETSENCRYPT_STAGING=0 once DNS resolves.}"
else
  echo "::warning:: Certificate issuance FAILED — almost always because DNS for"
  echo "  ${PRIMARY} (and the other subdomains) does not point at this box yet,"
  echo "  or Let's Encrypt rate-limited a shared domain (e.g. sslip.io)."
  echo "  Re-seeding a self-signed cert so nginx stays up — the devnet is reachable"
  echo "  now (browsers will warn). Point DNS A-record(s) at this VM's IP, then"
  echo "  re-run the deploy (LETSENCRYPT_STAGING=0 for trusted certs)."
  seed_dummy
  "${DC[@]}" exec nginx nginx -s reload || true
fi
