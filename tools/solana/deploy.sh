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
#   ./tools/solana/deploy.sh --network mainnet-beta --keypair deployer.json \
#     --upgrade-authority-decision transfer --upgrade-authority authority.json
#   (see docs/solana-deployment.md's "Mainnet Deployment Runbook" for the full
#   mainnet-beta procedure, including the two decisions --upgrade-authority-decision
#   and --max-len require you to make before this command is run)
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
#   On mainnet-beta, --upgrade-authority-decision (required) forces this choice to be
#   made and recorded before the deploy command runs, rather than defaulted into
#   silently (issue #954). --final itself stays a deliberate, separate follow-up step
#   (this script never passes --final on your behalf) since it is irreversible.
#
# Mainnet-beta defaults (both flags parse on any network; what is mainnet-only is
# their defaulting and validation -- on devnet --token-mint is only echoed back and
# recorded, and --max-len is passed through exactly as given):
#   --token-mint records which SPL mint channels opened against this program instance
#   are expected to settle in (default: Circle's native USDC mint on Solana mainnet,
#   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v). This is documentation only -- the
#   payment-channel program takes no mint at deploy time; each channel names its own
#   mint when it is opened later. This script contains no mint-creation code path at
#   all (unlike infra/solana/create-usdc-mint.sh, the devnet mock-USDC tool, which
#   refuses to run against a mainnet-beta RPC), so creating a mint from this path is
#   structurally impossible, not merely unused.
#
#   --max-len sizes the deployed ProgramData account with upgrade headroom instead of
#   exactly the binary (see "Deployment Cost Estimates" / "Upgrade headroom" in
#   docs/solana-deployment.md). On mainnet-beta, an initial deploy with no --max-len
#   computes a default headroom automatically and prints the rent it costs.
#
# Story: 33.3 (creates the script), Story 33.8 (executes the deployment)
# Issue #954 (mainnet deploy path: token-mint recording, upgrade-authority-decision
# gate, max_len headroom)
# =============================================================================

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROGRAM_DIR="$PROJECT_ROOT/packages/solana-program"
# packages/solana-program is a member of the root Cargo workspace, so build
# output lands in the workspace-root target/, not a per-crate one.
PROGRAM_SO="$PROJECT_ROOT/target/deploy/payment_channel.so"
# Set below, once NETWORK is parsed: program-id.json for devnet (unchanged
# filename, existing tooling/docs keep working), program-id.mainnet.json for
# mainnet-beta (a separate file so neither record can clobber the other).
PROGRAM_ID_FILE=""

# Network RPC URLs
DEVNET_URL="https://api.devnet.solana.com"
MAINNET_URL="https://api.mainnet-beta.solana.com"

# Circle's native USDC mint on Solana mainnet (https://www.circle.com/multi-chain-usdc).
# The default --token-mint on mainnet-beta -- see the header comment above for why this
# is a recorded convention, not an on-chain constraint the program enforces.
MAINNET_USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Default upgrade headroom for a mainnet-beta INITIAL deploy with no explicit --max-len:
# 25% over the built binary's size, giving a later upgrade room to grow into without a
# separate `solana program extend` call. See "Deployment Cost Estimates" in
# docs/solana-deployment.md for the rent-exemption formula this headroom costs against.
DEFAULT_MAINNET_HEADROOM_PERCENT=25

# =============================================================================
# Argument Parsing
# =============================================================================

NETWORK=""
KEYPAIR=""
UPGRADE_AUTHORITY=""
EXISTING_PROGRAM_ID=""
TOKEN_MINT="${TOKEN_MINT:-}"
MAX_LEN="${MAX_LEN:-}"
UPGRADE_AUTHORITY_DECISION="${UPGRADE_AUTHORITY_DECISION:-}"

