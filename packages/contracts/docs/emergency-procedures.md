# Emergency Procedures - M2M Payment Channels

**Version:** 1.0
**Last Updated:** 2026-01-05
**Network:** Base L2 Mainnet
**Status:** Active

## Overview

This document provides step-by-step emergency procedures for responding to security incidents, contract vulnerabilities, and operational issues with M2M payment channel smart contracts on Base L2 mainnet.

**⚠️ CRITICAL: This document should be accessible offline and printed for emergency reference.**

## Emergency Contact List

### Primary Response Team

| Role                   | Name   | Phone   | Email   | Timezone |
| ---------------------- | ------ | ------- | ------- | -------- |
| **Primary Contact**    | [Name] | [Phone] | [Email] | [TZ]     |
| **Secondary Contact**  | [Name] | [Phone] | [Email] | [TZ]     |
| **Security Lead**      | [Name] | [Phone] | [Email] | [TZ]     |
| **Smart Contract Dev** | [Name] | [Phone] | [Email] | [TZ]     |

### External Contacts

| Entity               | Contact     | Phone     | Email   | Purpose                |
| -------------------- | ----------- | --------- | ------- | ---------------------- |
| **Audit Firm**       | [Firm Name] | [Phone]   | [Email] | Security consultation  |
| **Base L2 Team**     | [Contact]   | [Discord] | [Email] | Network issues         |
| **Multisig Signers** | [See below] | -         | -       | Emergency transactions |

### Multisig Signers (If Using Multisig Ownership)

| Signer   | Address | Phone   | Email   | Backup Wallet Access |
| -------- | ------- | ------- | ------- | -------------------- |
| Signer 1 | 0x...   | [Phone] | [Email] | [Location]           |
| Signer 2 | 0x...   | [Phone] | [Email] | [Location]           |
| Signer 3 | 0x...   | [Phone] | [Email] | [Location]           |

**Multisig Threshold:** 2 of 3 signatures required

## Severity Levels

### Critical (P0) - Immediate Response Required

- Funds at risk or actively being drained
- Exploit being actively executed
- Contract behavior completely broken
- **Response Time:** Within 15 minutes
- **Escalation:** Activate all team members immediately

### High (P1) - Urgent Response Required

- Significant vulnerability discovered (not yet exploited)
- Major functionality broken affecting users
- Unusual activity patterns indicating potential exploit
- **Response Time:** Within 1 hour
- **Escalation:** Activate primary and secondary contacts

### Medium (P2) - Prompt Response Required

- Minor vulnerability discovered
- Functionality degraded but operational
- User reports of issues
- **Response Time:** Within 4 hours
- **Escalation:** Primary contact investigates

### Low (P3) - Standard Response

- Documentation issues
- Non-critical bugs
- Feature requests
- **Response Time:** Within 24 hours
- **Escalation:** Standard ticket workflow

## Circuit Breaker: Emergency Pause

### When to Pause

**Immediately pause ALL operations if:**

- Critical vulnerability discovered (funds at risk)
- Active exploit detected
- Contract behavior deviates from expected (settlement inconsistencies)
- Base L2 network compromise

**DO NOT pause for:**

- Minor bugs not affecting funds
- Gas price spikes
- Single user reporting issues (investigate first)

### How to Pause (Owner-Only Function)

**Prerequisites:**

- Owner private key or multisig access
- RPC endpoint access (BASE_MAINNET_RPC_URL)
- Sufficient ETH for gas in owner wallet

**Using cast (Command Line):**

```bash
# Pause TokenNetwork contract
cast send <TOKENNETWORK_ADDRESS> \
  "pause()" \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY

# Verify pause activated
cast call <TOKENNETWORK_ADDRESS> \
  "paused()" \
  --rpc-url https://mainnet.base.org

# Expected output: true (0x0000...0001)
```

**Using Multisig (Gnosis Safe):**

