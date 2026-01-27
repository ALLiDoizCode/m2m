#!/bin/bash
# Fund XRP Accounts from Genesis
#
# This script funds XRP test accounts from the rippled standalone genesis account.
# It generates deterministic wallets for each agent and funds them with XRP.
#
# Prerequisites:
#   - rippled running in standalone mode at localhost:5005
#   - curl, jq installed
#
# Usage:
#   ./scripts/fund-xrp-accounts.sh
#
# Environment Variables:
#   AGENT_COUNT - Number of agents to fund (default: 5)
#   XRP_FUND_AMOUNT - XRP to fund each agent (default: 10000000000 drops = 10,000 XRP)
#   RIPPLED_URL - rippled JSON-RPC URL (default: http://localhost:5005)

set -e

# Configuration
AGENT_COUNT=${AGENT_COUNT:-5}
XRP_FUND_AMOUNT=${XRP_FUND_AMOUNT:-10000000000}  # 10,000 XRP in drops
RIPPLED_URL=${RIPPLED_URL:-http://localhost:5005}

# Rippled standalone genesis account credentials
# This is the default genesis account for rippled in standalone mode
# WARNING: These credentials are ONLY for local development/testing
GENESIS_SECRET="snoPBrXtMeMyMHUVTgbuqAfg1SUTb"
GENESIS_ADDRESS="rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"

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

# Generate a deterministic XRP wallet seed from agent ID
# This uses the agent ID to create a consistent seed for testing
generate_agent_seed() {
    local agent_index=$1
    # Generate deterministic seed based on agent index
    # This is for TESTING ONLY - production should use proper key generation
    local seed_base="peer-${agent_index}-xrp-seed"
    local seed_hash=$(echo -n "$seed_base" | openssl dgst -sha256 | awk '{print $2}')
    # Take first 16 bytes (32 hex chars) and encode as seed
    # For simplicity, we'll use xrpl.js to generate proper seeds in the test runner
    echo "$seed_hash"
}

# Submit a transaction to rippled
submit_transaction() {
    local tx_json=$1

    # Sign the transaction with genesis account
    local sign_response=$(curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d "{
            \"method\": \"sign\",
            \"params\": [{
                \"secret\": \"$GENESIS_SECRET\",
                \"tx_json\": $tx_json
            }]
        }" 2>/dev/null)

    if [ -z "$sign_response" ]; then
        log_error "Failed to sign transaction"
        return 1
    fi

    local tx_blob=$(echo "$sign_response" | jq -r '.result.tx_blob // empty')
    if [ -z "$tx_blob" ]; then
        log_error "Failed to get tx_blob from sign response"
        echo "$sign_response" | jq .
        return 1
    fi

    # Submit the signed transaction
    local submit_response=$(curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d "{
            \"method\": \"submit\",
            \"params\": [{
                \"tx_blob\": \"$tx_blob\"
            }]
        }" 2>/dev/null)

    if [ -z "$submit_response" ]; then
        log_error "Failed to submit transaction"
        return 1
    fi

    local engine_result=$(echo "$submit_response" | jq -r '.result.engine_result // empty')
    if [ "$engine_result" != "tesSUCCESS" ] && [ "$engine_result" != "terQUEUED" ]; then
        log_error "Transaction failed: $engine_result"
        echo "$submit_response" | jq .
        return 1
    fi

    echo "$submit_response"
}

# Close ledger in standalone mode
close_ledger() {
    curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d '{"method":"ledger_accept","params":[{}]}' > /dev/null 2>&1 || true
}

# Get account info
get_account_info() {
    local address=$1
    curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d "{
            \"method\": \"account_info\",
            \"params\": [{
                \"account\": \"$address\",
                \"ledger_index\": \"validated\"
            }]
        }" 2>/dev/null
}

