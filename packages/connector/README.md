# @m2m/connector

The M2M Connector package provides the core ILP connector functionality for the Machine-to-Machine Economy platform.

## Overview

This package implements:

- ILP packet routing and forwarding
- Settlement coordination (EVM and XRP Ledger)
- Balance tracking with TigerBeetle
- Peer management via BTP
- Security controls and rate limiting

## Installation

```bash
npm install @m2m/connector
```

## Usage

See the main project README for configuration and deployment instructions.

## Testing

```bash
# Unit tests
npm test

# Acceptance tests
npm run test:acceptance

# Load tests (requires staging environment)
npm run test:load
```

## Package Structure

- `src/` - Source code
  - `core/` - Core connector logic
  - `routing/` - Packet routing
  - `settlement/` - Settlement engines
  - `wallet/` - Wallet management
- `test/` - Test suites
  - `unit/` - Unit tests
  - `integration/` - Integration tests
  - `acceptance/` - Acceptance tests

## License

See root LICENSE file.
