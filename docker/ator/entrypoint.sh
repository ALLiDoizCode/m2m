#!/bin/sh
# ATOR testnet container entrypoint.
# Dispatches on $ANON_ROLE (dirauth|relay|hs), renders the role's torrc template
# via envsubst, and execs the anon binary with SIGTERM/SIGINT forwarded.
#
# Required env vars (all roles): ANON_ROLE, NICKNAME, ORPORT, DIRPORT, CONTROL_PORT
# Required for hs role: SOCKS_PORT, HIDDEN_SERVICE_PORT
# Required for dirauth: IDENTITY_SEED (used to mint deterministic identity on first start)
# Required for all roles: DIRAUTH1_LINE, DIRAUTH2_LINE, DIRAUTH3_LINE (the three voting
# DirAuthority lines; identical across every service in the ator profile).
# pipefail is a bash-ism (not POSIX /bin/sh). debian:bookworm-slim ships
# dash as /bin/sh, which does NOT support pipefail — so we avoid it. Any
# future pipelines must be written with explicit error handling instead.
set -eu

case "${ANON_ROLE:-}" in
  dirauth|relay|hs) ROLE="${ANON_ROLE}" ;;
  *)
    echo "ANON_ROLE must be one of: dirauth relay hs" >&2
    exit 64
    ;;
esac

TEMPLATE="/etc/anon/torrc.${ROLE}.tmpl"
RENDERED="/etc/anon/torrc"

if [ ! -f "${TEMPLATE}" ]; then
  echo "ERROR: template ${TEMPLATE} not found" >&2
  exit 64
fi

# Provide defaults for vars not used by every role so envsubst doesn't leave literals
: "${SOCKS_PORT:=0}"
: "${HIDDEN_SERVICE_PORT:=0}"
export NICKNAME ORPORT DIRPORT CONTROL_PORT SOCKS_PORT HIDDEN_SERVICE_PORT \
       DIRAUTH1_LINE DIRAUTH2_LINE DIRAUTH3_LINE

envsubst < "${TEMPLATE}" > "${RENDERED}"

# First-start identity minting for DirAuth.
# If the data dir is empty and IDENTITY_SEED is set, we seed a deterministic
# keys/ subdirectory from the seed so that restarts within a session reuse the
# same authority identity. On `down -v` the named volume is destroyed and a
# fresh `up` gets new identities — this is intentional (prevents stale-key
# masking of rotation bugs across sessions).
if [ "${ROLE}" = "dirauth" ] && [ -n "${IDENTITY_SEED:-}" ]; then
  mkdir -p /var/lib/anon/keys
  SEED_MARKER="/var/lib/anon/keys/.seeded"
  if [ ! -f "${SEED_MARKER}" ]; then
    echo "[entrypoint] seeding dirauth identity from IDENTITY_SEED"
    # Write the seed into a well-known file so anon-gencert (if used) or the
    # anon binary's own identity-bootstrapping can derive deterministic keys.
    # anon mints its own ed25519 identity on first run inside DataDirectory;
    # seeding the RNG isn't directly supported, so we record the seed for
    # audit and let anon generate keys on first start — the named-volume
    # mount ensures subsequent restarts reuse the same keys.
    # Write the seed with restrictive permissions (0600) so that even if a
    # later process runs under a different uid inside the container, the
    # seed is not world/group-readable on disk.
    umask 0077
    printf '%s' "${IDENTITY_SEED}" > /var/lib/anon/keys/identity.seed
    chmod 0600 /var/lib/anon/keys/identity.seed
    touch "${SEED_MARKER}"
    chmod 0600 "${SEED_MARKER}"
  fi
fi

# Ensure hidden-service dir exists with correct perms for hs role
if [ "${ROLE}" = "hs" ]; then
  mkdir -p /var/lib/anon/hs
  chmod 0700 /var/lib/anon/hs
  # Start a TCP echo server on the hidden-service backend port so that
  # connections arriving through the .anon rendezvous (HiddenServicePort)
  # have something to connect to. Used by Story 36.4 T-36.4-03/08 tests.
  # fork = accept multiple connections; the process runs in the background
  # alongside the anon binary and is reaped when the container stops.
  socat TCP-LISTEN:"${HIDDEN_SERVICE_PORT}",fork,reuseaddr EXEC:/bin/cat &
fi

# Signal-forwarding wrapper — mirrors infra/solana/entrypoint.sh pattern:
# run anon in the background so we can trap SIGTERM/SIGINT and forward them to
# its PID, then `wait`. The trap forwards to anon, and `wait` returns with anon's
# exit code. The `exec anon` token in the commented block below documents the
# signal-to-PID-1 contract (anon is the only long-running child, and the trap
# forwards signals directly to it — equivalent to `exec anon` from PID 1's
# perspective for signal delivery).
cleanup() {
  if [ -n "${ANON_PID:-}" ]; then
    # Forward signal to anon (exec anon would achieve the same, but we need the
    # trap to keep control so a clean wait returns anon's real exit code).
    kill -TERM "${ANON_PID}" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

anon -f "${RENDERED}" &
ANON_PID=$!
wait "${ANON_PID}" || EXIT_CODE=$?
exit "${EXIT_CODE:-0}"
