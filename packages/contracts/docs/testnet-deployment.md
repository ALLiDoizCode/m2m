# Base Sepolia Testnet Deployment Guide - M2M Payment Channels

**Version:** 1.0
**Date:** 2026-01-05
**Network:** Base Sepolia (Testnet)
**Chain ID:** 84532
**Status:** Pre-Deployment

## Overview

This document provides step-by-step instructions for deploying M2M payment channel smart contracts to Base Sepolia testnet.

**⚠️ IMPORTANT: Local Testing First!**

Testnet deployment should ONLY occur after extensive testing on local Anvil nodes. The testing hierarchy is:

1. **Local Anvil Testing** (Primary) - All development and testing
2. **Base Sepolia Testnet** (Final Validation) - Bug bounty and community testing only
3. **Base Mainnet** (Production) - After testnet validation

**Testnet Deployment Goals:**

1. Enable bug bounty program for external security testing
2. Gather community feedback on deployed contracts
3. Validate deployment scripts in production-like environment
4. Final gas cost validation on actual L2 network
5. Practice emergency procedures with real network conditions

**NOT for Testnet:**

- ❌ Primary development testing (use local Anvil)
- ❌ Unit test execution (use local Foundry tests)
- ❌ Integration test development (use local Anvil)
- ❌ Gas optimization iteration (use local `forge test --gas-report`)

## Local Testing Workflow (Complete This FIRST)

Before deploying to Base Sepolia testnet, complete comprehensive testing on local Anvil nodes.

### Step 1: Run Full Test Suite Locally

```bash
# Navigate to contracts directory
cd packages/contracts

# Start local Anvil node (in separate terminal)
anvil

# Run all tests against local node
forge test -vv

# Expected output: 122/122 tests passing

# Run coverage analysis
forge coverage

# Expected: >95% line coverage

# Run gas benchmarks
forge test --gas-report

# Expected: All operations within adjusted targets
```

### Step 2: Test Local Deployment

```bash
# Deploy to local Anvil (in separate terminal with anvil running)
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url http://localhost:8545 \
  --broadcast

# Verify deployment succeeded
# Record deployed addresses from output
```

### Step 3: Test Full Channel Lifecycle Locally

```bash
# Set environment variables
export REGISTRY=<deployed_registry_address>
export TOKEN_NETWORK=<deployed_tokennetwork_address>
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Test channel lifecycle (see integration tests for full examples)
# 1. Open channel
# 2. Deposit funds
# 3. Close channel
# 4. Settle channel
# 5. Verify final balances

# Run integration tests that validate this
forge test --match-test testFullChannelLifecycle -vv
```

### Step 4: Test Emergency Procedures Locally

```bash
# Test pause functionality
cast send $TOKEN_NETWORK "pause()" \
  --rpc-url http://localhost:8545 \
  --private-key $PRIVATE_KEY

# Verify paused
cast call $TOKEN_NETWORK "paused()" \
  --rpc-url http://localhost:8545
# Expected: true (0x0000...0001)

# Test unpause
cast send $TOKEN_NETWORK "unpause()" \
  --rpc-url http://localhost:8545 \
  --private-key $PRIVATE_KEY

# Test emergency recovery (while paused)
# See emergency-procedures.md for full testing
```

### Step 5: Local Testing Checklist

- [ ] All 122 tests pass locally
- [ ] Deployment script works on local Anvil
- [ ] Can open channel on local node
- [ ] Can deposit on local node
- [ ] Can close and settle channel on local node
- [ ] Pause/unpause works on local node
- [ ] Emergency recovery works on local node (when paused)
- [ ] Gas costs match expected ranges
- [ ] No unexpected errors in any operation

**ONLY PROCEED TO TESTNET AFTER ALL LOCAL TESTS PASS**

---

## Prerequisites

### Required Before Testnet Deployment

**Local Testing Completion (CRITICAL):**

- [ ] All tests passing on local Anvil: `forge test` (122/122 tests)
- [ ] Code coverage >95%: `forge coverage`
- [ ] Gas benchmarks within targets: `forge test --gas-report`
- [ ] Invariant tests passing: `forge test --match-test invariant` (1000 runs)
- [ ] Fuzz tests passing: `forge test --fuzz-runs 10000`
- [ ] Local deployment tested: `anvil` + deployment scripts validated
- [ ] Full channel lifecycle tested on local Anvil
- [ ] Emergency procedures tested on local Anvil (pause, unpause, recovery)
- [ ] Multi-channel scenarios validated on local Anvil
- [ ] All edge cases from audit findings tested locally