1. Navigate to Gnosis Safe UI: https://app.safe.global/
2. Select Base network
3. Connect multisig wallet
4. Go to "New Transaction" → "Contract Interaction"
5. Enter TokenNetwork address: `<TOKENNETWORK_ADDRESS>`
6. Select function: `pause()`
7. Review transaction details
8. Submit and gather required signatures (2 of 3)
9. Execute transaction once threshold reached

**Using Etherscan:**

1. Navigate to contract on Basescan: https://basescan.org/address/<TOKENNETWORK_ADDRESS>
2. Go to "Write Contract" tab
3. Click "Connect to Web3" (MetaMask or WalletConnect)
4. Find `pause()` function
5. Click "Write" button
6. Confirm transaction in wallet
7. Wait for confirmation

**Verification:**

```bash
# Check paused status
cast call <TOKENNETWORK_ADDRESS> \
  "paused()" \
  --rpc-url https://mainnet.base.org

# Monitor for new transactions (should all revert)
# Check Tenderly or Basescan for activity
```

### Communication After Pause

**Immediate Actions (Within 5 minutes):**

1. **Twitter Announcement:**

```
🚨 CRITICAL UPDATE: M2M Payment Channels have been paused as a precautionary measure.
All funds are safe. Investigation underway.
More details: [link to status page]
#M2M #DeFi #Security
```

2. **Discord Announcement:**

```
@everyone 🚨 EMERGENCY NOTICE 🚨

The M2M payment channel contracts have been PAUSED.

Status: Under Investigation
Funds: SAFE
Actions Required: NONE at this time

We will provide updates every 30 minutes.

Details: [link]
```

3. **Email to Stakeholders:**

```
Subject: CRITICAL: M2M Contracts Paused

Dear Stakeholders,

The M2M payment channel smart contracts have been paused as a precautionary
measure in response to [brief description].

Current Status:
- All contracts paused
- All funds secured
- Investigation underway
- Expected resolution: [timeframe]

We will provide hourly updates.

Best regards,
M2M Team
```

4. **Update Status Page:**

- Set status to "Major Outage"
- Post incident timeline
- Update every 30 minutes

## Emergency Token Recovery

**⚠️ CRITICAL: Only use this function when contracts are paused and funds need immediate recovery.**

### When to Use Emergency Recovery

**ONLY use emergencyTokenRecovery in these scenarios:**

- Critical vulnerability allows unauthorized fund withdrawal
- Contract logic bug prevents normal settlement
- Funds locked due to unforeseen edge case
- Court order or regulatory requirement

**DO NOT use for:**

- Normal user withdrawals
- Dispute resolution (use normal settlement)
- Gas optimization

### Emergency Recovery Procedure

**Step 1: Verify Pause Active**

```bash
# Ensure contracts are paused
cast call <TOKENNETWORK_ADDRESS> "paused()" --rpc-url https://mainnet.base.org

# If not paused, PAUSE FIRST (see above)
```

**Step 2: Calculate Recovery Amount**

```bash
# Check contract token balance
cast call <TOKEN_ADDRESS> \
  "balanceOf(address)" \
  <TOKENNETWORK_ADDRESS> \
  --rpc-url https://mainnet.base.org

# Example output: 1000000000 (1000 USDC with 6 decimals)

# Verify channel deposits match expected amounts
# Query individual channel data before recovery
```

**Step 3: Execute Emergency Recovery**

```bash
# Execute emergency token recovery
cast send <TOKENNETWORK_ADDRESS> \
  "emergencyTokenRecovery(address,address,uint256)" \
  <TOKEN_ADDRESS> \
  <RECIPIENT_ADDRESS> \
  <AMOUNT> \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY

# Example: Recover 1000 USDC to safe address
cast send 0x... \
  "emergencyTokenRecovery(address,address,uint256)" \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  0xSAFE_ADDRESS \
  1000000000 \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY
```

**Step 4: Verify Recovery**

```bash
# Verify tokens received by recipient
cast call <TOKEN_ADDRESS> \
  "balanceOf(address)" \
  <RECIPIENT_ADDRESS> \
  --rpc-url https://mainnet.base.org

# Verify contract balance reduced
cast call <TOKEN_ADDRESS> \
  "balanceOf(address)" \
  <TOKENNETWORK_ADDRESS> \
  --rpc-url https://mainnet.base.org
```

