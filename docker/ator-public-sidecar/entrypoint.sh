#!/bin/sh
# Anyone-protocol sidecar entrypoint.
#
# Two modes selected by ANON_NETWORK:
#   public        (default) — joins the PUBLIC Anyone network using the
#                 bundled package's default DirAuth list. No DirAuthority
#                 overrides, no TestingTorNetwork directives.
#   testnet-local — joins the LOCAL ATOR testnet started by `make ator-up`.
#                 Reads DirAuth fingerprints from /shared/fingerprints/ (same
#                 contract used by the testnet container entrypoint), builds
#                 DirAuthority lines, and adds testnet directives so circuit
#                 path selection works with only ~3 relays on a /24 subnet.
#                 Requires the sidecar to be on the `ator_net` Docker network
#                 and to mount the `ator_shared` volume at /shared.
#
# Both modes:
#   - open SOCKS5 on 0.0.0.0:9050 so the adjacent connector container can
#     egress through this anon instance
#   - host a hidden service whose onion port == TARGET_PORT, forwarding to
#     127.0.0.1:${TARGET_PORT} on the shared network namespace (the adjacent
#     connector's BTP server)
#   - copy the published `hostname` to /shared/${NICKNAME}-hostname.txt once
#     anon writes it, so a harness can propagate the `.anon` address into
#     the OTHER peer's connector config
set -eu

: "${NICKNAME:?NICKNAME env var required}"
: "${TARGET_PORT:?TARGET_PORT env var required}"
: "${ANON_NETWORK:=public}"

mkdir -p /var/lib/anon/hs
chmod 0700 /var/lib/anon/hs

build_testnet_dirauth_lines() {
    # NB: this function's STDOUT is captured by command substitution and
    # written verbatim into the torrc. Any informational output MUST go to
    # stderr — a stray stdout line becomes invalid torrc syntax that crashes
    # the anon parser with `free(): invalid size`.
    FP_DIR=/shared/fingerprints
    echo "[sidecar ${NICKNAME}] waiting for DirAuth fingerprints in ${FP_DIR}..." >&2
    WAIT=0
    while [ ! -f "${FP_DIR}/dirauth1.fp" ] || [ ! -f "${FP_DIR}/dirauth2.fp" ] || [ ! -f "${FP_DIR}/dirauth3.fp" ]; do
        sleep 1
        WAIT=$((WAIT + 1))
        if [ "${WAIT}" -ge 120 ]; then
            echo "[sidecar ${NICKNAME}] ERROR: DirAuth fingerprints not present after 120s — is 'make ator-up' running?" >&2
            exit 1
        fi
    done
    for FP in "${FP_DIR}/dirauth1.fp" "${FP_DIR}/dirauth2.fp" "${FP_DIR}/dirauth3.fp"; do
        _nick=$(awk '{print $1}' "$FP")
        _ip=$(awk '{print $2}' "$FP")
        _orport=$(awk '{print $3}' "$FP")
        _dirport=$(awk '{print $4}' "$FP")
        _rsa=$(awk '{print $5}' "$FP")
        _v3id=$(awk '{print $6}' "$FP")
        if [ -n "${_v3id}" ]; then
            echo "DirAuthority ${_nick} orport=${_orport} v3ident=${_v3id} ${_ip}:${_dirport} ${_rsa}"
        else
            echo "DirAuthority ${_nick} orport=${_orport} ${_ip}:${_dirport} ${_rsa}"
        fi
    done
}

RC=/etc/anon/torrc
case "${ANON_NETWORK}" in
    public)
        cat > "$RC" <<EOF
