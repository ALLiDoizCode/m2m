#!/usr/bin/env bash
# =============================================================================
# Two-Home ATOR Handshake — Operator Verification Script
#
# Walks two operators through standing up an ILP connector behind a managed
# ATOR (Anyone Protocol) hidden service on each laptop, peering them through
# .anon addresses, and verifying end-to-end ILP packet delivery.
#
# Scenario:
#   Laptop A (home A) and Laptop B (home B), each behind home NAT, each
#   running this repo. No public IPs, no port forwarding, no domain names.
#   Each side publishes a .anon hidden service via managed `anon`; peers
#   exchange URLs + a shared BTP authToken out-of-band; either side runs
#   `ping <peer-id>` and observes a FULFILL.
#
# Subcommands:
#   preflight                          Check Node/npm/build/optional anon SDK
#   init <node-id>                     Generate state-dir/connector.yaml
#   start [--detach]                   Boot connector + managed anon
#   share                              Print local .anon URL + node-id
#   add-peer <peer-id> <wss://X.anon:443> [--auth-token TOK] [--chain ID]
#                                      Append a peer + default route.
#                                      Token is OPTIONAL — BTP is permissionless
#                                      by default; pass --auth-token to opt into
#                                      a per-pair shared secret.
#   health                             Pretty-print /health transport status
#   peers                              Show peer connection state
#   ping <peer-id> [--amount N]        Send a tiny ILP packet to peer-id
#   doctor                             Run health + peers + ping
#   stop                               Stop a detached connector
#   teardown                           Remove generated state (asks first)
#
# Flags:
#   --state-dir DIR         Where artifacts live  (default: ./two-home-state)
#   --verbose               Verbose bash + LOG_LEVEL=debug
#
# Environment:
#   ADMIN_API_KEY           Used by ping/peers/doctor; printed by `init`
#
# Honest scope:
#   This script is a guided runner around shipped components — it does NOT
#   replace the planned Epic 42 acceptance test. A green `doctor` run on
#   two physical laptops in two physical homes is real signal that
#   end-to-end ATOR peering works for that pair, not a substitute for CI.
# =============================================================================

set -euo pipefail

# ---------- paths & defaults --------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR_DEFAULT="${PROJECT_ROOT}/two-home-state"

STATE_DIR="${STATE_DIR_DEFAULT}"
VERBOSE=0
DETACH=0

# ---------- colors ------------------------------------------------------------

if [[ -t 1 ]]; then
    C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
    C_RED='\033[31m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_BLUE='\033[34m'
else
    C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

log()    { printf '%b[handshake]%b %s\n' "${C_BLUE}" "${C_RESET}" "$*"; }
ok()     { printf '%b[ok]%b %s\n'        "${C_GREEN}" "${C_RESET}" "$*"; }
warn()   { printf '%b[warn]%b %s\n'      "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()    { printf '%b[fail]%b %s\n'      "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }
hr()     { printf '%b%s%b\n'             "${C_DIM}" "------------------------------------------------------------" "${C_RESET}"; }

# ---------- arg parsing -------------------------------------------------------

usage() {
    sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# Pull global flags out of "$@" before subcommand dispatch
GLOBAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --state-dir) STATE_DIR="$2"; shift 2 ;;
        --verbose)   VERBOSE=1; shift ;;
        --detach)    DETACH=1; shift ;;
        --help|-h)   usage 0 ;;
        *)           GLOBAL_ARGS+=("$1"); shift ;;
    esac
done
set -- "${GLOBAL_ARGS[@]}"

[[ $VERBOSE -eq 1 ]] && set -x

# ---------- common paths inside state dir -------------------------------------

CONFIG_FILE="${STATE_DIR}/connector.yaml"
ADMIN_KEY_FILE="${STATE_DIR}/admin-api-key"
HS_DIR="${STATE_DIR}/hidden-service"
HS_HOSTNAME_FILE="${HS_DIR}/hostname"
PID_FILE="${STATE_DIR}/connector.pid"
LOG_FILE="${STATE_DIR}/connector.log"
NODE_ID_FILE="${STATE_DIR}/node-id"