**Step 5: Document Recovery**

```bash
# Record recovery details
cat >> incident-log.md <<EOF
## Emergency Recovery - $(date)

**Incident:** [Description]
**Recovered Token:** <TOKEN_ADDRESS>
**Amount:** <AMOUNT>
**Recipient:** <RECIPIENT_ADDRESS>
**Transaction:** <TX_HASH>
**Authorized By:** [Names of multisig signers]
**Reason:** [Detailed justification]

EOF
```

### Post-Recovery Actions

1. **Distribute funds to affected users** (if applicable)
2. **Publish incident report** with full transparency
3. **Update contracts** if vulnerability discovered
4. **Compensate affected users** (if loss occurred)

## Incident Response Plan

### 8-Step Incident Response Process

#### Step 1: Detect Issue (0-5 minutes)

**Detection Methods:**

- Monitoring alert triggered (Tenderly, custom monitoring)
- Bug bounty submission
- Community report (Twitter, Discord)
- Failed transaction investigation
- Unusual activity patterns

**Initial Assessment:**

```bash
# Quick health check
cast call <TOKENNETWORK_ADDRESS> "paused()" --rpc-url https://mainnet.base.org
cast call <TOKEN_ADDRESS> "balanceOf(address)" <TOKENNETWORK_ADDRESS> --rpc-url https://mainnet.base.org

# Check recent transactions
# Basescan: https://basescan.org/address/<TOKENNETWORK_ADDRESS>
# Tenderly: [Your Tenderly dashboard]
```

**Severity Assessment Questions:**

- Are funds at risk? (Yes = P0, No = P1+)
- Is exploit active? (Yes = P0)
- Are users affected? (How many?)
- Can users still access funds? (No = P0/P1)

#### Step 2: Assess Severity (5-10 minutes)

**Critical (P0) Checklist:**

- [ ] Funds actively being drained
- [ ] Exploit being executed
- [ ] Contract balance decreasing unexpectedly
- [ ] Settlement logic broken (incorrect distribution)
- [ ] Signature verification bypass

**High (P1) Checklist:**

- [ ] Vulnerability confirmed but not exploited
- [ ] Major functionality broken
- [ ] Multiple users affected
- [ ] Potential for exploit exists

**Action Based on Severity:**

- P0: PAUSE IMMEDIATELY → Proceed to Step 3
- P1: Investigate urgently → Gather more data → Pause if confirmed
- P2/P3: Standard investigation process

#### Step 3: Activate Circuit Breaker (10-15 minutes, if P0/P1)

**Execute Pause (see "Circuit Breaker" section above)**

```bash
# Pause contract
cast send <TOKENNETWORK_ADDRESS> "pause()" \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY

# Communicate immediately
# - Twitter, Discord, Email (see templates above)
```

#### Step 4: Investigate Root Cause (15-60 minutes)

**Investigation Checklist:**

- [ ] Review recent transactions on Basescan
- [ ] Analyze failed transactions for error messages
- [ ] Check contract state (balances, deposits, channel states)
- [ ] Review code for potential vulnerability
- [ ] Consult with audit firm if needed
- [ ] Reproduce issue in local environment

**Investigation Tools:**

```bash
# Review recent events
cast logs \
  --from-block <START_BLOCK> \
  --to-block latest \
  --address <TOKENNETWORK_ADDRESS> \
  --rpc-url https://mainnet.base.org

# Decode specific transaction
cast run <TX_HASH> --rpc-url https://mainnet.base.org

# Trace transaction execution
# Use Tenderly transaction simulator
```

**Document Findings:**

```markdown
## Root Cause Analysis

**Issue:** [Brief description]
**Discovered:** [Timestamp]
**Affected Contracts:** [Addresses]
**Affected Users:** [Count, addresses if known]
**Root Cause:** [Technical explanation]
**Attack Vector:** [How exploit works]
**Funds at Risk:** [Amount]
```

