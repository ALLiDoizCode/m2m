#!/usr/bin/env bash
# =============================================================================
# Solana Payment Channel Program — Deployment Script
#
# Deploys the payment channel program to devnet or mainnet-beta.
#
# Usage:
#   ./tools/solana/deploy.sh --network devnet --keypair ~/.config/solana/deployer.json
#   ./tools/solana/deploy.sh --network devnet --keypair deployer.json --upgrade-authority authority.json
#   make solana-deploy-devnet
#
# Prerequisites:
#   - Solana CLI >= 3.1.12 installed (solana --version)
#   - Deployer keypair funded (devnet: solana airdrop 5 --url devnet)
#   - Program built: cargo build-sbf (produces target/deploy/payment_channel.so)
#
# Deployment cost estimate:
#   ~$19-38 in refundable rent-exempt SOL at ~$89.67/SOL (March 2026).
#   The program binary is ~95KB.
#
# Upgrade Authority Transfer Process:
#   After initial deployment, the upgrade authority defaults to the deployer keypair.
#   To transfer upgrade authority to a designated keypair:
#
#   1. Deploy with --upgrade-authority flag:
#      ./deploy.sh --network devnet --keypair deployer.json --upgrade-authority authority.json
#
#   2. Or transfer manually after deployment:
#      solana program set-upgrade-authority <PROGRAM_ID> \
#        --new-upgrade-authority <AUTHORITY_PUBKEY> \
#        --keypair deployer.json \
#        --url <RPC_URL>
#
#   3. To make a program immutable (non-upgradeable):
#      solana program set-upgrade-authority <PROGRAM_ID> \
#        --final \
#        --keypair <CURRENT_AUTHORITY> \
#        --url <RPC_URL>
#
#   WARNING: Setting --final is irreversible. The program can never be upgraded again.
#
# Story: 33.3 (creates the script), Story 33.8 (executes the deployment)
# =============================================================================

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROGRAM_DIR="$PROJECT_ROOT/packages/solana-program"
PROGRAM_SO="$PROGRAM_DIR/target/deploy/payment_channel.so"
PROGRAM_ID_FILE="$SCRIPT_DIR/program-id.json"

# Network RPC URLs
DEVNET_URL="https://api.devnet.solana.com"
MAINNET_URL="https://api.mainnet-beta.solana.com"

# =============================================================================
# Argument Parsing
# =============================================================================

NETWORK=""
KEYPAIR=""
UPGRADE_AUTHORITY=""
EXISTING_PROGRAM_ID=""

usage() {
    echo "Usage: $0 --network <devnet|mainnet-beta> --keypair <path> [--upgrade-authority <path>] [--program-id <pubkey>]"
    echo ""
    echo "Options:"
    echo "  --network             Target network: devnet or mainnet-beta (required)"
    echo "  --keypair             Path to deployer keypair JSON file (required)"
    echo "  --upgrade-authority   Path to upgrade authority keypair JSON file (optional)"
    echo "                        If not specified, the deployer keypair retains upgrade authority."
    echo "  --program-id          Existing program ID for upgrade deployments (optional)"
    echo "                        If specified, deploys as an upgrade to the existing program."
    echo ""
    echo "Examples:"
    echo "  $0 --network devnet --keypair ~/.config/solana/deployer.json"
    echo "  $0 --network devnet --keypair deployer.json --upgrade-authority authority.json"
    echo "  $0 --network devnet --keypair deployer.json --program-id <PROGRAM_PUBKEY>"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --keypair)
            KEYPAIR="$2"
            shift 2
            ;;
        --upgrade-authority)
            UPGRADE_AUTHORITY="$2"
            shift 2
            ;;
        --program-id)
            EXISTING_PROGRAM_ID="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Error: Unknown option: $1"
            usage
            ;;
    esac
done

# Validate required arguments
if [[ -z "$NETWORK" ]]; then
    echo "Error: --network is required"
    usage
fi

if [[ -z "$KEYPAIR" ]]; then
    echo "Error: --keypair is required"
    usage
fi

# Validate network
case "$NETWORK" in
    devnet)
        RPC_URL="$DEVNET_URL"
        ;;
    mainnet-beta)
        RPC_URL="$MAINNET_URL"
        ;;
    *)
        echo "Error: Invalid network '$NETWORK'. Must be 'devnet' or 'mainnet-beta'."
        exit 1
        ;;