usage() {
    echo "Usage: $0 --network <devnet|mainnet-beta> --keypair <path> [--upgrade-authority <path>] [--program-id <pubkey>]"
    echo "          [--token-mint <pubkey>] [--max-len <bytes>] [--upgrade-authority-decision <deployer|transfer>]"
    echo ""
    echo "Options:"
    echo "  --network                     Target network: devnet or mainnet-beta (required)"
    echo "  --keypair                     Path to deployer keypair JSON file (required)"
    echo "  --upgrade-authority           Path to upgrade authority keypair JSON file (optional)"
    echo "                                If not specified, the deployer keypair retains upgrade authority."
    echo "  --program-id                  Existing program ID for upgrade deployments (optional)"
    echo "                                If specified, deploys as an upgrade to the existing program."
    echo "  --token-mint                  Base58 SPL mint channels opened against this program are"
    echo "                                expected to settle in. On mainnet-beta it is validated and"
    echo "                                defaults to Circle's native USDC mint"
    echo "                                ($MAINNET_USDC_MINT); elsewhere it is"
    echo "                                recorded as given. Documentation only -- see the header comment."
    echo "  --max-len                     ProgramData size (bytes) to allocate, giving upgrade headroom"
    echo "                                beyond the built binary. On a mainnet-beta initial deploy,"
    echo "                                defaults to +${DEFAULT_MAINNET_HEADROOM_PERCENT}% of the binary size if omitted."
    echo "  --upgrade-authority-decision  Required for mainnet-beta: 'deployer' (deployer keypair keeps"
    echo "                                upgrade authority) or 'transfer' (requires --upgrade-authority)."
    echo "                                Forces this decision to be made and recorded before the deploy"
    echo "                                runs -- see docs/solana-deployment.md's mainnet runbook."
    echo ""
    echo "Examples:"
    echo "  $0 --network devnet --keypair ~/.config/solana/deployer.json"
    echo "  $0 --network devnet --keypair deployer.json --upgrade-authority authority.json"
    echo "  $0 --network devnet --keypair deployer.json --program-id <PROGRAM_PUBKEY>"
    echo "  $0 --network mainnet-beta --keypair deployer.json \\"
    echo "     --upgrade-authority-decision transfer --upgrade-authority authority.json"
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
        --token-mint)
            TOKEN_MINT="$2"
            shift 2
            ;;
        --max-len)
            MAX_LEN="$2"
            shift 2
            ;;
        --upgrade-authority-decision)
            UPGRADE_AUTHORITY_DECISION="$2"
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
        PROGRAM_ID_FILE="$SCRIPT_DIR/program-id.json"
        ;;
    mainnet-beta)
        RPC_URL="$MAINNET_URL"
        PROGRAM_ID_FILE="$SCRIPT_DIR/program-id.mainnet.json"
        ;;
    *)
        echo "Error: Invalid network '$NETWORK'. Must be 'devnet' or 'mainnet-beta'."
        exit 1
        ;;
esac

# =============================================================================
# Mainnet-beta-only validation (issue #954)
#
# Runs before any file/network check below so a misconfigured mainnet-beta
# invocation fails immediately on the decisions themselves, not partway
# through a build.
# =============================================================================