#### Step 5: Develop and Test Fix (1-4 hours)

**Fix Development Process:**

1. **Code Fix**

```solidity
// Example: Fix vulnerability in settlement logic
// OLD CODE (vulnerable):
function settleChannel(bytes32 channelId) external {
    // Missing withdrawal accounting
    finalBalance = deposit - transferredAmount;
}

// NEW CODE (fixed):
function settleChannel(bytes32 channelId) external {
    // Correctly account for withdrawals
    finalBalance = deposit - transferredAmount - withdrawnAmount;
}
```

2. **Test Fix Locally**

```bash
# Write regression test
forge test --match-test testVulnerabilityFixed -vvv

# Run full test suite
forge test

# Verify coverage maintained
forge coverage
```

3. **Deploy to Testnet (Base Sepolia)**

```bash
# Deploy fixed contract to testnet
forge script script/Deploy.s.sol:DeployFixed \
  --rpc-url base_sepolia \
  --broadcast \
  --verify

# Test fix on testnet with real scenario
```

4. **Peer Review**

- Code review by 2+ developers
- Security review by audit firm (if time permits)
- Multisig signer approval

#### Step 6: Deploy Fix or Migration (2-4 hours)

**Option A: Deploy New Contracts (Recommended for Non-Upgradeable)**

```bash
# 1. Deploy new fixed contracts
forge script script/Deploy.s.sol:DeployFixed \
  --rpc-url https://mainnet.base.org \
  --broadcast \
  --verify

# 2. Announce new contract addresses
# 3. Provide migration guide to users
# 4. Keep old contracts paused
```

**Option B: Unpause After Mitigation**

```bash
# If fix doesn't require new deployment (e.g., external mitigation)
cast send <TOKENNETWORK_ADDRESS> "unpause()" \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY
```

**Migration Guide Template:**

```markdown
# Migration Guide: Move to Fixed Contracts

## Timeline

- New contracts deployed: [Date/Time]
- Old contracts paused: [Date/Time]
- Migration deadline: [Date/Time + 90 days]

## Steps for Users

### 1. Settle Existing Channels (Old Contract)

Emergency settlement is enabled on old contracts.
Call `settleChannel(channelId)` to recover funds.

### 2. Withdraw Funds

Funds will be returned to your address automatically.

### 3. Open New Channels (New Contract)

Use new contract address: 0x...
Full functionality available.

## Contract Addresses

**OLD (Paused):**

- TokenNetworkRegistry: 0x...
- USDC TokenNetwork: 0x...

**NEW (Active):**

- TokenNetworkRegistry: 0x...
- USDC TokenNetwork: 0x...
```

#### Step 7: Resume Operations (4-6 hours from incident start)

**Pre-Resume Checklist:**

- [ ] Root cause identified and fixed
- [ ] Fix tested on testnet
- [ ] Peer review completed
- [ ] Monitoring alerts updated
- [ ] Communication prepared

**Resume Procedure:**

```bash
# Unpause contracts (if keeping same contracts)
cast send <TOKENNETWORK_ADDRESS> "unpause()" \
  --rpc-url https://mainnet.base.org \
  --private-key $OWNER_PRIVATE_KEY

# Monitor closely for 1 hour
# Watch for:
# - Transaction success rate
# - Gas costs
# - Event emissions
# - User activity
```

**Communication:**

```
✅ RESOLVED: M2M Payment Channels Restored

Incident timeline:
- Detected: [Time]
- Paused: [Time]
- Fixed: [Time]
- Resumed: [Time]

Root cause: [Brief explanation]
Impact: [Number of users, amount]
Compensation: [If applicable]

Full incident report: [Link]

Thank you for your patience.
```

#### Step 8: Post-Mortem and Disclosure (24-48 hours after resolution)

**Post-Mortem Report Structure:**