# Default ports — can be overridden per-laptop if both sides happen to share
# a network, but on separate laptops these are loopback-only and don't conflict.
BTP_PORT=3000
HEALTH_PORT=8080
ADMIN_PORT=8081
SOCKS_PORT=9050        # default for anon / tor
HS_VIRTUAL_PORT=443    # what peers connect to (wss://X.anon:443)

# ---------- helpers -----------------------------------------------------------

require() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

# Connector requires Node >= 22.11.0 (engines field). If the system `node`
# is older — common on systems with stale apt packages — `start` will silently
# crash. Check up-front everywhere we shell out to node, not just preflight.
require_node_22() {
    require node
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -lt 22 ]]; then
        warn "node $(node --version) found in PATH; the connector requires Node >= 22.11.0"
        warn "Set PATH to a Node 22+ install before re-running. e.g.:"
        warn "  PATH=\"/path/to/node22/bin:\$PATH\" $0 ..."
        warn "Or use nvm: \`nvm install 22 && nvm use 22\`"
        die "Node version too old"
    fi
}

read_file_trimmed() {
    [[ -f "$1" ]] || die "Expected file not found: $1"
    tr -d '[:space:]' < "$1"
}

generate_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        # Node fallback (always available since we require Node anyway)
        node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
    fi
}

