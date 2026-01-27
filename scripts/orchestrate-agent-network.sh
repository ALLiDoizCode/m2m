#!/bin/bash
# Orchestrate Agent Network with Real Payment Channels
#
# This script orchestrates the full Docker agent network deployment:
# 1. Start infrastructure (Anvil + rippled)
# 2. Wait for health checks
# 3. Deploy EVM contracts (TokenNetwork + AGENT token)
# 4. Fund XRP test accounts from genesis
# 5. Start all agents
# 6. Configure agents with EVM contract addresses
# 7. Configure agents with XRP accounts
# 8. Open payment channels between connected peers
# 9. Verify packet flow works
#
# Usage:
#   ./scripts/orchestrate-agent-network.sh
#
# Prerequisites:
#   - Docker and Docker Compose
#   - curl, jq

set -e

# Configuration
COMPOSE_FILE="docker-compose-agent-test.yml"
AGENT_COUNT=${AGENT_COUNT:-5}
BASE_HTTP_PORT=8100

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

wait_for_service() {
    local name=$1
    local url=$2
    local max_retries=${3:-30}
    local retry=0

    log_info "Waiting for $name at $url..."
    while [ $retry -lt $max_retries ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            log_info "$name is ready"
            return 0
        fi
        retry=$((retry + 1))
        sleep 2
    done

    log_error "$name failed to start after $max_retries retries"
    return 1
}

wait_for_rippled() {
    local max_retries=60
    local retry=0

    log_info "Waiting for rippled to be ready..."
    while [ $retry -lt $max_retries ]; do
        # Check if rippled is responding and ledger is available
        local response=$(curl -sf -X POST http://localhost:5005 \
            -H "Content-Type: application/json" \
            -d '{"method":"server_info","params":[{}]}' 2>/dev/null || echo "")

        if [ -n "$response" ]; then
            local state=$(echo "$response" | jq -r '.result.info.server_state // empty' 2>/dev/null || echo "")
            if [ "$state" = "full" ] || [ "$state" = "proposing" ] || [ "$state" = "standalone" ]; then
                log_info "rippled is ready (state: $state)"
                return 0
            fi
        fi

        retry=$((retry + 1))
        sleep 2
    done

    log_error "rippled failed to become ready after $max_retries retries"
    return 1
}

# Phase 1: Start Infrastructure
phase_start_infrastructure() {
    log_info "=== Phase 1: Starting Infrastructure ==="

    # Stop any existing containers
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

    # Start Anvil and rippled
    docker compose -f "$COMPOSE_FILE" up -d anvil rippled

    # Wait for Anvil
    wait_for_service "Anvil" "http://localhost:8545" 30

    # Wait for rippled (needs more time to initialize)
    wait_for_rippled

    log_info "Infrastructure is ready"
}

# Phase 2: Deploy EVM Contracts
phase_deploy_evm_contracts() {
    log_info "=== Phase 2: Deploying EVM Contracts ==="

    # The test runner handles contract deployment, but we can verify Anvil is ready
    # Contract deployment happens in the test runner for now
    log_info "EVM contracts will be deployed by the test runner"
}

# Phase 3: Fund XRP Accounts
phase_fund_xrp_accounts() {
    log_info "=== Phase 3: Funding XRP Accounts ==="

    # Run the XRP account funding script
    if [ -f "./scripts/fund-xrp-accounts.sh" ]; then
        ./scripts/fund-xrp-accounts.sh
    else
        log_warn "fund-xrp-accounts.sh not found, XRP accounts will need manual funding"
    fi
}

# Phase 4: Start Agents
phase_start_agents() {
    log_info "=== Phase 4: Starting Agents ==="

    # Start all agent containers
    docker compose -f "$COMPOSE_FILE" up -d agent-0 agent-1 agent-2 agent-3 agent-4

    # Wait for each agent to be healthy
    for i in $(seq 0 $((AGENT_COUNT - 1))); do
        local port=$((BASE_HTTP_PORT + i))
        wait_for_service "agent-$i" "http://localhost:$port/health" 60
    done

    log_info "All agents are running"
}

# Phase 5: Run Test Orchestrator
phase_run_test_orchestrator() {
    log_info "=== Phase 5: Running Test Orchestrator ==="

    # Run the test orchestrator with the test profile
    docker compose -f "$COMPOSE_FILE" --profile test up test-orchestrator

    # Check exit code
    local exit_code=$(docker inspect agent_test_orchestrator --format='{{.State.ExitCode}}' 2>/dev/null || echo "1")

    if [ "$exit_code" = "0" ]; then
        log_info "Test orchestrator completed successfully"
    else
        log_error "Test orchestrator failed with exit code $exit_code"
        return 1
    fi
}

# Phase 6: Verify System
phase_verify_system() {
    log_info "=== Phase 6: Verifying System ==="

    # Query each agent's status
    for i in $(seq 0 $((AGENT_COUNT - 1))); do
        local port=$((BASE_HTTP_PORT + i))
        local status=$(curl -sf "http://localhost:$port/status" 2>/dev/null || echo "{}")

        local agent_id=$(echo "$status" | jq -r '.agentId // "unknown"')
        local channel_count=$(echo "$status" | jq -r '.channelCount // 0')
        local xrp_channel_count=$(echo "$status" | jq -r '.xrpChannelCount // 0')
        local events_sent=$(echo "$status" | jq -r '.eventsSent // 0')
        local events_received=$(echo "$status" | jq -r '.eventsReceived // 0')

        log_info "Agent $agent_id: EVM channels=$channel_count, XRP channels=$xrp_channel_count, sent=$events_sent, received=$events_received"
    done

    log_info "System verification complete"
}

# Main execution
main() {
    log_info "=========================================="
    log_info "Docker Agent Network Orchestration"
    log_info "=========================================="

    phase_start_infrastructure
    phase_deploy_evm_contracts
    phase_fund_xrp_accounts
    phase_start_agents
    phase_run_test_orchestrator
    phase_verify_system

    log_info "=========================================="
    log_info "Orchestration Complete!"
    log_info "=========================================="
    log_info ""
    log_info "Explorer UI available at:"
    for i in $(seq 0 $((AGENT_COUNT - 1))); do
        log_info "  - agent-$i: http://localhost:$((9100 + i))"
    done
    log_info ""
    log_info "To stop the network:"
    log_info "  docker compose -f $COMPOSE_FILE down -v"
}

# Handle arguments
case "${1:-}" in
    "start")
        phase_start_infrastructure
        phase_start_agents
        ;;
    "stop")
        docker compose -f "$COMPOSE_FILE" down -v
        ;;
    "test")
        phase_run_test_orchestrator
        ;;
    "verify")
        phase_verify_system
        ;;
    *)
        main
        ;;
esac
