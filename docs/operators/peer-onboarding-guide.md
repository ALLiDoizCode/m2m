# Peer Onboarding Guide

This guide explains how to join the M2M network as a connector operator, including the onboarding wizard, manual configuration, and network connectivity requirements.

## Table of Contents

1. [Overview](#overview)
2. [Using the Onboarding Wizard](#using-the-onboarding-wizard)
3. [Manual Configuration](#manual-configuration)
4. [Network Connectivity](#network-connectivity)
5. [Peer Discovery](#peer-discovery)
6. [Security Best Practices](#security-best-practices)
7. [Testing Your Connection](#testing-your-connection)

## Overview

The M2M network is a mesh of ILP connectors that route payments across different blockchains. As a connector operator, you'll need to:

1. Configure your connector with blockchain addresses
2. Set up secure key management
3. Connect to existing peers in the network
4. Optionally enable peer discovery for automatic connections

## Using the Onboarding Wizard

The onboarding wizard is the easiest way to configure your connector.

### Prerequisites

- Node.js 20+ installed
- Access to your blockchain addresses (EVM and/or XRP)

### Running the Wizard

```bash
# Using npx (recommended)
npx @m2m/connector setup

# Or if installed locally
npm run setup --workspace=packages/connector
```

### Wizard Steps

The wizard will guide you through the following:

#### 1. Node ID

```
? Enter a unique node ID for this connector: (connector-a1b2c3d4)
```

Choose a unique identifier for your connector. This is used for:

- Logging and monitoring
- Peer identification
- Audit trails

#### 2. Settlement Preference

```
? Select your settlement preference:
  ❯ Both EVM and XRP (recommended)
    EVM only (Base L2)
    XRP only (XRP Ledger)
```

Choose based on which blockchains you want to settle on:

- **Both**: Maximum flexibility, can route payments for both networks
- **EVM only**: Only settle on Base L2 (Ethereum)
- **XRP only**: Only settle on XRP Ledger

#### 3. Blockchain Addresses

```
? Enter your Ethereum address (0x...): 0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3
? Enter your XRP address (r...): rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv
```

Enter the addresses that will receive settlement payments:

- **EVM Address**: Must be `0x` followed by 40 hexadecimal characters
- **XRP Address**: Must be `r` followed by 24-34 base58 characters

#### 4. Key Management

```
? Select your key management backend:
  ❯ Environment variables (development only)
    AWS KMS (production)
    GCP KMS (production)
    Azure Key Vault (production)
```

**IMPORTANT**: For production, always use a cloud KMS service.

#### 5. Monitoring

```
? Enable Prometheus/Grafana monitoring? (Y/n)
```

Recommended to enable for production visibility.

#### 6. Network Ports

```
? BTP server port: (4000)
? Health check and metrics HTTP port: (8080)
```

Default ports work for most deployments.

#### 7. Log Level

```
? Select log level:
    debug - Verbose debugging information
  ❯ info - General operational information (recommended)
    warn - Warning messages only
    error - Error messages only
```

### Output

The wizard generates a `.env` file with your configuration:

```bash
# Configuration saved to: /path/to/project/.env
```

## Manual Configuration

If you prefer manual configuration, copy and edit the environment template:

```bash
cp .env.example .env
```

### Required Settings

```bash
# Node identity
NODE_ID=my-connector
SETTLEMENT_PREFERENCE=both

# Blockchain RPC endpoints
BASE_RPC_URL=https://mainnet.base.org
XRPL_WSS_URL=wss://xrplcluster.com

# Your settlement addresses
EVM_ADDRESS=0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3
XRP_ADDRESS=rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv

# Key management (NEVER use 'env' in production!)
KEY_BACKEND=aws-kms
AWS_REGION=us-east-1
AWS_KMS_EVM_KEY_ID=arn:aws:kms:...
AWS_KMS_XRP_KEY_ID=arn:aws:kms:...
```

### Peer Configuration

Edit `examples/production-single-node.yaml`:

```yaml
nodeId: my-connector
ilpAddress: g.connector.myconnector

peers:
  # Upstream peer (parent relationship)
  - id: upstream-hub
    relation: parent
    btpUrl: ws://hub.example.com:4000
    maxPacketAmount: 1000000000000

  # Downstream peer (child relationship)
  - id: downstream-merchant
    relation: child
    btpUrl: ws://merchant.example.com:4000

  # Symmetric peer (sibling relationship)
  - id: partner-connector
    relation: peer
    btpUrl: ws://partner.example.com:4000
```

## Network Connectivity

### Required Outbound Access

| Endpoint        | Port          | Purpose         |
| --------------- | ------------- | --------------- |
| Base L2 RPC     | 443           | EVM blockchain  |
| XRP Ledger      | 443/51233     | XRP blockchain  |
| Peer connectors | 4000 (varies) | BTP connections |

### Required Inbound Access

| Port | Purpose                   |
| ---- | ------------------------- |
| 4000 | BTP WebSocket server      |
| 8080 | Health checks and metrics |

### Firewall Configuration

```bash
# Allow inbound BTP connections
sudo ufw allow 4000/tcp

# Allow health check access (optional, for monitoring)
sudo ufw allow 8080/tcp
```

## Peer Discovery

Peer discovery allows automatic connection to other connectors in the network.

### Enabling Discovery

In your `.env` file:

```bash
PEER_DISCOVERY_ENABLED=true
PEER_DISCOVERY_ENDPOINTS=http://discovery.m2m.network:9999
PEER_ANNOUNCE_ADDRESS=ws://my-connector.example.com:4000
```

### How It Works

1. Your connector announces itself to discovery endpoints
2. Other connectors discover your presence
3. Connections are established automatically
4. Peers are tracked and reconnected if connections drop

### Discovery Configuration Options

| Variable                   | Default     | Description                            |
| -------------------------- | ----------- | -------------------------------------- |
| `PEER_DISCOVERY_ENABLED`   | `false`     | Enable/disable discovery               |
| `PEER_DISCOVERY_ENDPOINTS` | -           | Comma-separated discovery service URLs |
| `PEER_ANNOUNCE_ADDRESS`    | auto-detect | Public WebSocket URL to announce       |

### Running Your Own Discovery Service

For private networks, you can run your own discovery service. Contact the M2M team for the discovery service software.

## Security Best Practices

### Key Management

1. **Never use `KEY_BACKEND=env` in production**
   - Environment variables can be leaked through process listings
   - Use cloud KMS for proper key protection

2. **Rotate keys regularly**
   - Configure automatic key rotation in your KMS
   - Test key rotation in staging first

3. **Use separate keys per environment**
   - Development, staging, and production should use different keys

### Network Security

1. **Use TLS for peer connections** (when supported)
2. **Restrict management port access** (8080)
3. **Monitor for unusual traffic patterns**

### Authentication

For authenticated peer connections, configure shared secrets:

```bash
# In .env
BTP_PEER_PARTNER_SECRET=your-shared-secret-here
```

Generate strong secrets:

```bash
openssl rand -base64 32
```

## Testing Your Connection

### 1. Verify Health

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
  "status": "healthy",
  "dependencies": {
    "tigerbeetle": { "status": "connected" },
    "xrpl": { "status": "connected" },
    "evm": { "status": "connected" }
  }
}
```

### 2. Check Peer Connections

```bash
curl http://localhost:8080/health | jq .peers
```

### 3. Verify Routing

Send a test packet through the network using the CLI tools:

```bash
npx @m2m/connector health --url http://localhost:8080/health
```

### 4. Monitor Metrics

Check Prometheus metrics for successful packet routing:

```bash
curl http://localhost:8080/metrics | grep ilp_packets
```

## Common Issues

### "No peers connected"

- Verify peer URLs in configuration
- Check firewall allows outbound WebSocket connections
- Confirm peer is online and accepting connections

### "Settlement address invalid"

- EVM addresses must be 42 characters (0x + 40 hex)
- XRP addresses must be 25-35 characters (r + base58)

### "Key management backend error"

- Verify IAM permissions for KMS access
- Check key IDs are correct
- Ensure region matches key location

## Getting Help

- **Documentation**: See [production-deployment-guide.md](production-deployment-guide.md)
- **Issues**: https://github.com/m2m-network/m2m/issues
- **Monitoring**: See [monitoring-setup-guide.md](monitoring-setup-guide.md)
