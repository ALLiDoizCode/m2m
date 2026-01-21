# Production XRP Deployment Checklist

This checklist ensures secure and reliable XRP payment channel deployment in production environments.

## Table of Contents

1. [Pre-Flight Validation](#pre-flight-validation)
2. [Security Checklist](#security-checklist)
3. [Network Configuration](#network-configuration)
4. [Monitoring and Alerting](#monitoring-and-alerting)
5. [Backup and Recovery](#backup-and-recovery)
6. [Performance Tuning](#performance-tuning)
7. [Post-Deployment Verification](#post-deployment-verification)

## Pre-Flight Validation

### XRP Account Preparation

- [ ] **Account Creation**: Create dedicated XRP Ledger account for production
  - Mainnet: Use secure wallet generation (offline preferred)
  - Minimum reserve: 10 XRP (base reserve) + 2 XRP per payment channel
  - Generate account using: `xrpl.Wallet.generate()` or hardware wallet

- [ ] **Account Funding**: Fund account with sufficient XRP
  - Calculate required XRP: (base reserve) + (channels × 2 XRP) + (operational balance)
  - Example: 5 peers = 10 XRP (base) + 10 XRP (channels) + 50 XRP (operational) = 70 XRP
  - Verify balance before proceeding: Minimum 50 XRP recommended for production

- [ ] **Account Verification**: Verify account exists on ledger
  ```bash
  # Check account balance
  curl -X POST https://xrplcluster.com:51234 \
    -H 'Content-Type: application/json' \
    -d '{"method": "account_info", "params": [{"account": "rYourAccountAddress"}]}'
  ```

### Network Connectivity

- [ ] **XRPL Mainnet Connectivity**: Test connection to mainnet
  - Primary: `wss://xrplcluster.com`
  - Fallback: `wss://s1.ripple.com`, `wss://s2.ripple.com`
  - Test connection: `await xrplClient.connect()`
  - Verify latency: < 500ms for WebSocket ping/pong

- [ ] **Firewall Configuration**: Open required ports
  - Outbound: 443 (HTTPS), 51233-51235 (XRPL WebSocket)
  - Allow WebSocket connections to XRPL cluster nodes

### Environment Variables

- [ ] **Secrets Configuration**: All secrets stored securely
  - `XRPL_ACCOUNT_SECRET`: Never hardcoded, use secrets management
  - `XRPL_CLAIM_SIGNER_SEED`: Separate from account secret
  - Verify `.env` files excluded from git: Check `.gitignore` includes `.env*`

- [ ] **Environment Variable Validation**: Verify all required variables set

  ```bash
  # Required variables
  XRPL_WSS_URL=wss://xrplcluster.com
  XRPL_ACCOUNT_SECRET=sEdV...  # From secrets manager
  XRPL_ACCOUNT_ADDRESS=rN7n7o... # Matches funded account
  XRPL_CLAIM_SIGNER_SEED=sEdTM1... # Separate ed25519 keypair
  ```

- [ ] **Configuration Validation**: Run configuration validator
  ```bash
  # Validate configuration before deployment
  npm run validate:config
  ```

## Security Checklist

### Secret Management

- [ ] **Account Secret Security**
  - [ ] Stored in secrets management service (AWS Secrets Manager, HashiCorp Vault)
  - [ ] Never logged or exposed in error messages
  - [ ] Separate secrets for dev/test/production environments
  - [ ] Access restricted to authorized personnel only
  - [ ] Rotation schedule documented (every 90 days recommended)

- [ ] **Claim Signer Key Separation**
  - [ ] Separate ed25519 keypair for claim signing (not account keypair)
  - [ ] Claim signer seed backed up securely
  - [ ] Key recovery procedure documented
  - [ ] Test key recovery process in staging environment

- [ ] **Backup Encryption**
  - [ ] All backups encrypted at rest
  - [ ] Encryption keys stored separately from backups
  - [ ] Backup access audit trail enabled

### Channel Configuration Security

- [ ] **Settlement Delay Configuration**
  - [ ] Minimum 1 hour settle delay enforced (3600 seconds)
  - [ ] Production recommendation: 24 hours (86400 seconds)
  - [ ] Prevents instant-close griefing attacks
  - [ ] Documented in peer configuration files

- [ ] **Channel Amount Limits**
  - [ ] Maximum channel amount per peer defined
  - [ ] Example: `maxChannelAmount: '10000000000'` (10,000 XRP)
  - [ ] Total exposure across all channels < 80% of account balance
  - [ ] Prevents excessive capital lockup

- [ ] **Idle Channel Threshold**
  - [ ] Configured to close idle channels automatically
  - [ ] Production recommendation: 7 days (604800 seconds)
  - [ ] Prevents zombie channels consuming reserves

- [ ] **Channel Expiration (CancelAfter)**
  - [ ] All channels have CancelAfter timestamp
  - [ ] Production recommendation: 30 days (2592000 seconds)
  - [ ] Automatic closure 1 hour before expiration
  - [ ] Prevents permanent channel lockup

### Network Security

- [ ] **TLS Certificate Validation**: Enabled for XRPL connections
  - Verify certificate chain for `wss://` connections
  - Reject self-signed certificates

- [ ] **Connection Timeout**: Configured appropriately
  - Connection timeout: 10 seconds
  - Auto-reconnect enabled with exponential backoff
  - Maximum reconnect attempts: 5

- [ ] **Rate Limiting**: Implement request rate limits
  - Maximum 10 transactions per second
  - Prevents account from being flagged for spam

## Network Configuration

### Peer Configuration

- [ ] **Peer Settlement Preferences**: All peers configured correctly

  ```yaml
  peers:
    - id: peer-production
      settlementPreference: xrp
      xrpAddress: rPeerXRPAddress...
      settlementThreshold: 1000000000 # 1000 XRP in drops
      settlementInterval: 3600000 # 1 hour
  ```

- [ ] **Dual-Settlement Support**: Configured for production
  - Default preference: `'both'` (fallback to EVM if XRP unavailable)
  - Token preference order: `['XRP', 'USDC', 'DAI']`

- [ ] **Settlement Thresholds**: Set appropriately for production
  - Minimum threshold: 100 XRP (100000000 drops)
  - Maximum threshold: 10,000 XRP (10000000000 drops)
  - Avoid micro-settlements (high fee-to-value ratio)

### XRP Channel Lifecycle Configuration

- [ ] **Lifecycle Manager Enabled**: Production configuration applied

  ```typescript
  {
    enabled: true,
    initialChannelAmount: '10000000000',    // 10,000 XRP
    defaultSettleDelay: 86400,              // 24 hours
    idleChannelThreshold: 604800,           // 7 days
    minBalanceThreshold: 0.3,               // Fund when < 30% remaining
    cancelAfter: 2592000,                   // 30 days expiration
  }
  ```

- [ ] **Funding Strategy**: Automatic funding configured
  - Funding amount: 50% of initial channel amount
  - Trigger threshold: < 30% remaining balance
  - Maximum funding attempts: 3 per channel per day

## Monitoring and Alerting

### XRP Account Monitoring

- [ ] **Balance Monitoring**: Alert when balance falls below threshold
  - Critical threshold: < 20 XRP (insufficient for operations)
  - Warning threshold: < 50 XRP (low balance)
  - Alert channel: PagerDuty, Slack, email

- [ ] **Reserve Monitoring**: Track account reserve requirements
  - Formula: 10 XRP (base) + 2 XRP × (number of open channels)
  - Alert when available balance < 2× reserve (safety margin)

### Channel State Monitoring

- [ ] **Active Channels Count**: Monitor number of open channels
  - Alert when > 80% of planned capacity
  - Example: Planned for 10 channels, alert at 8

- [ ] **Channel Health Checks**: Periodic validation
  - Verify all channels have valid states (not stuck in "closing")
  - Check for channels approaching expiration (< 24 hours to CancelAfter)
  - Alert on channels with abnormal activity patterns

### Settlement Monitoring

- [ ] **Settlement Failure Alerts**: Alert on settlement failures
  - Track failed claim submissions
  - Monitor invalid signature errors
  - Alert on consecutive failures (> 3)

- [ ] **Claim Verification Alerts**: Monitor claim verification failures
  - Track signature verification errors
  - Alert on tampered claims or replay attacks

### Performance Monitoring

- [ ] **Transaction Latency**: Monitor XRP Ledger transaction times
  - Target: < 10 seconds for channel creation
  - Target: < 5 seconds for claim submission
  - Alert when > 2× target

- [ ] **Claim Signing Performance**: Monitor off-chain signing speed
  - Target: < 10ms for claim signing
  - Target: < 5ms for claim verification
  - Alert when > 100ms

## Backup and Recovery

### Account Secret Backup

- [ ] **Primary Backup**: Secure storage of account secret
  - Location: Encrypted secrets vault (AWS Secrets Manager, Vault)
  - Encryption: AES-256 or equivalent
  - Access: Restricted to authorized personnel only

- [ ] **Secondary Backup**: Offline backup for disaster recovery
  - Location: Physically secure location (safe, safety deposit box)
  - Format: Paper wallet or encrypted USB drive
  - Test recovery process annually

### Claim Signer Seed Backup

- [ ] **Primary Backup**: Claim signer seed in secrets vault
  - Separate from account secret storage
  - Rotation schedule: Every 90 days

- [ ] **Secondary Backup**: Offline backup
  - Test key recovery: Verify signatures match after restoration

### Channel State Database Backup

- [ ] **Database Backup Schedule**: Regular backups configured
  - Frequency: Every 6 hours
  - Retention: 30 days
  - Location: Separate from primary database

- [ ] **Backup Restoration Testing**: Verify backup integrity
  - Test restoration in staging environment monthly
  - Document restoration procedure (RTO < 1 hour)

### Disaster Recovery Plan

- [ ] **Recovery Procedures Documented**: Complete DR runbook
  - Account recovery steps
  - Channel state recovery steps
  - Peer reconfiguration procedures

- [ ] **Failover Testing**: Simulate production failure
  - Test failover to standby environment
  - Verify all channels remain operational
  - Document failover time (RTO target: < 30 minutes)

## Performance Tuning

### Connection Pooling

- [ ] **WebSocket Connection Pool**: Configure for optimal performance
  - Pool size: 5 connections to XRPL
  - Connection reuse: Enabled
  - Idle timeout: 60 seconds

### Channel State Caching

- [ ] **SDK Auto-Refresh**: Configure cache refresh interval
  - Refresh interval: 30 seconds (default)
  - Cache size: Limited to active channels only
  - TTL: 5 minutes

### Transaction Batching

- [ ] **Claim Batching**: Group claims when possible
  - Batch window: 5 seconds
  - Maximum batch size: 10 claims
  - Reduces on-ledger transactions

## Post-Deployment Verification

### Smoke Tests

- [ ] **Account Connectivity Test**: Verify XRPL connection

  ```typescript
  await xrplClient.connect();
  const accountInfo = await xrplClient.getAccountInfo(accountAddress);
  console.log('Balance:', accountInfo.balance);
  ```

- [ ] **Channel Creation Test**: Create test channel

  ```typescript
  const channelId = await sdk.openChannel(
    testPeerAddress,
    '1000000000', // 1000 XRP test amount
    86400 // 24 hour settle delay
  );
  console.log('Test channel created:', channelId);
  ```

- [ ] **Claim Signing Test**: Sign and verify test claim

  ```typescript
  const claim = await sdk.signClaim(channelId, '500000000');
  const isValid = await sdk.verifyClaim(claim);
  console.log('Claim verification:', isValid);
  ```

- [ ] **Channel Closure Test**: Close test channel
  ```typescript
  await sdk.closeChannel(channelId);
  console.log('Test channel closed successfully');
  ```

### Integration Tests

- [ ] **End-to-End Settlement Test**: Full settlement workflow
  - Create channel with test peer
  - Sign and exchange claims
  - Submit claim to ledger
  - Verify XRP transferred
  - Close channel cooperatively

- [ ] **Dual-Settlement Test**: Verify routing logic
  - Test XRP settlement (tokenId = 'XRP')
  - Test EVM settlement (tokenId = ERC20 address)
  - Verify correct routing based on peer config

### Performance Validation

- [ ] **Load Testing**: Verify performance under load
  - Simulate 10 concurrent settlements
  - Monitor transaction latency
  - Verify no degradation (< 2× baseline)

- [ ] **Stress Testing**: Test limits
  - Maximum concurrent channels: 20+
  - Maximum claims per second: 10+
  - Verify graceful degradation

### Monitoring Verification

- [ ] **Alerts Functional**: Trigger test alerts
  - Test balance alert (temporarily lower threshold)
  - Test settlement failure alert (submit invalid claim)
  - Verify alerts reach correct channels

- [ ] **Dashboard Operational**: Verify dashboard displays XRP channels
  - View XRP channels in dashboard
  - Verify orange XRP badges display
  - Check tooltips show drops and settle delay
  - Verify settlement filter works correctly

## Sign-Off

### Final Approval

- [ ] **Security Review**: Security team approval
  - Date: **\*\***\_**\*\***
  - Reviewer: **\*\***\_**\*\***
  - Signature: **\*\***\_**\*\***

- [ ] **Operations Review**: Operations team approval
  - Date: **\*\***\_**\*\***
  - Reviewer: **\*\***\_**\*\***
  - Signature: **\*\***\_**\*\***

- [ ] **Deployment Approval**: Final go/no-go decision
  - Date: **\*\***\_**\*\***
  - Approver: **\*\***\_**\*\***
  - Signature: **\*\***\_**\*\***

---

## Appendix

### Quick Reference

**Minimum Production Requirements:**

- XRP Account Balance: ≥ 50 XRP
- Settle Delay: ≥ 1 hour (3600 seconds)
- Channel Expiration: ≤ 30 days (2592000 seconds)
- Backup Frequency: Every 6 hours
- Monitoring: 24/7 with alerting

**Emergency Contacts:**

- XRP Operations Team: [contact info]
- Security Team: [contact info]
- On-Call Engineer: [contact info]

**Rollback Procedure:**

1. Stop connector service
2. Revert configuration to previous version
3. Restore database from backup
4. Restart connector service
5. Verify channels operational

**Support Resources:**

- [XRP Payment Channels Setup Guide](../guides/xrp-payment-channels-setup.md)
- [XRP Ledger Documentation](https://xrpl.org/)
- [xrpl.js Documentation](https://js.xrpl.org/)
- [M2M Project Documentation](../README.md)
