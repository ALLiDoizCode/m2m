#!/bin/sh
# Public-ATOR sidecar entrypoint.
#
# Generates an anonrc that:
#   - joins the PUBLIC Anyone network (no TestingTorNetwork, no DirAuthority
#     overrides — the bundled package's defaults point at the public dir auths)
#   - opens SOCKS5 on 0.0.0.0:9050 so the adjacent connector container can
#     egress through this anon instance
#   - hosts a hidden service whose onion port == TARGET_PORT, forwarding to
#     ${TARGET_HOST}:${TARGET_PORT} on the compose network (i.e., the adjacent
#     connector's BTP server)
#
# Once anon publishes the HS, copies the `hostname` file to
# `/shared/${NICKNAME}-hostname.txt` so the test harness can propagate the
# `.anon` address into the OTHER peer's connector config.
set -eu

: "${NICKNAME:?NICKNAME env var required}"
: "${TARGET_PORT:?TARGET_PORT env var required}"

mkdir -p /var/lib/anon/hs
chmod 0700 /var/lib/anon/hs

# The sidecar and its adjacent connector share a single Docker network
# namespace via `network_mode: service:<sidecar>`. That means the connector's
# BTP server binds to 127.0.0.1:${TARGET_PORT} inside the namespace the
# sidecar also lives in, and the anon binary can forward HS traffic there
# without any DNS round-trip — no chicken-and-egg between sidecar and
# connector start-up.
RC=/etc/anon/torrc
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