# Compute BTP server-side env vars from the YAML peers[] list.
# Emits one KEY=VALUE line per peer with a non-empty authToken, plus
# BTP_ALLOW_NOAUTH=false when at least one peer is permissioned.
#
# Why: the BTP server (packages/connector/src/btp/btp-server.ts:573-588)
# validates inbound handshake secrets against process.env.BTP_PEER_<ID>_SECRET,
# NOT against peers[].authToken in YAML. The YAML token is only the OUTBOUND
# (client-side) secret. Without these env exports, permissioned peers would
# get rejected with F00 "peer not configured" on inbound connect.
btp_env_args() {
    [[ -f "$CONFIG_FILE" ]] || return 0
    ( cd "$PROJECT_ROOT" && node -e "
        const yaml = require('js-yaml');
        const fs = require('fs');
        const cfg = yaml.load(fs.readFileSync(process.argv[1], 'utf8'));
        let anyAuth = false;
        for (const peer of cfg.peers || []) {
            if (typeof peer.authToken === 'string' && peer.authToken.length > 0) {
                anyAuth = true;
                const key = 'BTP_PEER_' + peer.id.toUpperCase().replace(/-/g, '_') + '_SECRET';
                process.stdout.write(key + '=' + peer.authToken + '\n');
            }
        }
        if (anyAuth) process.stdout.write('BTP_ALLOW_NOAUTH=false\n');
    " "$CONFIG_FILE" )
}

curl_admin() {
    local method="$1"; shift
    local path="$1"; shift
    local key
    key="${ADMIN_API_KEY:-$(read_file_trimmed "$ADMIN_KEY_FILE")}"
    curl --silent --show-error --max-time 10 \
        -X "$method" \
        -H "x-api-key: $key" \
        -H "Content-Type: application/json" \
        "http://127.0.0.1:${ADMIN_PORT}${path}" \
        "$@"
}

curl_health() {
    curl --silent --show-error --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/health"
}

# ---------- preflight ---------------------------------------------------------

cmd_preflight() {
    log "Running preflight checks"

    require_node_22
    ok "Node $(node --version)"

    require npm
    ok "npm $(npm --version)"

    require curl
    ok "curl available"

    if ! command -v openssl >/dev/null 2>&1; then
        warn "openssl not found — will fall back to node crypto for token generation"
    else
        ok "openssl available"
    fi

    # Built artifacts present?
    if [[ ! -f "${PROJECT_ROOT}/packages/connector/dist/main.js" ]]; then
        warn "packages/connector/dist/main.js not found — run:"
        warn "  (cd ${PROJECT_ROOT} && npm install && npm run build)"
        die "Connector not built"
    fi
    ok "Connector build present"

    # Optional dep — required for managed mode
    if [[ ! -d "${PROJECT_ROOT}/node_modules/@anyone-protocol/anyone-client" ]]; then
        warn "@anyone-protocol/anyone-client (optional dep) is NOT installed."
        warn "Managed ATOR mode will fail at start. Install with:"
        warn "  (cd ${PROJECT_ROOT} && npm install @anyone-protocol/anyone-client@^1.1.3 --workspace=packages/connector)"
        die "Optional ATOR SDK missing"
    fi
    ok "@anyone-protocol/anyone-client installed"

    # Loopback ports — ATOR SOCKS, BTP, health, admin
    for port in "$BTP_PORT" "$HEALTH_PORT" "$ADMIN_PORT" "$SOCKS_PORT"; do
        if (echo > "/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
            warn "Port ${port} is already in use on 127.0.0.1 — may conflict"
        fi
    done

    ok "Preflight passed"
}

# ---------- init --------------------------------------------------------------

cmd_init() {
    local node_id="${1:-}"
    [[ -n "$node_id" ]] || die "Usage: handshake.sh init <node-id>"
    [[ "$node_id" =~ ^[a-z0-9-]+$ ]] || die "node-id must match [a-z0-9-]+ (got: $node_id)"

    if [[ -f "$CONFIG_FILE" ]]; then
        warn "State dir already initialized: ${STATE_DIR}"
        die "Run 'teardown' first or pick a different --state-dir"
    fi

    mkdir -p "$STATE_DIR" "$HS_DIR"
    chmod 700 "$STATE_DIR" "$HS_DIR"

    local admin_key
    admin_key="$(generate_token)"
    printf '%s' "$admin_key" > "$ADMIN_KEY_FILE"
    chmod 600 "$ADMIN_KEY_FILE"

    printf '%s' "$node_id" > "$NODE_ID_FILE"

    cat > "$CONFIG_FILE" <<YAML
# Auto-generated by tools/two-home-ator-handshake/handshake.sh
# Two-home ATOR scenario: ${node_id}
nodeId: ${node_id}
btpServerPort: ${BTP_PORT}
healthCheckPort: ${HEALTH_PORT}
logLevel: info

# Peers populated via 'add-peer' subcommand. Empty until the operator pairs.
peers: []

routes: []

transport:
  type: socks5
  socksProxy: socks5h://127.0.0.1:${SOCKS_PORT}
  externalUrl: auto
  managed: true
  managedOptions:
    hiddenServiceDir: ${HS_DIR}
    hiddenServicePort: ${HS_VIRTUAL_PORT}
    startupTimeoutMs: 90000
    stopTimeoutMs: 10000

adminApi:
  enabled: true
  port: ${ADMIN_PORT}
  host: 127.0.0.1
  apiKey: ${admin_key}

# Settlement is intentionally omitted: this script verifies the ATOR
# transport + peering loop only. Add chainProviders[] before running real
# value-bearing payments. See docs/ator-transport.md and the chain provider
# guides under docs/{solana,mina}-deployment.md.
YAML
    chmod 600 "$CONFIG_FILE"

    hr
    ok "Initialized state dir: ${STATE_DIR}"
    log "  config:        ${CONFIG_FILE}"
    log "  hidden svc:    ${HS_DIR}"
    log "  admin api key: ${ADMIN_KEY_FILE}  (chmod 600)"
    log "  node id:       ${node_id}"
    hr
    log "Next: ./handshake.sh start [--detach]"
}

# ---------- start / stop ------------------------------------------------------

cmd_start() {
    require_node_22
    [[ -f "$CONFIG_FILE" ]] || die "No config at ${CONFIG_FILE} — run 'init <node-id>' first"
    [[ -f "${PROJECT_ROOT}/packages/connector/dist/main.js" ]] || die "Connector not built — run 'preflight'"

    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        die "Connector already running (pid $(cat "$PID_FILE")). Use 'stop' first."
    fi
    rm -f "$PID_FILE"

    local log_level="info"
    [[ $VERBOSE -eq 1 ]] && log_level="debug"

    # Materialize BTP env vars from the YAML's peers[] for INBOUND auth.
    local btp_env_lines; btp_env_lines="$(btp_env_args)"
    local -a env_kv=()
    if [[ -n "$btp_env_lines" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" ]] && env_kv+=("$line")
        done <<< "$btp_env_lines"
        log "BTP auth mode: PERMISSIONED (${#env_kv[@]} env var(s) exported)"
    else
        log "BTP auth mode: PERMISSIONLESS (BTP_ALLOW_NOAUTH default; empty-string secrets accepted)"
    fi

    log "Starting connector (config: ${CONFIG_FILE})"
    log "Managed anon will boot, build a circuit, and publish a hidden service."
    log "Watch for the structured log event 'managed_anon_started' and then"
    log "the file '${HS_HOSTNAME_FILE}' will appear (typically 30-90s)."
    hr

    if [[ $DETACH -eq 1 ]]; then
        mkdir -p "$(dirname "$LOG_FILE")"
        ( cd "$PROJECT_ROOT" && \
          nohup env ${env_kv[@]+"${env_kv[@]}"} CONFIG_FILE="$CONFIG_FILE" LOG_LEVEL="$log_level" \
              node packages/connector/dist/main.js >> "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE" )
        sleep 2
        if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            die "Connector exited immediately — check ${LOG_FILE}"
        fi
        ok "Connector running in background (pid $(cat "$PID_FILE"))"
        log "  log:  ${LOG_FILE}"
        log "Wait for hidden service: ./handshake.sh share"
    else
        ( cd "$PROJECT_ROOT" && \
          exec env ${env_kv[@]+"${env_kv[@]}"} CONFIG_FILE="$CONFIG_FILE" LOG_LEVEL="$log_level" \
              node packages/connector/dist/main.js )
    fi
}

cmd_stop() {
    [[ -f "$PID_FILE" ]] || die "No PID file at ${PID_FILE} (was the connector started with --detach?)"
    local pid; pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
        log "Sending SIGTERM to pid ${pid}"
        kill -TERM "$pid" || true
        # Wait up to 15s for graceful shutdown
        for _ in $(seq 1 15); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "Process did not exit after 15s — sending SIGKILL"
            kill -KILL "$pid" || true
        fi
        ok "Connector stopped"
    else
        warn "PID ${pid} is not running"
    fi
    rm -f "$PID_FILE"
}

# ---------- share -------------------------------------------------------------

cmd_share() {
    [[ -f "$NODE_ID_FILE" ]] || die "Run 'init' first"
    local node_id; node_id="$(read_file_trimmed "$NODE_ID_FILE")"

    # Wait for hostname file (managed anon writes it after circuit + HS publish).
    local waited=0
    while [[ ! -s "$HS_HOSTNAME_FILE" ]]; do
        if [[ $waited -ge 120 ]]; then
            die "Hidden service hostname not written after 120s — check ${LOG_FILE} (or run 'health')"
        fi
        if [[ $waited -eq 0 ]]; then
            log "Waiting for managed anon to publish hidden service..."
        fi
        sleep 2
        waited=$((waited + 2))
    done

    local hostname; hostname="$(read_file_trimmed "$HS_HOSTNAME_FILE")"

    hr
    ok "Hidden service published"
    printf '\n'
    printf '  %bNode ID:%b   %s\n'    "${C_BOLD}" "${C_RESET}" "$node_id"
    printf '  %bPeer URL:%b  wss://%s:%s\n' "${C_BOLD}" "${C_RESET}" "$hostname" "$HS_VIRTUAL_PORT"
    printf '\n'
    hr
    log "Share these with your peer over a secure channel (Signal, encrypted email)."
    log "You ALSO need to agree on a shared BTP auth token. Generate one with:"
    log "  openssl rand -hex 32"
    log "Both operators MUST run 'add-peer' with the SAME token (it's a per-pair shared secret)."
}

# ---------- add-peer ----------------------------------------------------------

cmd_add_peer() {
    local peer_id="${1:-}"
    local peer_url="${2:-}"
    shift 2 || true

    local peer_token=""
    local chain=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --auth-token) peer_token="$2"; shift 2 ;;
            --chain)      chain="$2";      shift 2 ;;
            *)            die "Unknown add-peer flag: $1" ;;
        esac
    done

    [[ -n "$peer_id" && -n "$peer_url" ]] || \
        die "Usage: handshake.sh add-peer <peer-id> <wss://X.anon:443> [--auth-token TOK] [--chain ID]"
    [[ "$peer_id" =~ ^[a-z0-9-]+$ ]] || die "peer-id must match [a-z0-9-]+"
    [[ "$peer_url" =~ ^wss?://.+:[0-9]+$ ]] || \
        die "peer-url must be wss?://host:port (got: $peer_url)"
    if [[ -n "$peer_token" ]]; then
        [[ ${#peer_token} -ge 32 ]] || die "--auth-token looks weak (<32 chars). Use: openssl rand -hex 32"
    fi

    [[ -f "$CONFIG_FILE" ]] || die "No config at ${CONFIG_FILE} — run 'init' first"

    # Crude YAML check — refuse to add a duplicate peer id
    if grep -qE "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${peer_id}[[:space:]]*$" "$CONFIG_FILE"; then
        die "Peer '${peer_id}' already in ${CONFIG_FILE}"
    fi

    # Strategy: insert peer entry above the `routes:` anchor, route entry
    # above the `transport:` anchor. Handles both empty (`peers: []`) and
    # populated sections uniformly.
    local tmp; tmp="$(mktemp)"
    awk -v pid="$peer_id" -v purl="$peer_url" -v ptok="$peer_token" -v chain="$chain" '
        function emit_peer() {
            print "  - id: " pid
            print "    url: " purl
            print "    authToken: \"" ptok "\""
            if (chain != "") print "    chain: " chain
        }
        function emit_route() {
            print "  - prefix: g." pid
            print "    nextHop: " pid
            print "    priority: 0"
        }
        BEGIN { peer_inserted = 0; route_inserted = 0 }

        # Empty peers — flip to block form and insert
        /^peers:[[:space:]]*\[\][[:space:]]*$/ {
            print "peers:"; emit_peer(); peer_inserted = 1; next
        }
        # Empty routes — flip to block form and insert
        /^routes:[[:space:]]*\[\][[:space:]]*$/ {
            print "routes:"; emit_route(); route_inserted = 1; next
        }
        # Already-populated peers — insert above `routes:` anchor
        /^routes:[[:space:]]*$/ && !peer_inserted {
            emit_peer(); print ""; peer_inserted = 1; print; next
        }
        # Already-populated routes — insert above `transport:` anchor
        /^transport:[[:space:]]*$/ && !route_inserted {
            emit_route(); print ""; route_inserted = 1; print; next
        }
        { print }
        END {
            if (!peer_inserted)  { emit_peer() }
            if (!route_inserted) { emit_route() }
        }
    ' "$CONFIG_FILE" > "$tmp"
    mv "$tmp" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"

    if [[ -n "$peer_token" ]]; then
        ok "Added peer '${peer_id}' (permissioned, BTP shared secret) -> ${peer_url}"
        log "Both sides MUST run 'add-peer ... --auth-token <same-token>' for mutual auth."
    else
        ok "Added peer '${peer_id}' (permissionless, no BTP auth) -> ${peer_url}"
        log "Empty authToken — BTP accepts any handshake from this peer ID."
        log "ILP-layer access control still applies (routes, settlement, credit limits)."
    fi
    log "Route added: g.${peer_id}.* -> ${peer_id}"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        warn "Connector is running — restart for new peer to take effect:"
        warn "  ./handshake.sh stop && ./handshake.sh start --detach"
    fi
}

# ---------- health / peers / ping / doctor ------------------------------------

cmd_health() {
    local out; out="$(curl_health)" || die "Health endpoint unreachable on :${HEALTH_PORT}"
    echo "$out" | (command -v jq >/dev/null && jq . || cat)
    if echo "$out" | grep -q '"transport"'; then
        if echo "$out" | grep -qE '"healthy"[[:space:]]*:[[:space:]]*true'; then
            ok "transport.healthy = true"
        else
            warn "transport.healthy = false (SOCKS5 proxy probe failing — check anon)"
        fi
    fi
}

cmd_peers() {
    local out; out="$(curl_admin GET /admin/peers)" || die "Admin API unreachable on :${ADMIN_PORT}"
    echo "$out" | (command -v jq >/dev/null && jq . || cat)
}

cmd_ping() {
    local peer_id="${1:-}"
    [[ -n "$peer_id" ]] || die "Usage: handshake.sh ping <peer-id> [--amount N]"
    shift
    local amount="1"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --amount) amount="$2"; shift 2 ;;
            *) die "Unknown ping flag: $1" ;;
        esac
    done

    local destination="g.${peer_id}.handshake-ping"
    local payload
    payload="$(printf '{"destination":"%s","amount":"%s","data":"","timeoutMs":15000}' \
        "$destination" "$amount")"

    log "POST /admin/ilp/send  destination=${destination} amount=${amount}"
    local t0 t1 dt response http_code
    t0="$(date +%s%3N 2>/dev/null || echo 0)"
    response="$(curl_admin POST /admin/ilp/send -d "$payload" -w '\n%{http_code}')" || \
        die "Admin API call failed"
    t1="$(date +%s%3N 2>/dev/null || echo 0)"
    dt=$((t1 - t0))

    http_code="$(echo "$response" | tail -n1)"
    body="$(echo "$response" | sed '$d')"
    echo "$body" | (command -v jq >/dev/null && jq . || cat)

    case "$http_code" in
        200)
            if echo "$body" | grep -qE '"accepted"[[:space:]]*:[[:space:]]*true'; then
                ok "FULFILL  (round-trip ${dt}ms)"
                log "Two-home ATOR loop verified for peer '${peer_id}'."
            else
                warn "REJECT (round-trip ${dt}ms) — peer reachable, app rejected"
                log "Most common: peer has no handler/route for g.${peer_id}.* — that's OK,"
                log "the round-trip itself proves the ATOR circuit + BTP link work."
            fi
            ;;
        408) die "Timeout (${dt}ms) — peer unreachable over ATOR. Check 'health' on both sides." ;;
        503) die "Connector not ready or sendPacket not configured" ;;
        *)   die "Unexpected HTTP ${http_code}" ;;
    esac
}