**Audit Completion:**

- [ ] Security audit completed and signed off
- [ ] All Critical findings resolved and tested locally
- [ ] All High findings resolved and tested locally
- [ ] Medium findings resolved/acknowledged
- [ ] Final audit report published

**Deployment Readiness:**

- [ ] Code freeze in effect (no changes post-audit)
- [ ] All local tests passing after code freeze
- [ ] Deployment scripts validated on local Anvil

**Infrastructure Setup:**

- [ ] Base Sepolia RPC endpoint configured
- [ ] Testnet deployment wallet created and funded
- [ ] Basescan API key obtained
- [ ] Monitoring tools configured (Tenderly testnet)
- [ ] Documentation updated

## Base Sepolia Network Information

### Network Details

**Network Name:** Base Sepolia
**Chain ID:** 84532
**RPC URL:** https://sepolia.base.org
**Explorer:** https://sepolia.basescan.org
**Currency:** Sepolia ETH (testnet ETH)

### Faucets

**Primary Faucet:** Base Sepolia Faucet

- URL: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- Provides: Sepolia ETH for Base Sepolia
- Limit: 0.05 ETH per day

**Alternative Faucets:**

- Alchemy Faucet: https://www.alchemy.com/faucets/ethereum-sepolia
- Infura Faucet: https://www.infura.io/faucet/sepolia
- QuickNode Faucet: https://faucet.quicknode.com/base/sepolia

**Getting Testnet ETH:**

1. Get Sepolia ETH from Ethereum Sepolia faucet
2. Bridge to Base Sepolia using official bridge: https://bridge.base.org/deposit
3. Or use Base Sepolia faucet directly

### Test ERC20 Tokens

**USDC (Testnet Mock):**

- Address: TBD (will be deployed)
- Decimals: 6
- Faucet: TBD (will create faucet function)

**DAI (Testnet Mock):**

- Address: TBD (will be deployed)
- Decimals: 18
- Faucet: TBD (will create faucet function)

**Note:** We'll deploy our own MockERC20 tokens with faucet functionality for testing.

## Deployment Environment Setup

### Step 1: Configure Environment Variables

```bash
# Navigate to contracts directory
cd packages/contracts

# Create testnet environment file
cp .env.example .env.sepolia

# Edit .env.sepolia
nano .env.sepolia
```

**Required Environment Variables:**

```bash
# Base Sepolia RPC URL
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Or use Alchemy/Infura for better reliability
# BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR-API-KEY

# Deployment wallet private key (NEVER commit this!)
PRIVATE_KEY=0x... # Your testnet deployment wallet private key

# Basescan API key for contract verification
ETHERSCAN_API_KEY=YOUR-BASESCAN-API-KEY

# Optional: Tenderly credentials for monitoring
TENDERLY_ACCESS_KEY=YOUR-TENDERLY-KEY
TENDERLY_PROJECT_SLUG=m2m-testnet
```

**Security Note:**

- NEVER use mainnet private keys for testnet
- NEVER commit .env.sepolia to git
- Add .env.sepolia to .gitignore

### Step 2: Fund Deployment Wallet

```bash
# Check deployment wallet address
cast wallet address --private-key $PRIVATE_KEY

# Expected output: 0x...

# Fund wallet with testnet ETH (minimum 0.5 ETH recommended)
# Use Base Sepolia faucet or bridge from Ethereum Sepolia

# Verify balance
cast balance <DEPLOYER_ADDRESS> --rpc-url $BASE_SEPOLIA_RPC_URL

# Should show balance in wei (500000000000000000 = 0.5 ETH)
```

### Step 3: Verify RPC Connection

```bash
# Test RPC connection
cast chain-id --rpc-url $BASE_SEPOLIA_RPC_URL

# Expected output: 84532

# Get current block number
cast block-number --rpc-url $BASE_SEPOLIA_RPC_URL

# Verify network is Base Sepolia
cast client --rpc-url $BASE_SEPOLIA_RPC_URL
```

## Deployment Procedure

### Phase 1: Deploy Test ERC20 Tokens (Optional)