esac

# Validate keypair file exists
if [[ ! -f "$KEYPAIR" ]]; then
    echo "Error: Keypair file not found: $KEYPAIR"
    exit 1
fi

# Validate upgrade authority file if specified
if [[ -n "$UPGRADE_AUTHORITY" && ! -f "$UPGRADE_AUTHORITY" ]]; then
    echo "Error: Upgrade authority keypair file not found: $UPGRADE_AUTHORITY"
    exit 1
fi

# Validate program-id format if specified (base58 Solana pubkey: 32-44 alphanumeric chars)
if [[ -n "$EXISTING_PROGRAM_ID" && ! "$EXISTING_PROGRAM_ID" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
    echo "Error: Invalid program ID format: $EXISTING_PROGRAM_ID"
    echo "Expected a base58-encoded Solana public key (32-44 characters)."
    exit 1
fi

# =============================================================================
# Pre-flight Checks
# =============================================================================

echo "============================================"
echo "Solana Payment Channel Program — Deployment"
echo "============================================"
echo ""
echo "Network:            $NETWORK"
echo "RPC URL:            $RPC_URL"
echo "Deployer keypair:   $KEYPAIR"
if [[ -n "$UPGRADE_AUTHORITY" ]]; then
    echo "Upgrade authority:  $UPGRADE_AUTHORITY"
else
    echo "Upgrade authority:  (deployer keypair — default)"
fi
if [[ -n "$EXISTING_PROGRAM_ID" ]]; then
    echo "Upgrade target:     $EXISTING_PROGRAM_ID"
else
    echo "Deployment type:    initial (new program)"
fi
echo ""

# Check Solana CLI is installed
if ! command -v solana &> /dev/null; then
    echo "Error: Solana CLI not found. Install from https://docs.solanalabs.com/cli/install"
    exit 1
fi

SOLANA_VERSION=$(solana --version 2>&1 | head -1)
echo "Solana CLI: $SOLANA_VERSION"

# Check deployer balance
DEPLOYER_PUBKEY=$(solana-keygen pubkey "$KEYPAIR")
echo "Deployer address: $DEPLOYER_PUBKEY"

BALANCE=$(solana balance "$DEPLOYER_PUBKEY" --url "$RPC_URL" 2>&1 || true)
echo "Deployer balance: $BALANCE"
echo ""

# =============================================================================
# Mainnet Safety Confirmation
# =============================================================================

if [[ "$NETWORK" == "mainnet-beta" ]]; then
    echo "WARNING: You are about to deploy to MAINNET-BETA."
    echo "This will cost real SOL and the program will be publicly accessible."
    echo ""
    read -r -p "Are you sure you want to continue? (yes/no): " CONFIRM
    if [[ "$CONFIRM" != "yes" ]]; then
        echo "Deployment cancelled."
        exit 0
    fi
    echo ""
fi

# =============================================================================
# Build Program
# =============================================================================

echo "Building program..."
cd "$PROGRAM_DIR"
cargo build-sbf
echo "Build complete: $PROGRAM_SO"
echo ""

# Verify the .so file exists
if [[ ! -f "$PROGRAM_SO" ]]; then
    echo "Error: Program binary not found at $PROGRAM_SO"
    echo "Run 'cargo build-sbf' from $PROGRAM_DIR"
    exit 1
fi

PROGRAM_SIZE=$(wc -c < "$PROGRAM_SO" | tr -d ' ')
echo "Program binary size: $PROGRAM_SIZE bytes"
echo ""

# =============================================================================
# Deploy Program
# =============================================================================

echo "Deploying to $NETWORK..."
DEPLOY_STDERR_FILE=$(mktemp)
trap 'rm -f "$DEPLOY_STDERR_FILE"' EXIT

DEPLOY_ARGS=("$PROGRAM_SO" --url "$RPC_URL" --keypair "$KEYPAIR" --output json)
if [[ -n "$EXISTING_PROGRAM_ID" ]]; then
    DEPLOY_ARGS+=(--program-id "$EXISTING_PROGRAM_ID")
fi

DEPLOY_OUTPUT=$(solana program deploy "${DEPLOY_ARGS[@]}" 2>"$DEPLOY_STDERR_FILE") || {
    echo "Error: Deployment failed."
    cat "$DEPLOY_STDERR_FILE"
    rm -f "$DEPLOY_STDERR_FILE"
    exit 1
}

if [[ -s "$DEPLOY_STDERR_FILE" ]]; then
    echo "Deploy warnings:"
    cat "$DEPLOY_STDERR_FILE"
fi
rm -f "$DEPLOY_STDERR_FILE"

echo "Deploy output: $DEPLOY_OUTPUT"

# Extract program ID from deployment output
if command -v jq &> /dev/null; then
    PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | jq -r '.programId' 2>/dev/null || true)
else
    PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys, json; print(json.load(sys.stdin)['programId'])" 2>/dev/null || true)
fi

if [[ -z "$PROGRAM_ID" ]]; then
    echo "Error: Failed to extract program ID from deployment output."
    echo "Raw output: $DEPLOY_OUTPUT"
    exit 1
fi

echo ""
echo "Program deployed successfully!"
echo "Program ID: $PROGRAM_ID"

# =============================================================================
# Set Upgrade Authority (if specified)
# =============================================================================

if [[ -n "$UPGRADE_AUTHORITY" ]]; then
    AUTHORITY_PUBKEY=$(solana-keygen pubkey "$UPGRADE_AUTHORITY")
    echo ""
    echo "Setting upgrade authority to: $AUTHORITY_PUBKEY"

    solana program set-upgrade-authority "$PROGRAM_ID" \
        --new-upgrade-authority "$AUTHORITY_PUBKEY" \
        --keypair "$KEYPAIR" \
        --url "$RPC_URL"

    echo "Upgrade authority set to: $AUTHORITY_PUBKEY"
fi

# =============================================================================
# Save Program ID
# =============================================================================

DEPLOY_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if command -v jq &> /dev/null; then
    jq -n \
        --arg pid "$PROGRAM_ID" \
        --arg net "$NETWORK" \
        --arg rpc "$RPC_URL" \
        --arg ts "$DEPLOY_TIMESTAMP" \
        --arg dpk "$DEPLOYER_PUBKEY" \
        --argjson sz "$PROGRAM_SIZE" \
        '{programId: $pid, network: $net, rpcUrl: $rpc, deployedAt: $ts, deployerPubkey: $dpk, binarySize: $sz}' \
        > "$PROGRAM_ID_FILE"
else
    # Sanitize values for safe JSON embedding (escape backslashes and double quotes)
    _safe_pid="${PROGRAM_ID//\\/\\\\}"; _safe_pid="${_safe_pid//\"/\\\"}"
    _safe_net="${NETWORK//\\/\\\\}"; _safe_net="${_safe_net//\"/\\\"}"
    _safe_rpc="${RPC_URL//\\/\\\\}"; _safe_rpc="${_safe_rpc//\"/\\\"}"
    _safe_ts="${DEPLOY_TIMESTAMP//\\/\\\\}"; _safe_ts="${_safe_ts//\"/\\\"}"
    _safe_dpk="${DEPLOYER_PUBKEY//\\/\\\\}"; _safe_dpk="${_safe_dpk//\"/\\\"}"
    cat > "$PROGRAM_ID_FILE" <<ENDJSON
{
  "programId": "${_safe_pid}",
  "network": "${_safe_net}",
  "rpcUrl": "${_safe_rpc}",
  "deployedAt": "${_safe_ts}",
  "deployerPubkey": "${_safe_dpk}",
  "binarySize": $PROGRAM_SIZE
}
ENDJSON
fi

echo ""
echo "Program ID saved to: $PROGRAM_ID_FILE"

# =============================================================================
# Verify Deployment
# =============================================================================

echo ""
echo "Verifying deployment..."
solana program show "$PROGRAM_ID" --url "$RPC_URL"

echo ""
echo "============================================"
echo "Deployment complete!"
echo "============================================"
echo "Program ID:   $PROGRAM_ID"
echo "Network:      $NETWORK"
echo "Config file:  $PROGRAM_ID_FILE"
echo ""
echo "To verify manually:"
echo "  solana program show $PROGRAM_ID --url $RPC_URL"
echo ""