cmd_doctor() {
    log "Running doctor: health → peers → ping (first peer in config)"
    hr
    cmd_health
    hr
    cmd_peers
    hr
    local first_peer
    first_peer="$(grep -E '^[[:space:]]+-[[:space:]]+id:' "$CONFIG_FILE" | head -1 | sed 's/.*id:[[:space:]]*//')"
    [[ -n "$first_peer" ]] || die "No peer configured — run 'add-peer' first"
    cmd_ping "$first_peer"
}

# ---------- teardown ----------------------------------------------------------

cmd_teardown() {
    [[ -d "$STATE_DIR" ]] || die "No state dir at ${STATE_DIR}"
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        warn "Connector still running — stop it first with 'stop'"
        exit 1
    fi
    printf '%b[confirm]%b Remove %s? [yes/no] ' "${C_YELLOW}" "${C_RESET}" "$STATE_DIR"
    read -r answer
    [[ "$answer" == "yes" ]] || { log "Aborted"; exit 0; }
    rm -rf "$STATE_DIR"
    ok "Removed ${STATE_DIR}"
}

# ---------- dispatch ----------------------------------------------------------

cmd="${1:-}"
shift || true

case "$cmd" in
    preflight) cmd_preflight "$@" ;;
    init)      cmd_init "$@" ;;
    start)     cmd_start "$@" ;;
    stop)      cmd_stop "$@" ;;
    share)     cmd_share "$@" ;;
    add-peer)  cmd_add_peer "$@" ;;
    health)    cmd_health "$@" ;;
    peers)     cmd_peers "$@" ;;
    ping)      cmd_ping "$@" ;;
    doctor)    cmd_doctor "$@" ;;
    teardown)  cmd_teardown "$@" ;;
    ""|help|-h|--help) usage 0 ;;
    *) die "Unknown subcommand: $cmd (try --help)" ;;
esac