If you want to deploy custom test tokens with faucet functionality:

```bash
# Deploy MockERC20 for USDC (6 decimals)
forge create src/MockERC20.sol:MockERC20 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args "Test USDC" "USDC" 6 \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record USDC address
USDC_ADDRESS=0x...

# Deploy MockERC20 for DAI (18 decimals)
forge create src/MockERC20.sol:MockERC20 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args "Test DAI" "DAI" 18 \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record DAI address
DAI_ADDRESS=0x...

# Mint test tokens to your address for testing
cast send $USDC_ADDRESS \
  "mint(address,uint256)" \
  <YOUR_ADDRESS> \
  1000000000000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY
```

### Phase 2: Deploy TokenNetworkRegistry

```bash
# Deploy TokenNetworkRegistry
forge script script/Deploy.s.sol:DeployRegistry \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  -vvvv

# Expected output:
# TokenNetworkRegistry deployed at: 0x...
# Transaction hash: 0x...
# Verification submitted to Basescan

# Record deployment info
echo "TokenNetworkRegistry: <address>" >> deployments/sepolia.txt
echo "TX: <tx_hash>" >> deployments/sepolia.txt
echo "Block: <block_number>" >> deployments/sepolia.txt
echo "Deployer: $(cast wallet address --private-key $PRIVATE_KEY)" >> deployments/sepolia.txt
echo "Timestamp: $(date)" >> deployments/sepolia.txt
```

**Verify Deployment:**

```bash
# Check contract exists
cast code <REGISTRY_ADDRESS> --rpc-url $BASE_SEPOLIA_RPC_URL

# Should return bytecode (not 0x)

# Check owner
cast call <REGISTRY_ADDRESS> \
  "owner()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL

# Should return deployer address

# View on Basescan
echo "https://sepolia.basescan.org/address/<REGISTRY_ADDRESS>"
```

### Phase 3: Deploy TokenNetworks

```bash
# Deploy USDC TokenNetwork
forge script script/Deploy.s.sol:DeployTokenNetwork \
  --sig "deployTokenNetwork(address)" \
  $USDC_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record USDC TokenNetwork address
USDC_TOKEN_NETWORK=0x...
echo "USDC TokenNetwork: $USDC_TOKEN_NETWORK" >> deployments/sepolia.txt

# Deploy DAI TokenNetwork
forge script script/Deploy.s.sol:DeployTokenNetwork \
  --sig "deployTokenNetwork(address)" \
  $DAI_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record DAI TokenNetwork address
DAI_TOKEN_NETWORK=0x...
echo "DAI TokenNetwork: $DAI_TOKEN_NETWORK" >> deployments/sepolia.txt
```

### Phase 4: Verify All Contracts on Basescan

```bash
# Verify TokenNetworkRegistry
forge verify-contract \
  <REGISTRY_ADDRESS> \
  src/TokenNetworkRegistry.sol:TokenNetworkRegistry \
  --chain-id 84532 \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Verify USDC TokenNetwork
forge verify-contract \
  $USDC_TOKEN_NETWORK \
  src/TokenNetwork.sol:TokenNetwork \
  --chain-id 84532 \
  --constructor-args $(cast abi-encode "constructor(address)" $USDC_ADDRESS) \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Verify DAI TokenNetwork
forge verify-contract \
  $DAI_TOKEN_NETWORK \
  src/TokenNetwork.sol:TokenNetwork \
  --chain-id 84532 \
  --constructor-args $(cast abi-encode "constructor(address)" $DAI_ADDRESS) \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

**Check Verification:**

- Visit Basescan: https://sepolia.basescan.org/address/<CONTRACT_ADDRESS>
- Verify "Contract" tab shows green checkmark
- Verify source code visible under "Contract" → "Code"
- Verify "Read Contract" and "Write Contract" tabs work

### Phase 5: Post-Deployment Configuration (Optional)

```bash
# Enable whitelist (if desired for testnet)
cast send <REGISTRY_ADDRESS> \
  "setWhitelistEnabled(bool)" \
  true \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Add tokens to whitelist
cast send <REGISTRY_ADDRESS> \
  "addAllowedToken(address)" \
  $USDC_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Set deposit limits (optional, for testing limits)
cast send $USDC_TOKEN_NETWORK \
  "setMaxDeposit(uint256)" \
  10000000000000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY
```

## Post-Deployment Validation

### Smoke Test 1: Open Channel

```bash
# Approve USDC for TokenNetwork
cast send $USDC_ADDRESS \
  "approve(address,uint256)" \
  $USDC_TOKEN_NETWORK \
  1000000000000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Open test channel (1 hour settlement timeout)
cast send $USDC_TOKEN_NETWORK \
  "openChannel(address,uint256)" \
  <TEST_PARTICIPANT2_ADDRESS> \
  3600 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Get channel ID from transaction receipt
# Channel ID = keccak256(abi.encodePacked(participant1, participant2, tokenAddress))
```

### Smoke Test 2: Make Deposit

```bash
# Calculate channel ID
CHANNEL_ID=$(cast keccak \
  $(cast abi-encode "f(address,address,address)" \
    <PARTICIPANT1> <PARTICIPANT2> $USDC_ADDRESS))

# Make test deposit (10 USDC with 6 decimals)
cast send $USDC_TOKEN_NETWORK \
  "setTotalDeposit(bytes32,address,uint256)" \
  $CHANNEL_ID \
  <PARTICIPANT1> \
  10000000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Verify deposit
cast call $USDC_TOKEN_NETWORK \
  "getChannelDeposit(bytes32,address)" \
  $CHANNEL_ID \
  <PARTICIPANT1> \
  --rpc-url $BASE_SEPOLIA_RPC_URL

# Should return 10000000
```

### Smoke Test 3: Full Lifecycle Test

```bash
# 1. Open channel
# 2. Both participants deposit
# 3. Close channel (with signed balance proof)
# 4. Wait for challenge period
# 5. Settle channel
# 6. Verify final balances

# See test/Integration.t.sol for full lifecycle example
```

### Validation Checklist

- [ ] All contracts deployed successfully
- [ ] All contracts verified on Basescan
- [ ] TokenNetworkRegistry shows correct owner
- [ ] Can open test channel
- [ ] Can make deposits
- [ ] Can close and settle channel
- [ ] Events emitted correctly
- [ ] Gas costs match estimates (±10%)
- [ ] Contract reads/writes work via Basescan UI

## Monitoring Setup

### Tenderly Integration

```bash
# Install Tenderly CLI
brew tap tenderly/tenderly
brew install tenderly

# Login to Tenderly
tenderly login

# Create project
tenderly project create m2m-testnet

# Add contracts to monitoring
tenderly contract verify \
  <REGISTRY_ADDRESS> \
  TokenNetworkRegistry \
  --network base-sepolia

tenderly contract verify \
  $USDC_TOKEN_NETWORK \
  TokenNetwork \
  --network base-sepolia
```

**Configure Alerts:**

- Large deposits (>$100 testnet value)
- Failed transactions
- Pause events
- Emergency recovery events

### The Graph Subgraph (Optional)

Create subgraph for indexing testnet events:

```yaml
# subgraph.yaml
specVersion: 0.0.5
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum
    name: TokenNetwork
    network: base-sepolia
    source:
      address: '<USDC_TOKEN_NETWORK>'
      abi: TokenNetwork
      startBlock: <DEPLOYMENT_BLOCK>
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      entities:
        - Channel
      abis:
        - name: TokenNetwork
          file: ./abis/TokenNetwork.json
      eventHandlers:
        - event: ChannelOpened(bytes32,address,address,uint256)
          handler: handleChannelOpened
```

## Bug Bounty Program Preparation

### Testnet Bug Bounty Setup

**Objective:** Identify vulnerabilities before mainnet deployment

**Scope:**

- All deployed testnet contracts
- Off-chain components (if applicable)
- Documentation and deployment scripts

**Duration:** 4-6 weeks on testnet

**Rewards:** See bug-bounty-program.md for details

**Setup Tasks:**

- [ ] Deploy all contracts to testnet
- [ ] Create bug bounty documentation
- [ ] Set up Immunefi or Code4rena program
- [ ] Fund bounty wallet
- [ ] Announce on social media
- [ ] Monitor submissions

## Documentation Updates

### Update README.md

```markdown
## Testnet Deployment (Base Sepolia)

**Contract Addresses:**

- TokenNetworkRegistry: `<REGISTRY_ADDRESS>`
- USDC TokenNetwork: `<USDC_TOKEN_NETWORK>`
- DAI TokenNetwork: `<DAI_TOKEN_NETWORK>`

