#!/bin/bash
# Docker Agent Society Integration Test Runner
#
# This script builds and runs the Docker-based agent society test.
# It starts multiple agent containers and orchestrates them through
# the test phases using HTTP API calls.
#
# Usage:
#   ./scripts/run-docker-agent-test.sh
#   AGENT_COUNT=3 ./scripts/run-docker-agent-test.sh
#   LOG_LEVEL=debug ./scripts/run-docker-agent-test.sh

set -e

# Configuration
AGENT_COUNT=${AGENT_COUNT:-5}
LOG_LEVEL=${LOG_LEVEL:-info}
COMPOSE_FILE="docker-compose-agent-test.yml"
TEST_TIMEOUT=${TEST_TIMEOUT:-300}  # 5 minutes

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Docker Agent Society Integration Test${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Configuration:"
echo "  Agent Count: $AGENT_COUNT"
echo "  Log Level: $LOG_LEVEL"
echo "  Timeout: ${TEST_TIMEOUT}s"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running${NC}"
    exit 1
fi

# Navigate to project root
cd "$(dirname "$0")/.."

# Step 1: Build the agent image
echo -e "${YELLOW}[Step 1/5] Building agent Docker image...${NC}"
docker compose -f "$COMPOSE_FILE" build agent-0

# Step 2: Stop any existing containers
echo -e "${YELLOW}[Step 2/5] Stopping existing containers...${NC}"
docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

# Step 3: Start infrastructure (Anvil + Agents)
echo -e "${YELLOW}[Step 3/5] Starting infrastructure...${NC}"
docker compose -f "$COMPOSE_FILE" up -d anvil

# Wait for Anvil to be healthy (check from host)
echo "  Waiting for Anvil..."
for i in {1..60}; do
    if curl -sf http://localhost:8545 -X POST \
        -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
        echo "  Anvil is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        echo -e "${RED}Error: Anvil failed to start${NC}"
        docker compose -f "$COMPOSE_FILE" logs anvil
        exit 1
    fi
    sleep 1
done

# Step 4: Start agents
echo -e "${YELLOW}[Step 4/5] Starting agent containers...${NC}"
docker compose -f "$COMPOSE_FILE" up -d agent-0 agent-1 agent-2 agent-3 agent-4

# Wait for all agents to be healthy
echo "  Waiting for agents to be healthy..."
for i in $(seq 0 $((AGENT_COUNT - 1))); do
    echo -n "    agent-$i: "
    for j in {1..60}; do
        if curl -sf "http://localhost:$((8100 + i))/health" > /dev/null 2>&1; then
            echo "ready"
            break
        fi
        if [ $j -eq 60 ]; then
            echo "TIMEOUT"
            echo -e "${RED}Error: agent-$i failed to start${NC}"
            docker compose -f "$COMPOSE_FILE" logs "agent-$i"
            exit 1
        fi
        sleep 1
    done
done

# Step 5: Run the test orchestrator
echo -e "${YELLOW}[Step 5/5] Running test orchestrator...${NC}"
echo ""

# Build TypeScript if needed
if [ ! -f "packages/connector/dist/test/docker-agent-test-runner.js" ]; then
    echo "  Building TypeScript..."
    npm run build:connector-only -w @m2m/connector
fi

# Run the test from host (not in Docker)
export ANVIL_RPC_URL="http://localhost:8545"
export AGENT_COUNT="$AGENT_COUNT"
export LOG_LEVEL="$LOG_LEVEL"
export RUNNING_IN_DOCKER="false"

# Run the test (timeout command not available on macOS, use perl or skip)
if command -v timeout &> /dev/null; then
    timeout "$TEST_TIMEOUT" node packages/connector/dist/test/docker-agent-test-runner.js
    TEST_EXIT_CODE=$?
else
    # macOS fallback - run without timeout
    node packages/connector/dist/test/docker-agent-test-runner.js
    TEST_EXIT_CODE=$?
fi

# Print container logs if test failed
if [ $TEST_EXIT_CODE -ne 0 ]; then
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}Test Failed - Container Logs${NC}"
    echo -e "${RED}========================================${NC}"

    for i in $(seq 0 $((AGENT_COUNT - 1))); do
        echo ""
        echo "=== agent-$i logs ==="
        docker compose -f "$COMPOSE_FILE" logs --tail=50 "agent-$i" 2>/dev/null || true
    done
fi

# Cleanup
echo ""
echo -e "${YELLOW}Cleaning up containers...${NC}"
docker compose -f "$COMPOSE_FILE" down -v

# Exit with test result
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Test Passed!${NC}"
    echo -e "${GREEN}========================================${NC}"
else
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}Test Failed (exit code: $TEST_EXIT_CODE)${NC}"
    echo -e "${RED}========================================${NC}"
fi

exit $TEST_EXIT_CODE
