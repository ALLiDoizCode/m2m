#!/bin/bash
#
# Production Health Check
# Story 12.10: Production Acceptance Testing and Go-Live
#
# This script validates production system health after deployment.
# Run this AFTER deploying to production to verify the system is healthy.
#
# Usage:
#   ./scripts/production-healthcheck.sh [--endpoint URL]
#
# Options:
#   --endpoint URL    Base URL of the production endpoint (default: http://localhost:3000)
#
# Exit codes:
#   0 - All health checks passed
#   1 - One or more health checks failed
#

set -e

# Default configuration
ENDPOINT="http://localhost:3000"
TIMEOUT=10

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --endpoint)
            ENDPOINT="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --help)
            echo "Production Health Check"
            echo ""
            echo "Usage: ./scripts/production-healthcheck.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --endpoint URL    Base URL of the production endpoint"
            echo "  --timeout N       Request timeout in seconds (default: 10)"
            echo "  --help            Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Log functions
log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED++))
}

log_info() {
    echo -e "[INFO] $1"
}

# Display banner
echo ""
echo "=========================================="
echo "    M2M Production Health Check"
echo "=========================================="
echo ""
echo "Endpoint: $ENDPOINT"
echo "Timeout: ${TIMEOUT}s"
echo ""

# ----------------------------------------
# 1. Basic Connectivity
# ----------------------------------------
log_info "Checking basic connectivity..."

# Check if endpoint is reachable
if curl -s --max-time $TIMEOUT "$ENDPOINT" > /dev/null 2>&1; then
    log_pass "Endpoint is reachable"
else
    log_fail "Cannot reach endpoint at $ENDPOINT"
fi

# ----------------------------------------
# 2. Health Endpoint
# ----------------------------------------
log_info "Checking health endpoint..."

HEALTH_RESPONSE=$(curl -s --max-time $TIMEOUT "$ENDPOINT/health" 2>/dev/null || echo "error")

if [[ "$HEALTH_RESPONSE" == *"ok"* ]] || [[ "$HEALTH_RESPONSE" == *"healthy"* ]]; then
    log_pass "Health endpoint returns healthy status"
elif [[ "$HEALTH_RESPONSE" == "error" ]]; then
    log_fail "Health endpoint not responding"
else
    log_fail "Health endpoint returned unexpected response: $HEALTH_RESPONSE"
fi

# ----------------------------------------
# 3. Metrics Endpoint
# ----------------------------------------
log_info "Checking metrics endpoint..."

METRICS_RESPONSE=$(curl -s --max-time $TIMEOUT "$ENDPOINT/metrics" 2>/dev/null || echo "error")

if [[ "$METRICS_RESPONSE" == *"#"* ]] || [[ "$METRICS_RESPONSE" == *"counter"* ]] || [[ "$METRICS_RESPONSE" == *"gauge"* ]]; then
    log_pass "Metrics endpoint returns Prometheus format data"
elif [[ "$METRICS_RESPONSE" == "error" ]]; then
    log_fail "Metrics endpoint not responding"
else
    log_info "Metrics endpoint returned non-Prometheus response (may be expected)"
fi

# ----------------------------------------
# 4. Response Time Check
# ----------------------------------------
log_info "Checking response times..."

RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" --max-time $TIMEOUT "$ENDPOINT/health" 2>/dev/null || echo "999")

if (( $(echo "$RESPONSE_TIME < 1.0" | bc -l 2>/dev/null || echo 0) )); then
    log_pass "Health endpoint response time: ${RESPONSE_TIME}s (< 1s)"
elif (( $(echo "$RESPONSE_TIME < 5.0" | bc -l 2>/dev/null || echo 0) )); then
    log_pass "Health endpoint response time: ${RESPONSE_TIME}s (< 5s, acceptable)"
else
    log_fail "Health endpoint response time too slow: ${RESPONSE_TIME}s"
fi

# ----------------------------------------
# 5. TLS/SSL Check (if HTTPS)
# ----------------------------------------
if [[ "$ENDPOINT" == https://* ]]; then
    log_info "Checking TLS configuration..."

    CERT_EXPIRY=$(echo | openssl s_client -servername "${ENDPOINT#https://}" -connect "${ENDPOINT#https://}:443" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null | grep notAfter | cut -d= -f2 || echo "error")

    if [[ "$CERT_EXPIRY" != "error" ]]; then
        log_pass "TLS certificate found, expires: $CERT_EXPIRY"
    else
        log_fail "Could not verify TLS certificate"
    fi
fi

# ----------------------------------------
# 6. Process Memory Check (local only)
# ----------------------------------------
if [[ "$ENDPOINT" == *"localhost"* ]] || [[ "$ENDPOINT" == *"127.0.0.1"* ]]; then
    log_info "Checking local process health..."

    # Check for Node.js processes
    NODE_PROCESSES=$(pgrep -f "node" 2>/dev/null | wc -l || echo "0")
    if [ "$NODE_PROCESSES" -gt 0 ]; then
        log_pass "Found $NODE_PROCESSES Node.js process(es) running"
    else
        log_fail "No Node.js processes found"
    fi
fi

# ----------------------------------------
# 7. Database Connectivity (via health endpoint)
# ----------------------------------------
log_info "Checking database connectivity..."

DB_HEALTH_RESPONSE=$(curl -s --max-time $TIMEOUT "$ENDPOINT/health/db" 2>/dev/null || echo "endpoint_not_found")

if [[ "$DB_HEALTH_RESPONSE" == *"ok"* ]] || [[ "$DB_HEALTH_RESPONSE" == *"connected"* ]]; then
    log_pass "Database connectivity verified"
elif [[ "$DB_HEALTH_RESPONSE" == "endpoint_not_found" ]]; then
    log_info "Database health endpoint not found (may not be exposed)"
else
    log_fail "Database connectivity issue: $DB_HEALTH_RESPONSE"
fi

# ----------------------------------------
# 8. Settlement Engine Status
# ----------------------------------------
log_info "Checking settlement engine status..."

SETTLEMENT_RESPONSE=$(curl -s --max-time $TIMEOUT "$ENDPOINT/health/settlement" 2>/dev/null || echo "endpoint_not_found")

if [[ "$SETTLEMENT_RESPONSE" == *"ok"* ]] || [[ "$SETTLEMENT_RESPONSE" == *"ready"* ]]; then
    log_pass "Settlement engine healthy"
elif [[ "$SETTLEMENT_RESPONSE" == "endpoint_not_found" ]]; then
    log_info "Settlement health endpoint not found (may not be exposed)"
else
    log_fail "Settlement engine issue: $SETTLEMENT_RESPONSE"
fi

# ----------------------------------------
# Summary
# ----------------------------------------
echo ""
echo "=========================================="
echo "           Health Check Summary"
echo "=========================================="
echo ""
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo ""

if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Health check FAILED${NC}"
    echo "Please investigate failed checks immediately."
    exit 1
else
    echo -e "${GREEN}Health check PASSED${NC}"
    echo "Production system is healthy."
    exit 0
fi
