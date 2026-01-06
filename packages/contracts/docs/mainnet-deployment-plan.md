# Mainnet Deployment Plan - M2M Payment Channels

**Version:** 1.0
**Last Updated:** 2026-01-05
**Target Network:** Base L2 Mainnet (Chain ID: 8453)
**Deployment Status:** Pre-Deployment Planning

## Overview

This document outlines the comprehensive deployment plan for M2M payment channel smart contracts to Base L2 mainnet. This plan ensures safe, verified, and monitored deployment following successful security audit and testnet validation.

## Pre-Deployment Checklist

**Critical Requirements - ALL must be satisfied before mainnet deployment:**

### Security & Audit

- [ ] ✅ Security audit completed by reputable firm (OpenZeppelin, Trail of Bits, or Consensys Diligence)
- [ ] ✅ All Critical findings resolved with mitigation commits
- [ ] ✅ All High findings resolved with mitigation commits
- [ ] ✅ Medium findings addressed or acknowledged with documented rationale
- [ ] ✅ Final audit sign-off received
- [ ] ✅ Audit report published publicly

### Testing & Validation

- [ ] ✅ All tests passing: `forge test` exits with code 0
- [ ] ✅ Code coverage >95% line coverage: `forge coverage` validates
- [ ] ✅ Gas benchmarks meet adjusted targets (Story 8.6 Task 2)
- [ ] ✅ Fuzz tests passing with 10,000 runs: `forge test --fuzz-runs 10000`
- [ ] ✅ Invariant tests passing with 1000 runs: `forge test --match-test invariant`
- [ ] ✅ Integration tests for multi-channel scenarios passing

### Testnet Validation

- [ ] ✅ Base Sepolia testnet deployment successful
- [ ] ✅ All contracts verified on Sepolia Basescan
- [ ] ✅ Full channel lifecycle executed on testnet (open, deposit, close, settle)
- [ ] ✅ Gas costs on testnet match estimates from Story 8.6
- [ ] ✅ Bug bounty program completed (minimum 4-6 weeks)
- [ ] ✅ All bug bounty findings addressed

### Code & Configuration

- [ ] ✅ Code freeze: No changes after final audit (commit hash locked)
- [ ] ✅ Final commit tagged: `git tag -a v1.0.0-mainnet -m "Mainnet deployment"`
- [ ] ✅ Deployment scripts reviewed and tested on testnet
- [ ] ✅ Environment variables configured (.env.production)
- [ ] ✅ RPC endpoints configured (BASE_MAINNET_RPC_URL)
- [ ] ✅ Etherscan API key configured for verification

### Deployment Infrastructure

- [ ] ✅ Mainnet deployment wallet secured (hardware wallet or multisig recommended)
- [ ] ✅ Deployment wallet funded with sufficient ETH for gas (estimated: 2-5 ETH for safety)
- [ ] ✅ Backup deployment wallet configured (in case of primary wallet issues)
- [ ] ✅ Gnosis Safe multisig setup complete (if using multisig ownership)
- [ ] ✅ Multisig signers confirmed and available for deployment day

### Monitoring & Response

- [ ] ✅ Monitoring infrastructure ready (Tenderly, Alchemy, or equivalent)
- [ ] ✅ Alert rules configured (large deposits, errors, suspicious activity)
- [ ] ✅ Emergency response team identified and briefed
- [ ] ✅ Emergency procedures documented (see emergency-procedures.md)
- [ ] ✅ Communication channels setup (Twitter, Discord, email alerts)

### Documentation

- [ ] ✅ README.md updated with mainnet addresses (placeholder ready)
- [ ] ✅ API documentation complete
- [ ] ✅ User guides published
- [ ] ✅ Deployment announcement drafted
- [ ] ✅ Post-mortem template prepared

## Deployment Timeline

**Total Estimated Time:** 4-6 hours (including validation and monitoring period)

### Phase 1: Preparation (30 minutes)

1. **T-30min:** Final team briefing
2. **T-20min:** Verify all checklist items complete
3. **T-10min:** Confirm deployment wallet balance and access
4. **T-5min:** Announce deployment start on communication channels
5. **T-0:** Begin deployment

