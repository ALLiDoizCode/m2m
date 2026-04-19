#!/bin/sh
# ATOR testnet container entrypoint.
# Two-phase bootstrap:
#   Phase 1 — generate keys, extract fingerprints, write to /shared/<nickname>.fp
#   Phase 2 — wait for all 3 DirAuth fingerprints, build DirAuthority lines, start daemon
#
# Required env vars (all roles): ANON_ROLE, NICKNAME, ORPORT, DIRPORT, CONTROL_PORT
# Required for hs role: SOCKS_PORT, HIDDEN_SERVICE_PORT
# Required for dirauth: IDENTITY_SEED
set -eu

case "${ANON_ROLE:-}" in
  dirauth|relay|hs) ROLE="${ANON_ROLE}" ;;
  *)
    echo "ANON_ROLE must be one of: dirauth relay hs" >&2
    exit 64
    ;;
esac

TEMPLATE="/etc/anon/torrc.${ROLE}.tmpl"

if [ ! -f "${TEMPLATE}" ]; then
  echo "ERROR: template ${TEMPLATE} not found" >&2
  exit 64
fi

: "${SOCKS_PORT:=0}"
: "${HIDDEN_SERVICE_PORT:=0}"
export NICKNAME ORPORT DIRPORT CONTROL_PORT SOCKS_PORT HIDDEN_SERVICE_PORT MY_IP

SHARED="/shared"
FP_DIR="${SHARED}/fingerprints"
mkdir -p "${FP_DIR}" 2>/dev/null || true

# --- Phase 1: key generation & fingerprint extraction ---

if [ "${ROLE}" = "dirauth" ] && [ -n "${IDENTITY_SEED:-}" ]; then
  mkdir -p /var/lib/anon/keys
  SEED_MARKER="/var/lib/anon/keys/.seeded"
  if [ ! -f "${SEED_MARKER}" ]; then
    echo "[entrypoint] seeding dirauth identity from IDENTITY_SEED"
    umask 0077
    printf '%s' "${IDENTITY_SEED}" > /var/lib/anon/keys/identity.seed
    chmod 0600 /var/lib/anon/keys/identity.seed
    touch "${SEED_MARKER}"
    chmod 0600 "${SEED_MARKER}"
  fi
fi

if [ "${ROLE}" = "hs" ]; then
  mkdir -p /var/lib/anon/hs
  chmod 0700 /var/lib/anon/hs
fi

# Resolve our own IP on the Docker network (needed for gencert and keygen)
MY_IP=$(getent hosts "${NICKNAME}" | awk '{print $1}' | head -1)
if [ -z "${MY_IP}" ]; then
  MY_IP=$(hostname -i 2>/dev/null | awk '{print $1}')
fi
echo "[entrypoint] resolved ${NICKNAME} → ${MY_IP}"

# Build a minimal torrc for key generation (no DirAuthority lines needed).
KEYGEN_TORRC="/tmp/torrc.keygen"
cat > "${KEYGEN_TORRC}" <<KEYGEN_EOF
Nickname ${NICKNAME}
Address ${MY_IP}
DataDirectory /var/lib/anon
TestingTorNetwork 1
AssumeReachable 1
AgreeToTerms 1
ORPort ${ORPORT}
DirPort ${DIRPORT}
SocksPort 0
RunAsDaemon 0
ContactInfo keygen@local
DirAuthority test orport=1 127.0.0.1:1 0000000000000000000000000000000000000000
KEYGEN_EOF

if [ "${ROLE}" = "dirauth" ]; then
  cat >> "${KEYGEN_TORRC}" <<DA_EOF
AuthoritativeDirectory 1
V3AuthoritativeDirectory 1
DA_EOF
fi

# For DirAuth: generate V3 authority identity + signing keys first
if [ "${ROLE}" = "dirauth" ] && [ ! -f /var/lib/anon/keys/authority_identity_key ]; then
  echo "[entrypoint] generating V3 authority keys for ${NICKNAME}..."
  echo "" | anon-gencert --create-identity-key \
    -i /var/lib/anon/keys/authority_identity_key \
    -s /var/lib/anon/keys/authority_signing_key \
    -c /var/lib/anon/keys/authority_certificate \
    -a "${MY_IP}:${DIRPORT}" \
    -m 12 \
    --passphrase-fd 0 2>&1
fi

