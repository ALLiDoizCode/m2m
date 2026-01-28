# Tech Stack

**CRITICAL SECTION - DEFINITIVE TECHNOLOGY CHOICES**

This section represents the single source of truth for all technology decisions. All implementation must reference these exact versions and choices.

## Cloud Infrastructure

- **Provider:** None (Local Docker deployment for MVP)
- **Key Services:** Docker Engine, Docker Compose
- **Deployment Regions:** Localhost only (future: cloud-agnostic Kubernetes)

## Technology Stack Table

| Category                       | Technology                        | Version        | Purpose                                               | Rationale                                                                                                                               |
| ------------------------------ | --------------------------------- | -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Language**                   | TypeScript                        | 5.3.3          | Primary development language for all packages         | Strong typing ensures RFC compliance, excellent IDE support, enables type sharing across packages, aligns with Interledger.js ecosystem |
| **Runtime**                    | Node.js                           | 20.11.0 LTS    | JavaScript runtime for connector and backend services | LTS version guarantees stability, wide ecosystem, asynchronous I/O ideal for WebSocket handling, Docker images readily available        |
| **Package Manager**            | npm                               | 10.x           | Dependency management and workspace orchestration     | Built-in workspaces feature supports monorepo, standard tooling, no additional setup required                                           |
| **Backend Framework**          | None (Express.js minimal)         | Express 4.18.x | HTTP server for health endpoint                       | Lightweight, well-documented, sufficient for minimal API needs, avoids framework overhead                                               |
| **WebSocket Library (Server)** | ws                                | 8.16.x         | WebSocket server for BTP connections                  | Lightweight, standard Node.js WebSocket library, RFC 6455 compliant, widely used                                                        |
| **Logging Library**            | Pino                              | 8.17.x         | Structured JSON logging                               | High-performance (minimal overhead), excellent TypeScript support, structured JSON output, child logger support for correlation IDs     |
| **Testing Framework**          | Jest                              | 29.7.x         | Unit and integration testing                          | Industry standard, excellent TypeScript support, snapshot testing, mocking capabilities, coverage reporting                             |
| **Linting**                    | ESLint                            | 8.56.x         | Code quality and consistency                          | Enforce coding standards, catch common errors, TypeScript integration via @typescript-eslint                                            |
| **Code Formatting**            | Prettier                          | 3.2.x          | Automated code formatting                             | Consistent code style, integrates with ESLint, reduces style debates                                                                    |
| **ILP Packet Encoding**        | Custom OER Implementation         | N/A            | Encode/decode ILP packets per RFC-0030                | Educational value of building from scratch, no suitable existing library with TypeScript types, enables deep RFC understanding          |
| **Configuration Format**       | YAML + dotenv                     | js-yaml 4.1.x  | Topology definitions (YAML), runtime config (ENV)     | YAML human-readable for topology files, ENV vars integrate with Docker Compose, standard conventions                                    |
| **Container Base Image**       | node:20-alpine                    | 20-alpine      | Docker base image for all containers                  | Small footprint (~150MB), official Node.js image, Alpine Linux security benefits, faster startup                                        |
| **Container Orchestration**    | Docker Compose                    | 2.24.x         | Multi-node network deployment                         | Simple declarative configuration, standard developer tool, supports health checks and networking                                        |
| **Version Control**            | Git                               | 2.x            | Source control with conventional commits              | Industry standard, conventional commits enable changelog automation                                                                     |
| **CI/CD**                      | GitHub Actions                    | N/A            | Automated testing, linting, and Docker builds         | Free for open-source, GitHub integration, supports matrix testing across Node versions                                                  |
| **Database (Accounting)**      | TigerBeetle                       | 0.x            | Persistent balance tracking for agent wallets         | High-performance distributed accounting, ACID guarantees, designed for financial workloads                                              |
| **Database (Agent Wallet)**    | SQLite                            | 3.x            | Agent wallet state and payment channel tracking       | Embedded database, zero-configuration, sufficient for single-agent deployment                                                           |
| **Database (Agent Events)**    | libSQL                            | 0.14.0         | Nostr event storage for Agent Society Protocol        | SQLite fork with MVCC concurrent writes, eliminates single-writer bottleneck, encryption at rest, async API                             |
| **Serialization (Agent)**      | TOON                              | 2.1.0          | Token-Oriented Object Notation for Nostr events       | ~40% smaller than JSON, LLM-friendly format, efficient for ILP packet data field                                                        |
| **Nostr Crypto**               | nostr-tools                       | 2.10.0         | Nostr event signing and verification                  | Standard Nostr library, Ed25519/Schnorr signatures, event ID generation                                                                 |
| **Blockchain Libraries**       | xrpl.js + ethers.js               | Latest         | XRP and EVM payment channel interactions              | Official XRP library, standard Ethereum library, settlement integration for dual-settlement support                                     |
| **AI SDK**                     | Vercel AI SDK (ai)                | ^4.0.0         | AI-native event handling with tool calling            | Provider-agnostic model abstraction, built-in tool system maps to agent skills, streaming and generateText support                      |
| **AI Providers**               | @ai-sdk/anthropic, @ai-sdk/openai | ^1.0.0         | Anthropic and OpenAI model provider adapters          | Pluggable provider system, any AI SDK-compatible provider works via provider:model config format                                        |
| **Schema Validation (AI)**     | Zod                               | ^3.23.0        | Runtime schema validation for AI skill parameters     | First-class AI SDK integration, TypeScript type inference from schemas, used for tool parameter validation                              |

**Important Notes:**

1. **External APIs Required:** XRP Ledger testnet/mainnet, EVM-compatible blockchains (Ethereum, Polygon, etc.)
2. **Monorepo Package Structure:**
   - `packages/connector` - Uses Node.js, TypeScript, Pino, ws, Express (health endpoint), settlement engines
   - `packages/connector/src/agent` - Agent Society Protocol components (libSQL, TOON, nostr-tools)
   - `packages/shared` - Pure TypeScript types and utilities (ILP packet definitions, OER encoding, telemetry types)
3. **TypeScript Configuration:** Strict mode enabled across all packages, shared tsconfig.base.json in monorepo root
4. **Version Pinning Strategy:** Patch versions flexible (^), minor versions locked for stability, LTS/stable releases preferred
5. **License Compatibility:** All dependencies MIT or Apache 2.0 compatible (open-source project)

**Dashboard Deferred:** Dashboard visualization components removed to focus on core payment functionality. See DASHBOARD-DEFERRED.md in root.