# Generate wallet for agent (using rippled wallet_propose)
generate_wallet() {
    local seed_phrase=$1
    local response=$(curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d "{
            \"method\": \"wallet_propose\",
            \"params\": [{
                \"key_type\": \"ed25519\"
            }]
        }" 2>/dev/null)

    if [ -z "$response" ]; then
        log_error "Failed to generate wallet"
        return 1
    fi

    echo "$response"
}

# Fund a single account
fund_account() {
    local destination=$1
    local amount=$2

    log_info "Funding $destination with $amount drops..."

    # Get current sequence number for genesis account
    local account_info=$(get_account_info "$GENESIS_ADDRESS")
    local sequence=$(echo "$account_info" | jq -r '.result.account_data.Sequence // 1')

    # Create Payment transaction
    local tx_json="{
        \"TransactionType\": \"Payment\",
        \"Account\": \"$GENESIS_ADDRESS\",
        \"Destination\": \"$destination\",
        \"Amount\": \"$amount\",
        \"Sequence\": $sequence
    }"

    local result=$(submit_transaction "$tx_json")
    if [ $? -eq 0 ]; then
        # Close ledger to confirm transaction
        close_ledger
        sleep 1
        log_info "Successfully funded $destination"
        return 0
    else
        log_error "Failed to fund $destination"
        return 1
    fi
}

# Main function
main() {
    log_info "=========================================="
    log_info "XRP Account Funding for Agent Network"
    log_info "=========================================="

    # Check rippled is accessible
    log_info "Checking rippled connection..."
    local server_info=$(curl -sf -X POST "$RIPPLED_URL" \
        -H "Content-Type: application/json" \
        -d '{"method":"server_info","params":[{}]}' 2>/dev/null)

    if [ -z "$server_info" ]; then
        log_error "Cannot connect to rippled at $RIPPLED_URL"
        exit 1
    fi

    local state=$(echo "$server_info" | jq -r '.result.info.server_state // empty')
    log_info "rippled state: $state"

    # Check genesis account balance
    log_info "Checking genesis account..."
    local genesis_info=$(get_account_info "$GENESIS_ADDRESS")
    local genesis_balance=$(echo "$genesis_info" | jq -r '.result.account_data.Balance // "0"')
    log_info "Genesis account balance: $genesis_balance drops"

    # Generate wallets and fund each agent
    log_info ""
    log_info "Generating and funding agent wallets..."

    local wallets_file="/tmp/xrp-agent-wallets.json"
    echo "[" > "$wallets_file"

    for i in $(seq 0 $((AGENT_COUNT - 1))); do
        log_info ""
        log_info "--- Agent $i ---"

        # Generate a new wallet
        local wallet_response=$(generate_wallet)
        local address=$(echo "$wallet_response" | jq -r '.result.account_id')
        local secret=$(echo "$wallet_response" | jq -r '.result.master_seed')
        local public_key=$(echo "$wallet_response" | jq -r '.result.public_key')

        if [ -z "$address" ] || [ "$address" = "null" ]; then
            log_error "Failed to generate wallet for agent $i"
            continue
        fi

        log_info "Address: $address"
        log_info "Public Key: $public_key"

        # Fund the account
        fund_account "$address" "$XRP_FUND_AMOUNT"

        # Verify funding
        sleep 1
        local account_info=$(get_account_info "$address")
        local balance=$(echo "$account_info" | jq -r '.result.account_data.Balance // "0"')
        log_info "Confirmed balance: $balance drops"

        # Save wallet info to file (for test runner to use)
        if [ $i -gt 0 ]; then
            echo "," >> "$wallets_file"
        fi
        echo "  {\"agentIndex\": $i, \"address\": \"$address\", \"secret\": \"$secret\", \"publicKey\": \"$public_key\"}" >> "$wallets_file"
    done

    echo "]" >> "$wallets_file"

    log_info ""
    log_info "=========================================="
    log_info "Funding Complete!"
    log_info "=========================================="
    log_info "Wallet info saved to: $wallets_file"
    log_info ""
    log_info "To configure agents with these wallets, run:"
    log_info "  cat $wallets_file | jq ."
}

main "$@"