if [[ "$NETWORK" == "mainnet-beta" ]]; then
    # The upgrade-authority decision must be made and recorded before this
    # command runs, not defaulted into silently. --final (making the program
    # immutable) is deliberately NOT an option here: it is an irreversible,
    # separate follow-up step (see the header comment and
    # docs/solana-deployment.md), never something this script does on your
    # behalf as a side effect of an initial deploy.
    case "$UPGRADE_AUTHORITY_DECISION" in
        deployer)
            ;;
        transfer)
            if [[ -z "$UPGRADE_AUTHORITY" ]]; then
                echo "Error: --upgrade-authority-decision transfer requires --upgrade-authority <path>."
                exit 1
            fi
            ;;
        "")
            echo "Error: --upgrade-authority-decision is required for --network mainnet-beta."
            echo "Record the decision first (see docs/solana-deployment.md's mainnet runbook), then pass"
            echo "--upgrade-authority-decision deployer  (deployer keypair keeps upgrade authority), or"
            echo "--upgrade-authority-decision transfer --upgrade-authority <path>  (transfer it now)."
            exit 1
            ;;
        *)
            echo "Error: --upgrade-authority-decision must be 'deployer' or 'transfer', got '$UPGRADE_AUTHORITY_DECISION'."
            exit 1
            ;;
    esac

    # Bind (record) the settlement mint. This script never creates a mint --
    # see the header comment for why "impossible", not merely "skipped".
    if [[ -z "$TOKEN_MINT" ]]; then
        TOKEN_MINT="$MAINNET_USDC_MINT"
        echo "No --token-mint given; defaulting to Circle's native USDC mint on Solana mainnet: $TOKEN_MINT"
    fi
    if [[ ! "$TOKEN_MINT" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
        echo "Error: --token-mint '$TOKEN_MINT' is not a valid base58 Solana pubkey."
        exit 1
    fi
    if [[ "$TOKEN_MINT" != "$MAINNET_USDC_MINT" ]]; then
        echo "WARNING: --token-mint does not match Circle's known native USDC mint on Solana mainnet"
        echo "($MAINNET_USDC_MINT). Proceeding with the explicitly given mint -- this script"
        echo "never creates or verifies a mint on-chain, it only records which one this deploy expects"
        echo "channels to settle in."
    fi

    # --max-len must be a positive integer if given; the binary-size-relative
    # default is computed after the build below, once PROGRAM_SIZE is known.
    if [[ -n "$MAX_LEN" && ! "$MAX_LEN" =~ ^[1-9][0-9]*$ ]]; then
        echo "Error: --max-len '$MAX_LEN' must be a positive integer (bytes)."
        exit 1
    fi
elif [[ -n "$TOKEN_MINT" ]]; then
    echo "Note: --token-mint is recorded for documentation only outside --network mainnet-beta;"
    echo "this script never creates or binds a mint on-chain on any network."
fi

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
if [[ "$NETWORK" == "mainnet-beta" ]]; then
    echo "Token mint:         $TOKEN_MINT (recorded only -- see header comment)"
    echo "Authority decision: $UPGRADE_AUTHORITY_DECISION"
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

# On a mainnet-beta INITIAL deploy (no --program-id: an upgrade reuses the
# existing ProgramData account's max_len, which cannot be changed here) with
# no explicit --max-len, allocate upgrade headroom instead of sizing
# ProgramData to exactly the binary -- see the header comment and
# docs/solana-deployment.md's "Mainnet Deployment Runbook" for why and how
# much. The rent this headroom costs is refundable (see "Rent Economics"),
# but it is real SOL escrowed upfront, so it is printed here, not silent.
if [[ "$NETWORK" == "mainnet-beta" && -z "$EXISTING_PROGRAM_ID" && -z "$MAX_LEN" ]]; then
    HEADROOM_BYTES=$(( PROGRAM_SIZE * DEFAULT_MAINNET_HEADROOM_PERCENT / 100 ))
    MAX_LEN=$(( PROGRAM_SIZE + HEADROOM_BYTES ))
    HEADROOM_RENT_LAMPORTS=$(( HEADROOM_BYTES * 6960 ))
    echo "No --max-len given; allocating +${DEFAULT_MAINNET_HEADROOM_PERCENT}% upgrade headroom:"
    echo "  max_len:        $MAX_LEN bytes ($PROGRAM_SIZE binary + $HEADROOM_BYTES headroom)"
    echo "  extra rent:     $HEADROOM_RENT_LAMPORTS lamports for the headroom alone (refundable; see"
    echo "                  docs/solana-deployment.md's rent-exemption formula)"
    echo ""
fi

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
if [[ -n "$MAX_LEN" ]]; then
    DEPLOY_ARGS+=(--max-len "$MAX_LEN")
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
        --arg mint "$TOKEN_MINT" \
        --argjson maxlen "${MAX_LEN:-null}" \
        '{programId: $pid, network: $net, rpcUrl: $rpc, deployedAt: $ts, deployerPubkey: $dpk, binarySize: $sz, tokenMint: (if $mint == "" then null else $mint end), maxLen: $maxlen}' \
        > "$PROGRAM_ID_FILE"
else
    # Sanitize values for safe JSON embedding (escape backslashes and double quotes)
    _safe_pid="${PROGRAM_ID//\\/\\\\}"; _safe_pid="${_safe_pid//\"/\\\"}"
    _safe_net="${NETWORK//\\/\\\\}"; _safe_net="${_safe_net//\"/\\\"}"
    _safe_rpc="${RPC_URL//\\/\\\\}"; _safe_rpc="${_safe_rpc//\"/\\\"}"
    _safe_ts="${DEPLOY_TIMESTAMP//\\/\\\\}"; _safe_ts="${_safe_ts//\"/\\\"}"
    _safe_dpk="${DEPLOYER_PUBKEY//\\/\\\\}"; _safe_dpk="${_safe_dpk//\"/\\\"}"
    _safe_mint="${TOKEN_MINT//\\/\\\\}"; _safe_mint="${_safe_mint//\"/\\\"}"
    _token_mint_json="null"
    [[ -n "$TOKEN_MINT" ]] && _token_mint_json="\"${_safe_mint}\""
    _max_len_json="${MAX_LEN:-null}"
    cat > "$PROGRAM_ID_FILE" <<ENDJSON
{
  "programId": "${_safe_pid}",
  "network": "${_safe_net}",
  "rpcUrl": "${_safe_rpc}",
  "deployedAt": "${_safe_ts}",
  "deployerPubkey": "${_safe_dpk}",
  "binarySize": $PROGRAM_SIZE,
  "tokenMint": ${_token_mint_json},
  "maxLen": ${_max_len_json}
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