```markdown
# Incident Post-Mortem: [Brief Title]

**Date:** [Incident Date]
**Duration:** [Total downtime]
**Severity:** [P0/P1/P2/P3]
**Impact:** [Users affected, funds affected]

## Executive Summary

[2-3 sentence summary of what happened]

## Timeline

- **[Time]:** Issue detected via [detection method]
- **[Time]:** Severity assessed as [level]
- **[Time]:** Contracts paused
- **[Time]:** Root cause identified
- **[Time]:** Fix developed and tested
- **[Time]:** Fix deployed
- **[Time]:** Contracts resumed
- **[Time]:** All users migrated/recovered

## Root Cause

[Detailed technical explanation]

## Impact Assessment

- Users affected: [Number]
- Funds at risk: [Amount]
- Actual funds lost: [Amount]
- Downtime: [Duration]

## Resolution

[What was done to fix]

## Lessons Learned

### What Went Well

- [Positive aspect 1]
- [Positive aspect 2]

### What Needs Improvement

- [Improvement area 1]
- [Improvement area 2]

## Action Items

- [ ] [Specific action to prevent recurrence]
- [ ] [Process improvement]
- [ ] [Monitoring enhancement]

## Compensation Plan

[If applicable]

---

Published: [Date]
Authors: [Names]
```

**Disclosure:**

- Publish post-mortem on website/blog
- Share on Twitter, Discord
- Email stakeholders
- Update documentation
- Share learnings with community

## Emergency Scenarios and Playbooks

### Scenario 1: Reentrancy Attack

**Symptoms:**

- Contract balance decreasing rapidly
- Same user calling settle/withdraw repeatedly
- Gas costs very high

**Response:**

```bash
# 1. PAUSE IMMEDIATELY
cast send <TOKENNETWORK_ADDRESS> "pause()" --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY

# 2. Identify attacker address
# Check recent transactions on Basescan

# 3. Calculate funds drained
# Compare contract balance before/after attack

# 4. Deploy fixed contract with reentrancy guard
# (All functions already have nonReentrant modifier - verify)

# 5. Investigate how reentrancy guard was bypassed
```

### Scenario 2: Signature Verification Bypass

**Symptoms:**

- Channels settling with incorrect balance proofs
- Unauthorized withdrawals
- Signature verification not reverting

**Response:**

```bash
# 1. PAUSE IMMEDIATELY
cast send <TOKENNETWORK_ADDRESS> "pause()" --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY

# 2. Review signature verification logic
# Check EIP-712 domain separator
# Check ECDSA recovery

# 3. Verify no malformed signatures accepted
# Test with known invalid signatures

# 4. Deploy fix
# 5. Audit signature logic with external firm
```

### Scenario 3: Integer Overflow/Underflow

**Symptoms:**

- Balances showing incorrect amounts
- Very large or very small numbers
- Settlement distributing wrong amounts

**Response:**

```bash
# 1. PAUSE IMMEDIATELY
cast send <TOKENNETWORK_ADDRESS> "pause()" --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY

# 2. Identify overflow scenario
# Solidity 0.8+ has built-in overflow protection
# Check for unchecked blocks

# 3. Review arithmetic operations
# Verify all calculations safe

# 4. Add explicit overflow checks if needed
# 5. Test with maximum values
```

### Scenario 4: Base L2 Network Issues

**Symptoms:**

- Transactions not confirming
- RPC endpoint errors
- Gas price extremely high

**Response:**

```bash
# 1. DO NOT PAUSE (this is network issue, not contract)

# 2. Monitor Base L2 status
# https://status.base.org/
# Twitter: @BuildOnBase

# 3. Switch RPC endpoints
# Primary: https://mainnet.base.org
# Backup: https://base-mainnet.g.alchemy.com/v2/YOUR-API-KEY

# 4. Communicate to users
# "Base L2 experiencing network issues. Contracts are safe. Wait for network recovery."

# 5. Wait for network stabilization
```

### Scenario 5: Governance Attack (Multisig Compromise)

**Symptoms:**

- Unexpected ownership transfer transaction
- Unauthorized pause/unpause
- Unauthorized setMaxDeposit call

