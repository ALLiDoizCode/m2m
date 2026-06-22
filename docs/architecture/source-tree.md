# Source Code Structure

## Overview

The Connector is organized as an npm workspace monorepo with domain-driven source organization.

## Top-Level Structure

```
connector/
  packages/
    connector/     # Main connector package
    shared/        # Shared types and encoding
    contracts/     # Solidity smart contracts
    faucet/        # Token faucet for local development
  tools/
    send-packet/   # CLI tool for sending test packets
    fund-peers/    # CLI tool for funding peer accounts
```

## Packages

### packages/connector

The core connector implementation, organized by domain:

```
src/
  btp/            # BTP transport (WebSocket-based)
  core/           # Core routing and packet forwarding
  settlement/     # On-chain settlement engines
  routing/        # Route management and propagation
  config/         # YAML config loading and Zod validation
  security/       # Key management and authentication
  telemetry/      # Metrics and observability
  transport/      # TransportProvider: Direct TCP + ILP-over-HTTP egress
  utils/          # Shared utilities
  agent/          # AI agent integration
  cli/            # Command-line interface
  lib.ts          # Public API exports
  index.ts        # Re-exports from lib.ts
```

The `transport/` directory houses the `TransportProvider` abstraction used for outbound BTP WebSocket connections (`DirectTransportProvider` — direct TCP) and the ILP-over-HTTP egress client (`http-peer-transport.ts`).

### packages/shared

Shared types and encoding utilities used across packages:

```
src/
  types/          # ILP packet types and interfaces
  encoding/       # OER (Octet Encoding Rules) codec
  index.ts        # Package exports
```

### packages/contracts

Solidity smart contracts for on-chain settlement (Foundry-based).

## Test Structure

```
packages/connector/
  src/**/*.test.ts           # Unit tests (co-located)
  test/
    integration/             # Integration tests
    acceptance/              # Acceptance tests (ATDD)
    helpers/                 # Test utilities
```
