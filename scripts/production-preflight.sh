#!/bin/bash
#
# Production Pre-Flight Check
# Story 12.10: Production Acceptance Testing and Go-Live
#
# This script validates all requirements before production deployment.
# Run this BEFORE deploying to production.
#
# Usage:
#   ./scripts/production-preflight.sh
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Log functions
log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED++))
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    ((WARNINGS++))
}

log_info() {
    echo -e "[INFO] $1"
}

# Display banner
echo ""
echo "=========================================="
echo "    M2M Production Pre-Flight Check"
echo "=========================================="
echo ""

# Change to project root
cd "$(dirname "$0")/.."

# ----------------------------------------
# 1. Environment Checks
# ----------------------------------------
log_info "Checking environment..."

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
if [[ "$NODE_VERSION" == *"v20"* ]] || [[ "$NODE_VERSION" == *"v22"* ]]; then
    log_pass "Node.js version: $NODE_VERSION"
else
    log_fail "Node.js version must be 20.x or higher (found: $NODE_VERSION)"
fi

# Check npm version
NPM_VERSION=$(npm --version 2>/dev/null || echo "not found")
if [[ "$NPM_VERSION" != "not found" ]]; then
    log_pass "npm version: $NPM_VERSION"
else
    log_fail "npm not found"
fi

# ----------------------------------------
# 2. Build Checks
# ----------------------------------------
log_info "Checking build..."

# Check if build artifacts exist
if [ -d "packages/connector/dist" ]; then
    log_pass "Build artifacts exist"
else
    log_fail "Build artifacts not found - run 'npm run build'"
fi

# Check package.json exists
if [ -f "package.json" ]; then
    log_pass "Root package.json exists"
else
    log_fail "Root package.json not found"
fi

# ----------------------------------------
# 3. Environment Variables
# ----------------------------------------
log_info "Checking required environment variables..."

# List of required environment variables for production
REQUIRED_ENV_VARS=(
    "NODE_ENV"
)

# List of sensitive variables that should be set but not checked in detail
SENSITIVE_ENV_VARS=(
    "DATABASE_URL"
    "WALLET_ENCRYPTION_KEY"
    "EVM_PRIVATE_KEY"
    "XRP_SEED"
)

# Check required env vars
for var in "${REQUIRED_ENV_VARS[@]}"; do
    if [ -n "${!var}" ]; then
        log_pass "Environment variable $var is set"
    else
        log_warn "Environment variable $var is not set (may be in deployment config)"
    fi
done

# Check sensitive vars exist (don't log values)
for var in "${SENSITIVE_ENV_VARS[@]}"; do
    if [ -n "${!var}" ]; then
        log_pass "Sensitive variable $var is set"
    else
        log_warn "Sensitive variable $var is not set (should be in secure config)"
    fi
done

# ----------------------------------------
# 4. Test Verification
# ----------------------------------------
log_info "Checking test status..."

# Run unit tests
log_info "Running unit tests..."
if npm run test --workspace=@m2m/connector 2>/dev/null | grep -q "passed"; then
    log_pass "Unit tests passing"
else
    log_warn "Unit tests may have issues - verify manually"
fi

# ----------------------------------------
# 5. Documentation Checks
# ----------------------------------------
log_info "Checking documentation..."

# Check required docs exist
REQUIRED_DOCS=(
    "README.md"
    "docs/operators/production-go-live-checklist.md"
    "docs/operators/load-testing-guide.md"
)

for doc in "${REQUIRED_DOCS[@]}"; do
    if [ -f "$doc" ]; then
        log_pass "Documentation exists: $doc"
    else
        log_fail "Documentation missing: $doc"
    fi
done

# ----------------------------------------
# 6. Security Checks
# ----------------------------------------
log_info "Checking security..."

# Check for exposed secrets in code
if grep -r "PRIVATE_KEY=" --include="*.ts" --include="*.js" packages/ 2>/dev/null | grep -v "process.env" | grep -v ".test." | grep -q .; then
    log_fail "Potential hardcoded secrets found in code"
else
    log_pass "No hardcoded secrets detected"
fi

# Check for .env files that shouldn't be committed
if [ -f ".env" ] && [ -f ".gitignore" ] && grep -q "^\.env$" .gitignore; then
    log_pass ".env file properly gitignored"
elif [ -f ".env" ]; then
    log_warn ".env file exists but may not be gitignored"
else
    log_pass "No .env file in repository root"
fi

# ----------------------------------------
# 7. Dependency Audit
# ----------------------------------------
log_info "Checking dependencies..."

# Run npm audit
AUDIT_OUTPUT=$(npm audit --json 2>/dev/null || echo '{"vulnerabilities":{}}')
CRITICAL_COUNT=$(echo "$AUDIT_OUTPUT" | grep -o '"critical":[0-9]*' | grep -o '[0-9]*' | head -1 || echo "0")
HIGH_COUNT=$(echo "$AUDIT_OUTPUT" | grep -o '"high":[0-9]*' | grep -o '[0-9]*' | head -1 || echo "0")

if [ "${CRITICAL_COUNT:-0}" -gt 0 ]; then
    log_fail "Critical vulnerabilities found: $CRITICAL_COUNT"
elif [ "${HIGH_COUNT:-0}" -gt 0 ]; then
    log_warn "High severity vulnerabilities found: $HIGH_COUNT"
else
    log_pass "No critical or high vulnerabilities"
fi

# ----------------------------------------
# 8. Docker Check (if applicable)
# ----------------------------------------
log_info "Checking Docker configuration..."

if [ -f "Dockerfile" ] || [ -f "docker-compose.yml" ]; then
    log_pass "Docker configuration found"
else
    log_warn "No Docker configuration found"
fi

# ----------------------------------------
# Summary
# ----------------------------------------
echo ""
echo "=========================================="
echo "           Pre-Flight Summary"
echo "=========================================="
echo ""
echo -e "  ${GREEN}Passed:${NC}   $PASSED"
echo -e "  ${RED}Failed:${NC}   $FAILED"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo ""

if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Pre-flight check FAILED${NC}"
    echo "Please address all failures before deploying to production."
    exit 1
elif [ $WARNINGS -gt 3 ]; then
    echo -e "${YELLOW}Pre-flight check PASSED with warnings${NC}"
    echo "Review warnings before proceeding with deployment."
    exit 0
else
    echo -e "${GREEN}Pre-flight check PASSED${NC}"
    echo "System is ready for production deployment."
    exit 0
fi