### Phase 2: Contract Deployment (1-2 hours)

1. **Deploy TokenNetworkRegistry** (15 minutes)
   - Execute deployment script
   - Wait for transaction confirmation (1-5 minutes)
   - Record contract address and transaction hash
   - Verify source code on Basescan (5-10 minutes)

2. **Deploy Initial TokenNetworks** (45 minutes)
   - Deploy USDC TokenNetwork (15 minutes)
   - Deploy DAI TokenNetwork (15 minutes)
   - Deploy USDT TokenNetwork (15 minutes)
   - Verify all TokenNetwork contracts on Basescan

3. **Transfer Ownership** (30 minutes, if using multisig)
   - Deploy Gnosis Safe multisig (if not already deployed)
   - Transfer TokenNetworkRegistry ownership to multisig
   - Verify multisig control via test transaction
   - Confirm all signers have access

### Phase 3: Verification (1 hour)

1. **Contract Verification** (30 minutes)
   - Verify all contracts on Basescan
   - Confirm source code matches deployment commit
   - Test contract reads via Basescan UI

2. **Smoke Testing** (30 minutes)
   - Open test channel with small amount (0.01 USDC)
   - Make test deposit
   - Close and settle channel
   - Verify all events emitted correctly
   - Verify gas costs match estimates

### Phase 4: Monitoring (3-72 hours)

1. **Initial Monitoring** (3 hours)
   - Monitor all transactions to deployed contracts
   - Check for any unexpected errors
   - Verify monitoring alerts working

2. **Extended Monitoring** (72 hours)
   - Continue monitoring for 3 days before public announcement
   - Track total value locked (TVL)
   - Monitor gas costs on mainnet
   - Verify no anomalies in contract behavior

### Phase 5: Public Announcement (After 72 hours)

1. **Publish Deployment Addresses**
   - Update README.md with mainnet addresses
   - Update documentation site
   - Publish blog post announcement

2. **Community Communication**
   - Twitter announcement
   - Discord announcement
   - Email newsletter to stakeholders

## Mainnet Deployment Steps

### Prerequisites

```bash
# Navigate to contracts directory
cd packages/contracts

# Verify environment variables configured
cat .env.production

# Required environment variables:
# BASE_MAINNET_RPC_URL=https://mainnet.base.org
# PRIVATE_KEY=<deployment_wallet_private_key> (use hardware wallet if possible)
# ETHERSCAN_API_KEY=<basescan_api_key>
```

### Step 1: Deploy TokenNetworkRegistry

```bash
# Dry-run deployment (simulate without broadcasting)
forge script script/Deploy.s.sol:DeployRegistry \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY \
  --verify

# Review simulation output carefully
# If simulation successful, execute deployment:

forge script script/Deploy.s.sol:DeployRegistry \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Expected output:
# TokenNetworkRegistry deployed at: 0x...
# Transaction hash: 0x...

# Record deployment information
echo "TokenNetworkRegistry: <address>" >> deployments/mainnet.txt
echo "TX: <tx_hash>" >> deployments/mainnet.txt
echo "Block: <block_number>" >> deployments/mainnet.txt
echo "Deployer: <deployer_address>" >> deployments/mainnet.txt
```

### Step 2: Deploy TokenNetworks for Major Stablecoins

```bash
# Deploy USDC TokenNetwork
# USDC Base mainnet address: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

forge script script/Deploy.s.sol:DeployTokenNetwork \
  --sig "deployTokenNetwork(address)" \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record USDC TokenNetwork address
echo "USDC TokenNetwork: <address>" >> deployments/mainnet.txt

# Deploy DAI TokenNetwork
# DAI Base mainnet address: 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb

forge script script/Deploy.s.sol:DeployTokenNetwork \
  --sig "deployTokenNetwork(address)" \
  0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Record DAI TokenNetwork address
echo "DAI TokenNetwork: <address>" >> deployments/mainnet.txt

# Deploy USDT TokenNetwork (if needed)
# USDT Base mainnet address: TBD (check Base documentation)
```

### Step 3: Verify All Contracts on Basescan

