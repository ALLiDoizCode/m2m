#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Let's Encrypt issuance for the devnet subdomains — issue ONCE, then never again.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# nginx won't start without a cert at the ssl_certificate path, and certbot
# can't get a cert without nginx serving the ACME challenge — classic chicken &
# egg. Resolve it the standard way: drop a throwaway self-signed cert, start
# nginx, ask certbot for the real cert over HTTP-01, swap it in, reload.
#
# IDEMPOTENT — NO NEEDLESS RE-ISSUE: if the certbot volume already holds a VALID
# real (non-self-signed, non-expired, right-SAN, right staging mode) certificate
# for these subdomains, we DO NOT request a new one — we just start nginx with it
# and exit. Re-issuing an identical cert burns Let's Encrypt's "5 duplicate certs
# / 7 days" limit; ongoing renewal (within 30 days of expiry) is the certbot
# container's job, not ours. This guard is what makes a redeploy safe.
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
# CERT_PRIMARY / CERT_DOMAINS can be set in .env to customise per-box issuance
# (e.g. an EVM-only box only needs evm-rpc.DOMAIN). Fallback = the original
# all-in-one monolithic list.
PRIMARY="${CERT_PRIMARY:-evm-rpc.${DOMAIN}}"
if [ -n "${CERT_DOMAINS:-}" ]; then
  read -ra DOMAINS <<< "$CERT_DOMAINS"
else
  DOMAINS=("evm-rpc.${DOMAIN}" "solana-rpc.${DOMAIN}" "solana-ws.${DOMAIN}" "faucet.${DOMAIN}" "mina.${DOMAIN}")
fi
CERT_PATH="/etc/letsencrypt/live/${PRIMARY}"
# Renew (request anew) only when within this many days of expiry. Matches the
# certbot renewer's 30-day window so we never request a duplicate of a healthy cert.
RENEW_WINDOW_DAYS="${RENEW_WINDOW_DAYS:-30}"

seed_dummy() {
  "${DC[@]}" run --rm --entrypoint sh certbot -c "
    mkdir -p '${CERT_PATH}' &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout '${CERT_PATH}/privkey.pem' \
      -out    '${CERT_PATH}/fullchain.pem' \
      -subj '/CN=${PRIMARY}'"
}

# Does the certbot volume already hold a usable real cert for ALL our subdomains,
# in the requested staging mode, not expiring within RENEW_WINDOW_DAYS? Echoes
# "ok" iff so. We inspect the live fullchain.pem with openssl INSIDE the certbot
# container (the only place the volume is mounted) so a rebuild that restored the
# volume — or a routine update that kept it — is recognised and left untouched.
existing_cert_ok() {
  local want_staging="0"
  [ "${LETSENCRYPT_STAGING:-1}" = "1" ] && want_staging="1"
  local sans
  sans="$(printf '%s\n' "${DOMAINS[@]}")"
  "${DC[@]}" run --rm --entrypoint sh certbot -c '
    set -e
    CERT="'"${CERT_PATH}"'/fullchain.pem"
    [ -s "$CERT" ] || exit 0                       # no cert at all
    # Expired or within the renew window? request a fresh one. (-checkend prints
    # chatter to stdout; silence it so only "ok" can reach our caller.)
    openssl x509 -checkend "$(( '"${RENEW_WINDOW_DAYS}"' * 86400 ))" -noout -in "$CERT" >/dev/null 2>&1 || exit 0
    issuer="$(openssl x509 -issuer -noout -in "$CERT")"
    subj="$(openssl x509 -subject -noout -in "$CERT")"
    # Self-signed (our dummy): issuer == subject, or CN-only issuer. Reject it.
    [ "$issuer" = "$(printf "%s" "$subj" | sed "s/^subject/issuer/")" ] && exit 0
    printf "%s" "$issuer" | grep -qi "Let'"'"'s Encrypt\|(STAGING)\|ACME\|R[0-9]\|E[0-9]" || exit 0
    # Staging mode must match what we were asked for. LE staging certs are issued
    # by "(STAGING)" CAs ("Fake LE", "(STAGING) ..."); production are not.
    is_staging=0
    printf "%s" "$issuer" | grep -qi "STAGING\|Fake LE" && is_staging=1
    [ "$is_staging" = "'"${want_staging}"'" ] || exit 0
    # Every required SAN must be present in the cert. Normalise the SAN list to
    # one "DNS:host," token per line so a plain fixed-string match is exact and
    # busybox-safe (no \b word-boundary, which busybox grep lacks).
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

echo "==> Checking for an existing valid certificate (${LETSENCRYPT_STAGING:+staging=${LETSENCRYPT_STAGING}})"
if [ "$(existing_cert_ok)" = "ok" ]; then
  echo "==> A valid certificate for ${PRIMARY} (+SANs) already exists and is not"
  echo "    expiring within ${RENEW_WINDOW_DAYS} days — NOT re-issuing (avoids Let's"
  echo "    Encrypt's duplicate-cert rate limit). Renewal is the certbot container's job."
  echo "==> Starting nginx with the existing cert"
  "${DC[@]}" up -d nginx
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  echo "Done (existing cert reused)."
  exit 0
fi

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

# NB: no --force-renewal. We only ever reach this point when there is NO valid
# cert (guarded above), so certbot issues exactly once; --force-renewal would
# re-issue a duplicate on every run and is precisely what burned the rate limit.
echo "==> Requesting the real certificate (${staging_arg:-production})"
if "${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  $staging_arg \
  --cert-name "${PRIMARY}" \
  "${d_args[@]}" \
  --email "${LETSENCRYPT_EMAIL}" \
  --rsa-key-size 2048 --agree-tos --no-eff-email --keep-until-expiring; then
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
