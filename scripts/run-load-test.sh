#!/bin/bash
#
# Run Load Test
# Story 12.10: Production Acceptance Testing and Go-Live
#
# This script executes the 24-hour sustained load test.
# It should be run in a staging environment, NOT in CI/CD pipelines.
#
# Usage:
#   ./scripts/run-load-test.sh [OPTIONS]
#
# Options:
#   --tps N           Target TPS (default: 10000)
#   --duration N      Duration in hours (default: 24)
#   --ramp-up N       Ramp-up period in minutes (default: 5)
#   --quick           Quick test: 1 hour at 1000 TPS for validation
#   --help            Show this help message
#
# Examples:
#   ./scripts/run-load-test.sh                    # Full 24h test at 10K TPS
#   ./scripts/run-load-test.sh --quick            # Quick 1h validation test
#   ./scripts/run-load-test.sh --tps 5000         # 24h test at 5K TPS
#   ./scripts/run-load-test.sh --duration 4       # 4h test at 10K TPS

set -e

# Default configuration
TARGET_TPS=10000
DURATION_HOURS=24
RAMP_UP_MINUTES=5
METRICS_INTERVAL_MS=1000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --tps)
            TARGET_TPS="$2"
            shift 2
            ;;
        --duration)
            DURATION_HOURS="$2"
            shift 2
            ;;
        --ramp-up)
            RAMP_UP_MINUTES="$2"
            shift 2
            ;;
        --quick)
            TARGET_TPS=1000
            DURATION_HOURS=1
            shift
            ;;
        --help)
            echo "Run Load Test - 24-hour sustained throughput test"
            echo ""
            echo "Usage: ./scripts/run-load-test.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --tps N           Target TPS (default: 10000)"
            echo "  --duration N      Duration in hours (default: 24)"
            echo "  --ramp-up N       Ramp-up period in minutes (default: 5)"
            echo "  --quick           Quick test: 1 hour at 1000 TPS"
            echo "  --help            Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Display banner
echo ""
echo "=========================================="
echo "       M2M Economy Load Test Runner       "
echo "=========================================="
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
fi
echo "  ✓ Docker available"

# Check if Docker infrastructure is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker daemon is not running${NC}"
    exit 1
fi
echo "  ✓ Docker daemon running"

# Check memory
TOTAL_MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024)}' || echo "8000")
if [ "$TOTAL_MEM" -lt 8000 ]; then
    echo -e "${YELLOW}Warning: Less than 8GB RAM available (${TOTAL_MEM}MB)${NC}"
    echo "  The load test may not achieve full throughput"
fi
echo "  ✓ Memory: ${TOTAL_MEM}MB available"

# Display configuration
echo ""
echo -e "${GREEN}Load Test Configuration:${NC}"
echo "  Target TPS:        ${TARGET_TPS}"
echo "  Duration:          ${DURATION_HOURS} hours"
echo "  Ramp-up:           ${RAMP_UP_MINUTES} minutes"
echo "  Metrics interval:  ${METRICS_INTERVAL_MS}ms"
echo ""

# Calculate expected values
EXPECTED_PACKETS=$((TARGET_TPS * DURATION_HOURS * 3600))
echo "  Expected packets:  $(printf "%'d" $EXPECTED_PACKETS)"
echo ""

# Confirmation for long tests
if [ "$DURATION_HOURS" -ge 1 ]; then
    echo -e "${YELLOW}Warning: This test will run for ${DURATION_HOURS} hour(s)${NC}"
    read -p "Do you want to continue? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Test cancelled."
        exit 0
    fi
fi

# Create results directory
RESULTS_DIR="docs/benchmarks"
mkdir -p "$RESULTS_DIR"

# Generate timestamp for this run
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$RESULTS_DIR/load-test-${TIMESTAMP}.log"

# Start the test
echo ""
echo -e "${GREEN}Starting load test at $(date)${NC}"
echo "  Log file: $LOG_FILE"
echo ""

# Export environment variables and run test
export LOAD_TEST_ENABLED=true
export LOAD_TEST_TPS=$TARGET_TPS
export LOAD_TEST_DURATION_HOURS=$DURATION_HOURS
export LOAD_TEST_RAMP_UP_MINUTES=$RAMP_UP_MINUTES
export LOAD_TEST_METRICS_INTERVAL_MS=$METRICS_INTERVAL_MS

# Run the load test
cd "$(dirname "$0")/.."
npm run test:load 2>&1 | tee "$LOG_FILE"

# Check result
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo ""
    echo -e "${GREEN}=========================================="
    echo "       Load Test PASSED                    "
    echo "==========================================${NC}"
else
    echo ""
    echo -e "${RED}=========================================="
    echo "       Load Test FAILED                    "
    echo "==========================================${NC}"
    exit 1
fi

echo ""
echo "Results saved to: $RESULTS_DIR"
echo "Log file: $LOG_FILE"
echo ""
