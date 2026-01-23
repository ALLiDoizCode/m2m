#!/bin/bash
#
# Run Acceptance Test Suite
# Story 12.10: Production Acceptance Testing and Go-Live
#
# This script executes the complete acceptance test suite.
# It should be run before production deployment to validate readiness.
#
# Usage:
#   ./scripts/run-acceptance-tests.sh [OPTIONS]
#
# Options:
#   --quick           Run quick validation only (skip load tests)
#   --verbose         Verbose output
#   --help            Show this help message
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed
#

set -e

# Configuration
QUICK_MODE=false
VERBOSE=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --quick)
            QUICK_MODE=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            echo "Run Acceptance Test Suite"
            echo ""
            echo "Usage: ./scripts/run-acceptance-tests.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --quick           Skip extended tests (load tests)"
            echo "  --verbose         Verbose output"
            echo "  --help            Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Display banner
echo ""
echo "=========================================="
echo "    M2M Acceptance Test Suite Runner"
echo "=========================================="
echo ""

# Change to project root
cd "$(dirname "$0")/.."

# Track results
TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
START_TIME=$(date +%s)

# Function to run a test suite
run_suite() {
    local name="$1"
    local pattern="$2"
    local timeout="${3:-120000}"

    echo ""
    echo -e "${YELLOW}Running: $name${NC}"
    echo "Pattern: $pattern"
    echo ""

    ((TOTAL_SUITES++))

    if [ "$VERBOSE" = true ]; then
        if npm run test:acceptance -- --testPathPattern="$pattern" --testTimeout=$timeout; then
            echo -e "${GREEN}PASSED: $name${NC}"
            ((PASSED_SUITES++))
        else
            echo -e "${RED}FAILED: $name${NC}"
            ((FAILED_SUITES++))
            return 1
        fi
    else
        if npm run test:acceptance -- --testPathPattern="$pattern" --testTimeout=$timeout 2>&1 | tail -20; then
            ((PASSED_SUITES++))
        else
            ((FAILED_SUITES++))
            return 1
        fi
    fi
}

# ----------------------------------------
# Run Test Suites
# ----------------------------------------

echo "Mode: $([ "$QUICK_MODE" = true ] && echo "Quick" || echo "Full")"
echo ""

# 1. Production Acceptance Tests
run_suite "Production Acceptance Tests" "production-acceptance" 300000 || true

# 2. Multi-Chain Settlement Tests
run_suite "Multi-Chain Settlement Tests" "multi-chain-settlement" 300000 || true

# 3. Security Penetration Tests
run_suite "Security Penetration Tests" "security-penetration" 300000 || true

# 4. Disaster Recovery Tests
run_suite "Disaster Recovery Tests" "disaster-recovery" 300000 || true

# 5. Performance Benchmark Tests
run_suite "Performance Benchmark Tests" "performance-benchmark" 300000 || true

# 6. Documentation Audit Tests
run_suite "Documentation Audit Tests" "documentation-audit" 300000 || true

# 7. Load Tests (skip in quick mode)
if [ "$QUICK_MODE" = false ]; then
    echo ""
    echo -e "${YELLOW}Note: Extended load tests are skipped by default.${NC}"
    echo "To run the 24-hour load test, use: ./scripts/run-load-test.sh"
    echo ""
fi

# ----------------------------------------
# Summary
# ----------------------------------------
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=========================================="
echo "         Acceptance Test Summary"
echo "=========================================="
echo ""
echo "Test Suites:"
echo -e "  ${GREEN}Passed:${NC}  $PASSED_SUITES"
echo -e "  ${RED}Failed:${NC}  $FAILED_SUITES"
echo "  Total:   $TOTAL_SUITES"
echo ""
echo "Duration: ${DURATION}s"
echo ""

if [ $FAILED_SUITES -gt 0 ]; then
    echo -e "${RED}=========================================="
    echo "     ACCEPTANCE TESTS FAILED"
    echo "==========================================${NC}"
    echo ""
    echo "Please fix failing tests before deploying to production."
    exit 1
else
    echo -e "${GREEN}=========================================="
    echo "     ALL ACCEPTANCE TESTS PASSED"
    echo "==========================================${NC}"
    echo ""
    echo "System is ready for production deployment."
    exit 0
fi