```bash
# Verify TokenNetworkRegistry
forge verify-contract \
  <REGISTRY_ADDRESS> \
  src/TokenNetworkRegistry.sol:TokenNetworkRegistry \
  --chain-id 8453 \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Verify each TokenNetwork
forge verify-contract \
  <USDC_TOKENNETWORK_ADDRESS> \
  src/TokenNetwork.sol:TokenNetwork \
  --chain-id 8453 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) \
  --etherscan-api-key $ETHERSCAN_API_KEY

# Repeat for DAI and USDT TokenNetworks
```

### Step 4: Transfer Ownership to Multisig (Optional but Recommended)

```bash
# Deploy Gnosis Safe multisig (if not already deployed)
# Use Gnosis Safe UI: https://app.safe.global/

# Once multisig deployed, transfer ownership via cast:
cast send <REGISTRY_ADDRESS> \
  "transferOwnership(address)" \
  <MULTISIG_ADDRESS> \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY

# Verify ownership transferred
cast call <REGISTRY_ADDRESS> \
  "owner()" \
  --rpc-url base_mainnet

# Expected output: <MULTISIG_ADDRESS>
```

### Step 5: Smoke Test Deployment

```bash
# Open test channel (requires tokens)
cast send <USDC_TOKENNETWORK_ADDRESS> \
  "openChannel(address,uint256)" \
  <TEST_PARTICIPANT_ADDRESS> \
  3600 \
  --rpc-url base_mainnet \
  --private-key $PRIVATE_KEY

# Monitor transaction and verify channel opened
# Continue with deposit, close, settle as needed
```

### Step 6: Update Documentation

```bash
# Update README.md with deployment addresses
cat >> README.md <<EOF

## Mainnet Deployment (Base L2)

**Contract Addresses:**
- TokenNetworkRegistry: \`<REGISTRY_ADDRESS>\`
- USDC TokenNetwork: \`<USDC_TOKENNETWORK_ADDRESS>\`
- DAI TokenNetwork: \`<DAI_TOKENNETWORK_ADDRESS>\`

**Block Explorer:**
- [TokenNetworkRegistry on Basescan](https://basescan.org/address/<REGISTRY_ADDRESS>)
- [USDC TokenNetwork on Basescan](https://basescan.org/address/<USDC_TOKENNETWORK_ADDRESS>)

**Deployment Date:** $(date)
**Deployer:** <DEPLOYER_ADDRESS>
**Audit Report:** [Link to published audit report]
EOF

# Commit and push documentation updates
git add README.md deployments/mainnet.txt
git commit -m "docs: Add mainnet deployment addresses"
git push origin main
```

## Upgrade Strategy

### Current Architecture: Non-Upgradeable Contracts

The current TokenNetwork and TokenNetworkRegistry contracts are **non-upgradeable** by design. This provides:

**Advantages:**