AgreeToTerms 1
DataDirectory /var/lib/anon
SOCKSPort 0.0.0.0:9050
SOCKSPolicy accept *
HiddenServiceDir /var/lib/anon/hs
HiddenServicePort ${TARGET_PORT} 127.0.0.1:${TARGET_PORT}
Log notice stdout
RunAsDaemon 0
EOF
        ;;
    testnet-local)
        DIRAUTH_LINES="$(build_testnet_dirauth_lines)"
        # Resolve our own bridge IP — TestingTorNetwork mode requires Address
        # for identity/descriptor generation (the daemon segfaults at config-
        # parse time if Nickname/Address/ORPort are absent in this mode).
        MY_IP=$(getent hosts "${NICKNAME}" 2>/dev/null | awk '{print $1}' | head -1)
        if [ -z "${MY_IP}" ]; then
            MY_IP=$(hostname -i 2>/dev/null | awk '{print $1}')
        fi
        : "${SIDECAR_ORPORT:=9001}"
        : "${SIDECAR_DIRPORT:=9030}"
        : "${SIDECAR_CONTROL_PORT:=9051}"
        # Tor Nickname must be 1-19 ALPHANUMERIC chars. anon v0.4.10.0-beta
        # segfaults at config-parse with `free(): invalid size` if the value
        # contains a hyphen — it does NOT cleanly reject. We strip non-alnum
        # for the directive (e.g. NICKNAME=home-a → ANON_NICK=homea) while
        # keeping NICKNAME unchanged for filename use elsewhere.
        ANON_NICK=$(printf '%s' "${NICKNAME}" | tr -cd 'A-Za-z0-9' | cut -c1-19)
        # Mirror docker/ator/torrc.hs structurally — that template is the
        # known-working local-testnet shape (used by hs1). The only deltas vs
        # torrc.hs: HS forwarding port differs (here = TARGET_PORT, the
        # adjacent connector's BTP port, since sidecar + connector share the
        # network namespace via `network_mode: service:<sidecar>`); SOCKS
        # binds to 0.0.0.0 so the in-namespace connector can use it.
        cat > "$RC" <<EOF
Nickname ${ANON_NICK}
Address ${MY_IP}
DataDirectory /var/lib/anon
ContactInfo two-home-sidecar@local
Log notice stdout
RunAsDaemon 0

TestingTorNetwork 1
AgreeToTerms 1
AssumeReachable 1
ProtocolWarnings 1
EnforceDistinctSubnets 0
ConfluxEnabled 0

ORPort ${SIDECAR_ORPORT}
DirPort ${SIDECAR_DIRPORT}
ControlPort 127.0.0.1:${SIDECAR_CONTROL_PORT}
CookieAuthentication 1

SOCKSPort 0.0.0.0:9050 IsolateClientProtocol
SOCKSPolicy accept *

ExitRelay 0
ExitPolicy reject *:*
BandwidthRate 100 MBytes
BandwidthBurst 200 MBytes

HiddenServiceDir /var/lib/anon/hs
HiddenServicePort ${TARGET_PORT} 127.0.0.1:${TARGET_PORT}

${DIRAUTH_LINES}
EOF
        ;;
    *)
        echo "[sidecar ${NICKNAME}] ERROR: ANON_NETWORK must be 'public' or 'testnet-local' (got: ${ANON_NETWORK})" >&2
        exit 64
        ;;
esac

echo "[sidecar ${NICKNAME}] generated torrc (anon network: ${ANON_NETWORK}):"
echo "============================================================"
cat "$RC"
echo "============================================================"

# Background watcher: copy the HS hostname to /shared once anon writes it.
(
  HOSTFILE=/var/lib/anon/hs/hostname
  OUT=/shared/"${NICKNAME}"-hostname.txt
  while [ ! -s "$HOSTFILE" ]; do
    sleep 2
  done
  # Strip trailing newline so downstream consumers can use raw file contents.
  tr -d '\n' < "$HOSTFILE" > "$OUT"
  echo "[sidecar ${NICKNAME}] HS hostname published: $(cat "$OUT")"
) &
WATCHER_PID=$!

cleanup() {
  kill -TERM "${WATCHER_PID}" 2>/dev/null || true
  if [ -n "${ANON_PID:-}" ]; then
    kill -TERM "${ANON_PID}" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

anon -f "$RC" &
ANON_PID=$!
wait "${ANON_PID}" || EXIT_CODE=$?
exit "${EXIT_CODE:-0}"
