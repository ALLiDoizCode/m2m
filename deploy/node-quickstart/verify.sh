#!/usr/bin/env bash
# =============================================================================
# node-quickstart/verify.sh — smoke-check a running node-quickstart deployment.
# =============================================================================
# Checks the operator-visible surfaces are up. It does NOT perform a paid write
# (that needs the ILP-over-HTTP prover — see README "Prove a paid write"). Run
# after `docker compose up -d`.
#
# Usage:   ./verify.sh            # checks node A (default profile)
#          ./verify.sh --peer     # also checks node B (requires --profile peer)
# =============================================================================
set -euo pipefail

CONNECTOR_HEALTH="http://127.0.0.1:8080/health"
CONNECTOR_DASH="http://127.0.0.1:8081/admin/dashboard"
CONNECTOR_METRICS="http://127.0.0.1:8081/admin/metrics.json"
PEER_HEALTH="http://127.0.0.1:8082/health"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

check() { # name url [expected-substring]
  local name="$1" url="$2" want="${3:-}"
  local body
  if ! body=$(curl -fsS --max-time 5 "$url" 2>/dev/null); then
    fail "$name — no response from $url"
    return
  fi
  if [[ -n "$want" && "$body" != *"$want"* ]]; then
    fail "$name — response missing '$want'"
    return
  fi
  pass "$name"
}

echo "node-quickstart: checking node A…"
check "connector /health"          "$CONNECTOR_HEALTH"
check "operator dashboard"         "$CONNECTOR_DASH"   "<html"
check "connector /admin/metrics.json" "$CONNECTOR_METRICS" "aggregate"

if [[ "${1:-}" == "--peer" ]]; then
  echo "node-quickstart: checking node B (peer)…"
  check "peer connector /health"   "$PEER_HEALTH"
  # The peer link shows on the DIALER (node B). node A accepts it at its BTP
  # server but does not list inbound-only sessions in /admin/peers.
  if curl -fsS --max-time 5 "http://127.0.0.1:8083/admin/peers" 2>/dev/null | grep -q '"g.proxy"'; then
    pass "peer link (node B → g.proxy) established"
  else
    fail "peer link not visible in node B /admin/peers yet (BTP dial can take ~30s)"
  fi
fi

if [[ "$FAILED" -eq 0 ]]; then
  printf '\n\033[32mAll checks passed.\033[0m Open the dashboard: %s\n' "$CONNECTOR_DASH"
else
  printf '\n\033[31mSome checks failed.\033[0m Is `docker compose up -d` finished? Try `docker compose logs -f`.\n'
  exit 1
fi