**Response:**

```bash
# 1. EMERGENCY: Contact ALL multisig signers immediately
# Verify if transaction was legitimate

# 2. If compromise confirmed, PAUSE contracts with remaining control
# (if attacker hasn't paused)

# 3. Transfer ownership to new multisig ASAP
# Deploy new multisig with secure signers

# 4. Rotate all compromised keys

# 5. Investigate compromise vector
# - Phishing?
# - Malware?
# - Social engineering?

# 6. Enable additional security
# - Timelock on ownership changes
# - Multi-sig threshold increase (3 of 5 instead of 2 of 3)
```

## Monitoring and Detection

### Real-Time Monitoring Dashboards

**Primary Dashboard (Tenderly):**

- URL: [Your Tenderly dashboard URL]
- Metrics: TVL, transactions/hour, error rate, gas costs
- Alerts: Email + Slack

**Backup Dashboard (Alchemy):**

- URL: [Your Alchemy dashboard URL]
- Metrics: RPC calls, response times, error rate

**Custom Dashboard (The Graph):**

- URL: [Your The Graph subgraph URL]
- Metrics: Channels opened/closed, settlements, deposits

### Alert Configuration

**Critical Alerts (P0):**

- Email: alerts@m2m.com
- Slack: #critical-alerts
- SMS: [Phone numbers]
- PagerDuty: [If configured]

**Test Alerts (Monthly):**

```bash
# Trigger test alert to verify alerting works
# Tenderly: Manual test alert
# PagerDuty: Test notification
```

## Testing Emergency Procedures

### Quarterly Emergency Drill

**Schedule:** First Monday of each quarter
**Duration:** 2 hours
**Participants:** Full emergency response team

**Drill Scenario:**

1. Simulate vulnerability discovery
2. Practice pause procedure
3. Practice emergency recovery
4. Practice communication
5. Review post-mortem process

**Drill Checklist:**

- [ ] All team members reached within 15 minutes
- [ ] Pause executed successfully on testnet
- [ ] Emergency recovery tested on testnet
- [ ] Communication templates used
- [ ] Post-drill retrospective completed

### Annual Audit of Emergency Procedures

**Review:**

- Contact list current?
- Multisig signers still available?
- Private keys accessible?
- RPC endpoints working?
- Monitoring alerts functioning?
- Documentation up to date?

## Appendix

### Quick Reference Commands

**Check Contract Status:**

```bash
cast call <TOKENNETWORK_ADDRESS> "paused()" --rpc-url https://mainnet.base.org
```

**Pause Contract:**

```bash
cast send <TOKENNETWORK_ADDRESS> "pause()" --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY
```

**Unpause Contract:**

```bash
cast send <TOKENNETWORK_ADDRESS> "unpause()" --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY
```

**Emergency Recovery:**

```bash
cast send <TOKENNETWORK_ADDRESS> "emergencyTokenRecovery(address,address,uint256)" <TOKEN> <RECIPIENT> <AMOUNT> --rpc-url https://mainnet.base.org --private-key $OWNER_PRIVATE_KEY
```

**Check Token Balance:**

```bash
cast call <TOKEN_ADDRESS> "balanceOf(address)" <TOKENNETWORK_ADDRESS> --rpc-url https://mainnet.base.org
```

### Contract Addresses (To be filled after deployment)

```
TokenNetworkRegistry: 0x...
USDC TokenNetwork: 0x...
DAI TokenNetwork: 0x...
USDT TokenNetwork: 0x...

Multisig Address: 0x...
Emergency Safe Address: 0x...
```

### RPC Endpoints

```
Primary: https://mainnet.base.org
Backup 1: https://base-mainnet.g.alchemy.com/v2/YOUR-API-KEY
Backup 2: https://base.gateway.tenderly.co
```

---

**Document Status:** Active
**Last Reviewed:** 2026-01-05
**Next Review:** Before mainnet deployment
**Owner:** M2M Security Team

**🚨 Keep this document accessible offline in case of emergency! 🚨**
