#!/usr/bin/env bash
# =============================================================================
# Two-Home ATOR over LOCAL testnet — Docker verification script
#
# Prereqs:
#   make ator-up                       (DirAuth + relay + hs1 + shared volume)
#   make two-home-ator-local-up        (both sidecars + bls + connectors)
#
# What it does:
#   1. Polls each sidecar's /var/lib/anon/hs/hostname until the .anon URL
#      is published (HS descriptor uploaded to a testnet HSDir, ~30-90s)
#   2. Registers each peer via POST /admin/peers on the OTHER side
#   3. Waits for the BTP connection to come up
#   4. Sends a test ILP packet from home-a to home-b via /admin/ilp/send
#   5. Confirms the packet appears in home-b's BLS /received list
#
# Honest scope:
#   A green run here proves: real anon binary, real testnet HS rendezvous,
#   real circuit, real BTP handshake, real ILP packet flow. It does NOT
#   prove the home-NAT NAT-traversal claim (containers don't have NAT in
#   the home-router sense). For that, run option A (`make standalone-test-
#   ator-p2p`) which uses public ATOR.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="two-home-ator-local"
SIDECAR_A="two-home-local-sidecar-a"
SIDECAR_B="two-home-local-sidecar-b"

# Host port mappings published by the sidecars (which own the network namespace
# for their respective connector + bls).
HEALTH_A="http://127.0.0.1:18190/health"
ADMIN_A="http://127.0.0.1:18191"
BLS_A_RECEIVED="http://127.0.0.1:13311/received"
HEALTH_B="http://127.0.0.1:18290/health"
ADMIN_B="http://127.0.0.1:18291"
BLS_B_RECEIVED="http://127.0.0.1:13312/received"

HS_BUDGET_S=180
BTP_BUDGET_S=120
PING_BUDGET_S=30

if [[ -t 1 ]]; then
    C_RESET='\033[0m'; C_BOLD='\033[1m'
    C_RED='\033[31m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_BLUE='\033[34m'
else
    C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi
log()  { printf '%b[verify]%b %s\n' "${C_BLUE}" "${C_RESET}" "$*"; }
ok()   { printf '%b[ok]%b %s\n'      "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%b[warn]%b %s\n'    "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%b[fail]%b %s\n'    "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "Missing: $1"; }

cd "$PROJECT_ROOT"

require docker
require curl

compose() {
    docker compose --profile "$PROFILE" "$@"
}

# 0. Sanity: ator profile must already be up
log "Checking that 'make ator-up' is running"
if ! docker compose --profile ator ps --status running --quiet | grep -q .; then
    die "Local ATOR testnet is not running — run 'make ator-up' first"
fi
ok "Local ATOR testnet running"

# 1. Verify the two-home profile is up
log "Checking two-home-ator-local profile status"
if ! compose ps --status running --quiet | grep -q .; then
    die "Profile not up — run 'make two-home-ator-local-up' first"
fi
ok "Profile up"

# 2. Wait for both .anon hostnames
read_hs_hostname() {
    local svc="$1"
    local out
    out="$(compose exec -T "$svc" cat /var/lib/anon/hs/hostname 2>/dev/null || true)"
    out="${out//[$'\t\r\n ']/}"
    if [[ "$out" =~ ^[a-z2-7]{16,56}\.(anon|anyone|onion)$ ]]; then
        printf '%s' "$out"
        return 0
    fi
    return 1
}

wait_for_hs() {
    local svc="$1" deadline result
    deadline=$(( $(date +%s) + HS_BUDGET_S ))
    while [[ $(date +%s) -lt $deadline ]]; do
        if result="$(read_hs_hostname "$svc")"; then
            printf '%s' "$result"
            return 0
        fi
        sleep 5
    done
    die "$svc HS hostname not published within ${HS_BUDGET_S}s"
}

log "Waiting for both hidden services to publish (budget ${HS_BUDGET_S}s each)..."
HS_A="$(wait_for_hs "$SIDECAR_A")"
ok "home-a → ${HS_A}"
HS_B="$(wait_for_hs "$SIDECAR_B")"
ok "home-b → ${HS_B}"

# 3. Register peers via admin API
log "Registering home-b on home-a's admin API"
curl --silent --show-error --max-time 10 -X POST \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"home-b\",\"url\":\"ws://${HS_B}:3000\",\"authToken\":\"\"}" \
    "${ADMIN_A}/admin/peers" >/dev/null

log "Registering home-a on home-b's admin API"
curl --silent --show-error --max-time 10 -X POST \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"home-a\",\"url\":\"ws://${HS_A}:3000\",\"authToken\":\"\"}" \
    "${ADMIN_B}/admin/peers" >/dev/null
ok "Peers registered"

# 4. Wait for BTP connection (a -> b)
log "Waiting for home-a → home-b BTP connection (budget ${BTP_BUDGET_S}s)..."
deadline=$(( $(date +%s) + BTP_BUDGET_S ))
connected=0
while [[ $(date +%s) -lt $deadline ]]; do
    body="$(curl --silent --max-time 5 "${ADMIN_A}/admin/peers" || true)"
    if echo "$body" | grep -qE '"id"[[:space:]]*:[[:space:]]*"home-b"[^}]*"connected"[[:space:]]*:[[:space:]]*true'; then
        connected=1
        break
    fi
    sleep 3
done
[[ $connected -eq 1 ]] || die "home-a → home-b never connected — check 'docker compose logs ${SIDECAR_A} two-home-local-connector-a'"
ok "BTP connection up"

# 5. Send a test packet a -> b
log "Sending test ILP packet home-a → home-b"
before="$(curl --silent --max-time 5 "$BLS_B_RECEIVED" | grep -oE '"count"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' || echo 0)"
response="$(curl --silent --show-error --max-time 30 -X POST \
    -H "Content-Type: application/json" \
    -d '{"destination":"test.home-b.handshake-ping","amount":"0","data":""}' \
    -w '\n%{http_code}' \
    "${ADMIN_A}/admin/ilp/send")"
http_code="$(echo "$response" | tail -n1)"
body="$(echo "$response" | sed '$d')"
[[ "$http_code" == "200" ]] || die "Admin /ilp/send returned ${http_code}: ${body}"

# 6. Confirm packet landed at BLS-B
log "Waiting for packet to appear at home-b BLS (budget ${PING_BUDGET_S}s)..."
deadline=$(( $(date +%s) + PING_BUDGET_S ))
while [[ $(date +%s) -lt $deadline ]]; do
    after="$(curl --silent --max-time 5 "$BLS_B_RECEIVED" | grep -oE '"count"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$' || echo 0)"
    if [[ "${after:-0}" -gt "${before:-0}" ]]; then
        ok "BLS-B received packet (count: ${before} → ${after})"
        printf '\n'
        printf '%b============================================================%b\n' "${C_GREEN}" "${C_RESET}"
        printf '%b TWO-HOME ATOR LOCAL VERIFICATION: PASS %b\n'                    "${C_GREEN}${C_BOLD}" "${C_RESET}"
        printf '%b============================================================%b\n' "${C_GREEN}" "${C_RESET}"
        printf '   home-a (.anon)  : %s\n' "$HS_A"
        printf '   home-b (.anon)  : %s\n' "$HS_B"
        printf '   ILP round-trip  : home-a /admin/ilp/send → ATOR rendezvous → home-b BLS\n'
        printf '\n'
        exit 0
    fi
    sleep 2
done
die "Packet did not appear at BLS-B within ${PING_BUDGET_S}s"