# Generate RSA keys + fingerprint file
echo "[entrypoint] generating keys for ${NICKNAME}..."
if ! anon --list-fingerprint --DataDirectory /var/lib/anon -f "${KEYGEN_TORRC}" 2>&1; then
  echo "[entrypoint] WARN: --list-fingerprint exited non-zero, checking if keys were generated anyway..."
fi

# Extract RSA fingerprint from the fingerprint file
RSA_FP=""
if [ -f /var/lib/anon/fingerprint ]; then
  RSA_FP=$(awk '{print $2}' /var/lib/anon/fingerprint | tr -d ' ')
  echo "[entrypoint] RSA fingerprint: ${RSA_FP}"
else
  echo "[entrypoint] ERROR: no fingerprint file generated" >&2
  exit 1
fi

# Extract v3ident from authority_certificate (DirAuth only)
V3IDENT=""
if [ "${ROLE}" = "dirauth" ] && [ -f /var/lib/anon/keys/authority_certificate ]; then
  V3IDENT=$(grep '^fingerprint ' /var/lib/anon/keys/authority_certificate | awk '{print $2}' | tr -d ' ')
fi

# Write fingerprint info for DirAuth nodes to the shared volume
if [ "${ROLE}" = "dirauth" ] && [ -n "${RSA_FP}" ]; then
  echo "${NICKNAME} ${MY_IP} ${ORPORT} ${DIRPORT} ${RSA_FP} ${V3IDENT}" > "${FP_DIR}/${NICKNAME}.fp"
  echo "[entrypoint] wrote fingerprint: ${NICKNAME} RSA=${RSA_FP} v3ident=${V3IDENT} IP=${MY_IP}"
fi

# --- Phase 2: wait for all 3 DirAuth fingerprints ---

echo "[entrypoint] waiting for all 3 DirAuth fingerprints..."
WAIT_COUNT=0
while [ ! -f "${FP_DIR}/dirauth1.fp" ] || [ ! -f "${FP_DIR}/dirauth2.fp" ] || [ ! -f "${FP_DIR}/dirauth3.fp" ]; do
  sleep 1
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ $((WAIT_COUNT % 10)) -eq 0 ]; then
    echo "[entrypoint] still waiting for DirAuth fingerprints... (${WAIT_COUNT}s)"
  fi
  if [ "${WAIT_COUNT}" -ge 120 ]; then
    echo "ERROR: timed out waiting for DirAuth fingerprints after 120s" >&2
    exit 1
  fi
done
echo "[entrypoint] all 3 DirAuth fingerprints available"

# Build DirAuthority lines from the fingerprint files
build_dirauth_line() {
  _file="$1"
  _nick=$(awk '{print $1}' "$_file")
  _ip=$(awk '{print $2}' "$_file")
  _orport=$(awk '{print $3}' "$_file")
  _dirport=$(awk '{print $4}' "$_file")
  _rsa=$(awk '{print $5}' "$_file")
  _v3id=$(awk '{print $6}' "$_file")
  if [ -n "${_v3id}" ]; then
    echo "DirAuthority ${_nick} orport=${_orport} v3ident=${_v3id} ${_ip}:${_dirport} ${_rsa}"
  else
    echo "DirAuthority ${_nick} orport=${_orport} ${_ip}:${_dirport} ${_rsa}"
  fi
}

DIRAUTH1_LINE=$(build_dirauth_line "${FP_DIR}/dirauth1.fp")
DIRAUTH2_LINE=$(build_dirauth_line "${FP_DIR}/dirauth2.fp")
DIRAUTH3_LINE=$(build_dirauth_line "${FP_DIR}/dirauth3.fp")
export DIRAUTH1_LINE DIRAUTH2_LINE DIRAUTH3_LINE

echo "[entrypoint] DirAuthority lines:"
echo "  ${DIRAUTH1_LINE}"
echo "  ${DIRAUTH2_LINE}"
echo "  ${DIRAUTH3_LINE}"

# --- Phase 3: render final torrc and start daemon ---

RENDERED="/etc/anon/torrc"
envsubst < "${TEMPLATE}" > "${RENDERED}"

if [ "${ROLE}" = "hs" ]; then
  socat TCP-LISTEN:"${HIDDEN_SERVICE_PORT}",fork,reuseaddr EXEC:/bin/cat &
fi

cleanup() {
  if [ -n "${ANON_PID:-}" ]; then
    kill -TERM "${ANON_PID}" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

anon -f "${RENDERED}" &
ANON_PID=$!
wait "${ANON_PID}" || EXIT_CODE=$?
exit "${EXIT_CODE:-0}"
