#!/usr/bin/env bash
# Issue Let's Encrypt certs for the TOON store (Arweave DVM) box subdomains.
# Adapted from infra/linode-node/init-letsencrypt.sh (same idempotency logic).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
set -a; . "$HERE/.env"; set +a

DC=(docker compose -f infra/linode-store/docker-compose.store.yml)
# `proxy.ario`, not `proxy.store` — this box's paid edge was renamed
# 2026-08-05 (docker-compose.store.yml's PUBLIC_BTP_ENDPOINT comment). A
# fresh box has no prior lineage to preserve, so its cert is issued under
# the current name from the start.
PRIMARY="proxy.ario.${DOMAIN}"
DOMAINS=("proxy.ario.${DOMAIN}" "dvm.${DOMAIN}")
CERT_PATH="/etc/letsencrypt/live/${PRIMARY}"
RENEW_WINDOW_DAYS="${RENEW_WINDOW_DAYS:-30}"

seed_dummy() {
  "${DC[@]}" run --rm --entrypoint sh certbot -c "
    mkdir -p '${CERT_PATH}' &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout '${CERT_PATH}/privkey.pem' \
      -out    '${CERT_PATH}/fullchain.pem' \
      -subj '/CN=${PRIMARY}'"
}

existing_cert_ok() {
  local want_staging="0"
  [ "${LETSENCRYPT_STAGING:-1}" = "1" ] && want_staging="1"
  local sans
  sans="$(printf '%s\n' "${DOMAINS[@]}")"
  "${DC[@]}" run --rm --entrypoint sh certbot -c '
    set -e
    CERT="'"${CERT_PATH}"'/fullchain.pem"
    [ -s "$CERT" ] || exit 0
    openssl x509 -checkend "$(( '"${RENEW_WINDOW_DAYS}"' * 86400 ))" -noout -in "$CERT" >/dev/null 2>&1 || exit 0
    issuer="$(openssl x509 -issuer -noout -in "$CERT")"
    subj="$(openssl x509 -subject -noout -in "$CERT")"
    [ "$issuer" = "$(printf "%s" "$subj" | sed "s/^subject/issuer/")" ] && exit 0
    printf "%s" "$issuer" | grep -qi "Let'"'"'s Encrypt\|(STAGING)\|ACME\|R[0-9]\|E[0-9]" || exit 0
    is_staging=0
    printf "%s" "$issuer" | grep -qi "STAGING\|Fake LE" && is_staging=1
    [ "$is_staging" = "'"${want_staging}"'" ] || exit 0
    san="$(openssl x509 -ext subjectAltName -noout -in "$CERT" 2>/dev/null || openssl x509 -text -noout -in "$CERT")"
    san="$(printf "%s" "$san" | tr "," "\n" | tr -d " " | sed "s/\$/,/")"
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      printf "%s\n" "$san" | grep -qF "DNS:$d," || exit 0
    done <<SANS
'"${sans}"'
SANS
    echo ok
  ' 2>/dev/null | tr -d '[:space:]'
}

echo "==> Checking for existing valid cert"
if [ "$(existing_cert_ok)" = "ok" ]; then
  echo "==> Valid cert found — reusing (no re-issue)."
  "${DC[@]}" up -d nginx
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  exit 0
fi

echo "==> Seeding self-signed cert"
seed_dummy

echo "==> Starting nginx for ACME challenge"
"${DC[@]}" up -d nginx

"${DC[@]}" run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/${PRIMARY} /etc/letsencrypt/archive/${PRIMARY} /etc/letsencrypt/renewal/${PRIMARY}.conf"

d_args=()
for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done
staging_arg=""
[ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

echo "==> Requesting cert (${staging_arg:-production})"
if "${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  $staging_arg \
  --cert-name "${PRIMARY}" \
  "${d_args[@]}" \
  --email "${LETSENCRYPT_EMAIL}" \
  --rsa-key-size 2048 --agree-tos --no-eff-email --keep-until-expiring; then
  "${DC[@]}" exec nginx nginx -s reload
  echo "Done.${staging_arg:+ STAGING cert — re-run with LETSENCRYPT_STAGING=0 once DNS resolves.}"
else
  echo "::warning:: Cert issuance failed (DNS may not have propagated yet)."
  echo "  Point DNS A-records to this box, then re-run with LETSENCRYPT_STAGING=0."
  seed_dummy
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
fi