- Simpler security model (no proxy vulnerabilities)
- Immutable contract logic (users trust code won't change)
- Lower gas costs (no delegatecall overhead)

**Disadvantages:**

- Bug fixes require new deployment and migration
- Feature additions require new contracts
- No emergency contract logic updates

### Migration Strategy (If Upgrade Needed)

If a critical bug is discovered or new features are required:

**Step 1: Deploy New Contract Version**

```bash
# Deploy new TokenNetworkRegistry v2
forge script script/Deploy.s.sol:DeployRegistryV2 \
  --rpc-url base_mainnet \
  --broadcast \
  --verify
```

**Step 2: Deprecate Old Registry**

```bash
# Announce deprecation (30-90 days notice recommended)
# Post announcement on Twitter, Discord, documentation

# Disable new channel creation (if pause functionality exists)
cast send <OLD_REGISTRY_ADDRESS> "pause()" \
  --rpc-url base_mainnet \
  --private-key $OWNER_KEY
```

**Step 3: Migrate Channels**

- Users must settle existing channels on old contracts
- Users open new channels on new contracts
- Provide migration guide and support

**Step 4: Sunset Old Contracts**

- Allow 6-12 months for migration
- Monitor old contracts for activity
- After migration period, old contracts remain on-chain but deprecated

### Future: Proxy-Based Upgradeability

If upgradeability is required for v2, consider OpenZeppelin's TransparentUpgradeableProxy:

**Implementation:**

```solidity
// ProxyAdmin manages upgrade authority
ProxyAdmin admin = new ProxyAdmin();

// Deploy implementation
TokenNetworkRegistry implementation = new TokenNetworkRegistry();

// Deploy proxy
TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
    address(implementation),
    address(admin),
    "" // initialization data
);

// Users interact with proxy address, not implementation
```

**Security Considerations:**

- Proxy pattern adds complexity and attack surface
- Requires additional security audit
- Upgrade authority should be time-locked multisig
- Storage layout compatibility must be maintained

## Monitoring and Alerting

### Monitoring Infrastructure

**Recommended Tools:**

- **Tenderly:** Real-time transaction monitoring and alerting
- **Alchemy:** RPC provider with built-in monitoring
- **The Graph:** Index contract events for querying
- **Custom Dashboard:** Display TVL, channel count, gas usage

### Critical Metrics to Monitor

**Contract Activity:**

- Total Value Locked (TVL) across all TokenNetworks
- Number of open channels
- Number of channels closed per day
- Number of channels settled per day
- Average channel lifetime
- Failed transactions and error rates

**Financial Metrics:**

- Total deposits per token
- Total withdrawals per token
- Largest deposits (alert if >$100k)
- Unusual withdrawal patterns

**Gas Metrics:**

- Average gas cost per operation
- Gas price spikes (Base L2 gas price)
- Failed transactions due to gas

### Alert Rules

**Critical Alerts (Immediate Response Required):**

- Transaction reverted with unexpected error
- Emergency pause triggered
- Ownership transfer attempted
- Deposit exceeding $500k
- Emergency token recovery called

**High Priority Alerts (Response within 1 hour):**

- Unusual spike in failed transactions (>5% failure rate)
- Gas costs exceed estimates by >50%
- TVL change >20% in 1 hour
- New vulnerability disclosed in dependencies

**Medium Priority Alerts (Response within 24 hours):**

- Daily active channels drops >30%
- Average channel lifetime changes significantly
- Gas costs trending upward over 7 days

### Monitoring Setup

**Tenderly Configuration:**

```javascript
// tenderly.yaml
account_id: "your-account"
project_slug: "m2m-payment-channels"

contracts:
  - address: "<REGISTRY_ADDRESS>"
    network: "base"
    name: "TokenNetworkRegistry"
  - address: "<USDC_TOKENNETWORK_ADDRESS>"
    network: "base"
    name: "USDC_TokenNetwork"

alerts:
  - name: "Large Deposit Alert"
    trigger:
      event: "DepositMade"
      filter: "amount > 100000000000" # >$100k (USDC 6 decimals)
    severity: "high"
    destinations:
      - email: "alerts@m2m.com"
      - slack: "#mainnet-alerts"
```

**The Graph Subgraph:**

```graphql
# schema.graphql
type Channel @entity {
  id: ID!
  participant1: Bytes!
  participant2: Bytes!
  token: Bytes!
  state: ChannelState!
  totalDeposit1: BigInt!
  totalDeposit2: BigInt!
  openedAt: BigInt!
  closedAt: BigInt
  settledAt: BigInt
}

enum ChannelState {
  Opened
  Closed
  Settled
}
```

## Post-Deployment Validation

### Validation Checklist (First 72 Hours)

**Hour 0-3: Critical Monitoring**

- [ ] All deployment transactions confirmed
- [ ] All contracts verified on Basescan
- [ ] Ownership transferred to multisig (if applicable)
- [ ] Monitoring alerts triggered successfully (test alert)
- [ ] No unexpected errors in contract calls

**Hour 3-24: Smoke Testing**

- [ ] Test channel opened with 0.01 USDC
- [ ] Test deposit made
- [ ] Test channel closed successfully
- [ ] Test channel settled successfully
- [ ] All events emitted correctly
- [ ] Gas costs match testnet estimates (±10%)
- [ ] Basescan displays contract data correctly

**Hour 24-72: Extended Monitoring**

- [ ] Zero critical errors
- [ ] TVL tracking correctly
- [ ] No unusual activity patterns
- [ ] All monitoring dashboards operational
- [ ] Team trained on emergency procedures

### Validation Tests

**Test 1: Basic Channel Lifecycle**

```bash
# 1. Open channel
cast send <TOKENNETWORK> "openChannel(address,uint256)" \
  <PARTICIPANT2> 3600 \
  --rpc-url base_mainnet

# 2. Deposit 0.01 USDC (10000 with 6 decimals)
cast send <TOKENNETWORK> "setTotalDeposit(bytes32,address,uint256)" \
  <CHANNEL_ID> <PARTICIPANT1> 10000 \
  --rpc-url base_mainnet

# 3. Close channel (requires signed balance proof)
# 4. Settle channel (after challenge period)
# 5. Verify final balances
```

**Test 2: Gas Cost Validation**

```bash
# Compare actual gas costs to estimates from Story 8.6
forge test --match-test testGas --gas-report

# Validate on mainnet:
# openChannel: ~200k gas (adjusted target)
# setTotalDeposit: ~100k gas (first deposit)
# closeChannel: ~170k gas (adjusted target)
# settleChannel: ~80k gas
```

**Test 3: Event Emission**

```bash
# Query events from The Graph or Tenderly
# Verify all expected events emitted:
# - ChannelOpened
# - DepositMade
# - ChannelClosed
# - ChannelSettled
```

## Rollback Plan

### When to Rollback

**Immediate Rollback Required:**

- Critical vulnerability discovered in deployed contracts
- Funds at risk
- Contract behavior inconsistent with testnet

**Rollback Procedure:**

Since contracts are non-upgradeable, "rollback" means emergency pause and migration:

```bash
# 1. Pause all operations (if critical vulnerability)
cast send <TOKENNETWORK> "pause()" \
  --rpc-url base_mainnet \
  --private-key $OWNER_KEY

# 2. Announce pause on all communication channels
echo "CRITICAL: Contracts paused due to security issue. Details: [link]"

# 3. If funds at risk, enable emergency withdrawal
cast send <TOKENNETWORK> "emergencyTokenRecovery(address,address,uint256)" \
  <TOKEN> <RECIPIENT> <AMOUNT> \
  --rpc-url base_mainnet \
  --private-key $OWNER_KEY

# 4. Deploy fixed contracts
forge script script/Deploy.s.sol:DeployFixed \
  --rpc-url base_mainnet \
  --broadcast \
  --verify

# 5. Migrate users to new contracts
# (Provide detailed migration guide)
```

## Success Criteria

**Deployment is successful when:**

1. ✅ All contracts deployed and verified on Basescan
2. ✅ Ownership transferred to multisig (if applicable)
3. ✅ All validation tests pass
4. ✅ 72-hour monitoring period completes with zero critical issues
5. ✅ Gas costs within ±10% of testnet estimates
6. ✅ Monitoring and alerting operational
7. ✅ Documentation updated with mainnet addresses
8. ✅ Team trained on emergency procedures

**KPIs to Track (First 30 Days):**

- Total Value Locked (TVL): Target $10k-$100k
- Number of channels opened: Target 10-100
- Average channel lifetime: Target 1-7 days
- Transaction success rate: Target >99%
- Gas cost stability: Within ±20% of estimates
- Zero critical security incidents

## Appendix

### Contact Information

**Emergency Response Team:**

- Primary: [Name, Phone, Email]
- Secondary: [Name, Phone, Email]
- Security Advisor: [Audit Firm Contact]

**Multisig Signers:**

- Signer 1: [Name, Address]
- Signer 2: [Name, Address]
- Signer 3: [Name, Address]

### Reference Documentation

- Security Audit Report: [Link]
- Testnet Deployment: [Link to testnet-deployment.md]
- Emergency Procedures: [Link to emergency-procedures.md]
- Gas Report: [Link to gas-report.md]
- Architecture Documentation: [Link to docs/architecture/]

### Deployment Commit Hash

```
Mainnet Deployment Commit: [To be filled]
Git Tag: v1.0.0-mainnet
```

---

**Document Status:** Draft - To be finalized before mainnet deployment
**Next Review:** Before testnet deployment completion
**Owner:** M2M Development Team