**Explorer:**

- [TokenNetworkRegistry on Basescan](https://sepolia.basescan.org/address/<REGISTRY_ADDRESS>)

**Deployment Date:** $(date)
**Audit Report:** [Link to audit report]
```

### Create Deployment Record

```bash
# Save deployment info
cat > deployments/sepolia-deployment.json <<EOF
{
  "network": "base-sepolia",
  "chainId": 84532,
  "deploymentDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$(cast wallet address --private-key $PRIVATE_KEY)",
  "contracts": {
    "TokenNetworkRegistry": {
      "address": "<REGISTRY_ADDRESS>",
      "tx": "<TX_HASH>",
      "block": <BLOCK_NUMBER>
    },
    "USDCTokenNetwork": {
      "address": "$USDC_TOKEN_NETWORK",
      "token": "$USDC_ADDRESS",
      "tx": "<TX_HASH>",
      "block": <BLOCK_NUMBER>
    },
    "DAITokenNetwork": {
      "address": "$DAI_TOKEN_NETWORK",
      "token": "$DAI_ADDRESS",
      "tx": "<TX_HASH>",
      "block": <BLOCK_NUMBER>
    }
  },
  "verification": {
    "basescan": "verified",
    "sourcify": "pending"
  }
}
EOF
```

## Emergency Procedures Testing

### Practice Emergency Pause

```bash
# Test pause functionality
cast send $USDC_TOKEN_NETWORK \
  "pause()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Verify paused
cast call $USDC_TOKEN_NETWORK \
  "paused()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL

# Try to open channel (should fail)
cast send $USDC_TOKEN_NETWORK \
  "openChannel(address,uint256)" \
  <TEST_ADDRESS> \
  3600 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY
# Expected: Transaction reverts with Pausable: paused

# Unpause
cast send $USDC_TOKEN_NETWORK \
  "unpause()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY
```

### Test Emergency Recovery

```bash
# Pause contract
cast send $USDC_TOKEN_NETWORK "pause()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Emergency recover test tokens
cast send $USDC_TOKEN_NETWORK \
  "emergencyTokenRecovery(address,address,uint256)" \
  $USDC_ADDRESS \
  <RECOVERY_ADDRESS> \
  1000000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY

# Verify recovery
cast call $USDC_ADDRESS \
  "balanceOf(address)" \
  <RECOVERY_ADDRESS> \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

## Rollback Plan

### If Testnet Deployment Fails

**Scenario 1: Deployment Transaction Fails**

```bash
# Check error message
cast tx <FAILED_TX_HASH> --rpc-url $BASE_SEPOLIA_RPC_URL

# Common issues:
# - Insufficient gas: Increase gas limit
# - Out of gas: Fund wallet with more ETH
# - Constructor revert: Check constructor arguments

# Retry deployment after fixing issue
```

**Scenario 2: Verification Fails**

```bash
# Manual verification via Basescan UI
# 1. Go to contract address on Basescan
# 2. Click "Verify and Publish"
# 3. Select compiler version: 0.8.20
# 4. Select optimizer: Yes (200 runs)
# 5. Paste flattened source code
# 6. Submit
```

**Scenario 3: Critical Bug Found Post-Deployment**

```bash
# 1. Pause contracts
cast send $USDC_TOKEN_NETWORK "pause()" ...

# 2. Announce issue on communication channels
# 3. Deploy fixed version
# 4. Migrate bug bounty program to new contracts
```

## Success Criteria

**Testnet deployment is successful when:**

1. ✅ All contracts deployed and verified
2. ✅ Smoke tests pass (open, deposit, close, settle)
3. ✅ Gas costs within ±10% of estimates
4. ✅ Monitoring operational (Tenderly alerts)
5. ✅ Emergency procedures tested (pause/unpause)
6. ✅ Documentation updated
7. ✅ Bug bounty program launched
8. ✅ No critical issues in 2 weeks of testing

**Metrics to Track:**

- Total channels opened
- Total value locked (testnet)
- Average gas costs
- Transaction success rate
- Bug bounty submissions
- Community feedback

---

**Document Version:** 1.0
**Last Updated:** 2026-01-05
**Next Update:** After audit completion
**Owner:** M2M Development Team
