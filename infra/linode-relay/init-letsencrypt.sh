#!/usr/bin/env bash
# Issue Let's Encrypt certs for the TOON relay box subdomains.
# Adapted from infra/linode-node/init-letsencrypt.sh (same idempotency logic).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
set -a; . "$HERE/.env"; set +a

DC=(docker compose -f infra/linode-relay/docker-compose.relay.yml)

# ONE CERTIFICATE PER NAME — two independent certbot requests, deliberately
# NOT one two-SAN request (#830). Certbot's SAN request is all-or-nothing: a
# single bundled cert means whichever name fails validation takes the other
# name's certificate down with it, which is precisely why this box could not
# obtain any certificate at all before #830 (relay-ws.${DOMAIN} still pointed
# at the apex then, so its challenge could only fail).
#
# All three names resolve HERE once the live cutover flips DNS -- #870
# (toon-meta#310's apex-retirement spec) is repo-side only, so this box is
# only PREPARED to serve faucet.${DOMAIN}, not yet reachable there: the apex
# still answers for it until DNS moves and the apex's own copy is retired
# (a separate, later, human-gated step -- this file does not touch the
# apex). Same shape #820 already landed for relay-ws.${DOMAIN}. Each name
# gets its own lineage, its own `server` block in nginx/conf.d/node.conf,
# and its own independent renewal.
CERT_NAMES=("proxy.relay.${DOMAIN}" "relay-ws.${DOMAIN}" "faucet.${DOMAIN}")
RENEW_WINDOW_DAYS="${RENEW_WINDOW_DAYS:-30}"

# Set per lineage by the loops below; seed_dummy/existing_cert_ok read them.
PRIMARY=""
DOMAINS=()
CERT_PATH=""

use_cert() {
  PRIMARY="$1"
  DOMAINS=("$1")
  CERT_PATH="/etc/letsencrypt/live/${PRIMARY}"
}

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

# Pass 1: work out which lineages need issuing, and make sure EVERY lineage has
# at least a self-signed cert on disk BEFORE nginx starts. nginx refuses to
# start at all if any `ssl_certificate` file named in the config is missing, and
# relay-ws.${DOMAIN} now names a lineage of its own — so the dummies have to be
# seeded for both names up front, not one at a time inside the issuing loop.
NEEDS_ISSUE=()
for name in "${CERT_NAMES[@]}"; do
  use_cert "$name"
  echo "==> Checking for existing valid cert: ${PRIMARY}"
  if [ "$(existing_cert_ok)" = "ok" ]; then
    echo "  valid cert found — reusing (no re-issue)."
    continue
  fi
  echo "  seeding self-signed cert"
  seed_dummy
  NEEDS_ISSUE+=("$name")
done

echo "==> Starting nginx"
"${DC[@]}" up -d nginx

if [ "${#NEEDS_ISSUE[@]}" -eq 0 ]; then
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  echo "Done."
  exit 0
fi

staging_arg=""
[ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

# Pass 2: issue each lineage on its own. A failure here is reported and moved
# past rather than fatal — one name failing must not abort the other's request,
# which is the whole point of not bundling them into one SAN.
for name in "${NEEDS_ISSUE[@]}"; do
  use_cert "$name"

  "${DC[@]}" run --rm --entrypoint sh certbot -c "rm -rf /etc/letsencrypt/live/${PRIMARY} /etc/letsencrypt/archive/${PRIMARY} /etc/letsencrypt/renewal/${PRIMARY}.conf"

  d_args=()
  for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done

  echo "==> Requesting cert for ${PRIMARY} (${staging_arg:-production})"
  if "${DC[@]}" run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot \
    $staging_arg \
    --cert-name "${PRIMARY}" \
    "${d_args[@]}" \
    --email "${LETSENCRYPT_EMAIL}" \
    --rsa-key-size 2048 --agree-tos --no-eff-email --keep-until-expiring; then
    "${DC[@]}" exec nginx nginx -s reload
    echo "  ${PRIMARY}: done.${staging_arg:+ STAGING cert — re-run with LETSENCRYPT_STAGING=0 once DNS resolves.}"
  else
    echo "::warning:: Cert issuance failed for ${PRIMARY} (DNS may not have propagated yet)."
    echo "  Point the ${PRIMARY} A-record at this box, then re-run with LETSENCRYPT_STAGING=0."
    seed_dummy
    "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  fi
done
