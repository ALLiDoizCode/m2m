# Technology Stack Overview

## Overview

The Connector is built on a TypeScript/Node.js stack optimized for high-throughput payment routing with on-chain settlement.

## Core Dependencies

- **Runtime:** Node.js >= 22.11.0
- **Language:** TypeScript 5.3.3 (strict mode, ES2022 target, CommonJS modules)
- **Monorepo:** npm workspaces (`packages/connector`, `packages/shared`, `packages/contracts`)

## Transport and Networking

- **BTP Transport:** ws 8.16.0 (WebSocket-based, RFC-0023 compliant)
- **HTTP:** Express 4.18.x (admin API, health checks, explorer)

## Blockchain and Settlement

- **EVM Settlement:** ethers 6.16.0 (Base L2 and EVM-compatible chains)
- **Smart Contracts:** Solidity (Foundry/Anvil for local development)

## Data and Persistence

- **Claims Database:** better-sqlite3 11.8.1
- **High-Throughput Accounting:** TigerBeetle 0.16.68 (optional)

## Configuration and Validation

- **Config Format:** YAML with Zod 3.25.76 schema validation
- **Logging:** Pino 8.21.0 (structured JSON)

## Development Tooling

- **Testing:** Jest 29.7.0 + ts-jest 29.1.2
- **Linting:** ESLint 8.56.0 + @typescript-eslint 6.21.0
- **Formatting:** Prettier 3.2.5
- **Git Hooks:** Husky 9.1.7 + lint-staged
- **Releases:** semantic-release 24.2.0 (conventional commits)
