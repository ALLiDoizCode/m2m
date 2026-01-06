# Tech Stack

**CRITICAL SECTION - DEFINITIVE TECHNOLOGY CHOICES**

This section represents the single source of truth for all technology decisions. All implementation must reference these exact versions and choices.

## Cloud Infrastructure

- **Provider:** None (Local Docker deployment for MVP)
- **Key Services:** Docker Engine, Docker Compose
- **Deployment Regions:** Localhost only (future: cloud-agnostic Kubernetes)

## Technology Stack Table

| Category                       | Technology                | Version          | Purpose                                                    | Rationale                                                                                                                                           |
| ------------------------------ | ------------------------- | ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language**                   | TypeScript                | 5.3.3            | Primary development language for all packages              | Strong typing ensures RFC compliance, excellent IDE support, enables type sharing between connector/dashboard, aligns with Interledger.js ecosystem |
| **Runtime**                    | Node.js                   | 20.11.0 LTS      | JavaScript runtime for connector and dashboard backend     | LTS version guarantees stability, wide ecosystem, asynchronous I/O ideal for WebSocket handling, Docker images readily available                    |
| **Package Manager**            | npm                       | 10.x             | Dependency management and workspace orchestration          | Built-in workspaces feature supports monorepo, standard tooling, no additional setup required                                                       |
| **Backend Framework**          | None (Express.js minimal) | Express 4.18.x   | HTTP server for dashboard static files and health endpoint | Lightweight, well-documented, sufficient for minimal API needs, avoids framework overhead                                                           |
| **Frontend Framework**         | React                     | 18.2.x           | Dashboard UI                                               | Mature ecosystem, excellent integration with visualization libraries, large community, component-based architecture fits dashboard modular design   |
| **Build Tool (Frontend)**      | Vite                      | 5.0.x            | React development server and production bundler            | Lightning-fast HMR, optimized builds, TypeScript support out-of-box, modern alternative to CRA                                                      |
| **UI Styling**                 | TailwindCSS               | 3.4.x            | Utility-first CSS framework                                | Rapid UI development, small bundle size, easy dark theme implementation, minimal custom CSS needed                                                  |
| **Network Visualization**      | Cytoscape.js              | 3.28.x           | Interactive network graph rendering                        | Purpose-built for network graphs, performant for 10+ nodes, supports animated layouts, force-directed positioning, MIT licensed                     |
| **WebSocket Library (Server)** | ws                        | 8.16.x           | WebSocket server for BTP and telemetry                     | Lightweight, standard Node.js WebSocket library, RFC 6455 compliant, widely used                                                                    |
| **WebSocket Library (Client)** | Native WebSocket API      | Browser built-in | Browser-side WebSocket for dashboard UI                    | No additional dependencies, standard browser API, sufficient for client needs                                                                       |
| **Logging Library**            | Pino                      | 8.17.x           | Structured JSON logging                                    | High-performance (minimal overhead), excellent TypeScript support, structured JSON output, child logger support for correlation IDs                 |
| **Testing Framework**          | Jest                      | 29.7.x           | Unit and integration testing                               | Industry standard, excellent TypeScript support, snapshot testing, mocking capabilities, coverage reporting                                         |
| **Linting**                    | ESLint                    | 8.56.x           | Code quality and consistency                               | Enforce coding standards, catch common errors, TypeScript integration via @typescript-eslint                                                        |
| **Code Formatting**            | Prettier                  | 3.2.x            | Automated code formatting                                  | Consistent code style, integrates with ESLint, reduces style debates                                                                                |
| **ILP Packet Encoding**        | Custom OER Implementation | N/A              | Encode/decode ILP packets per RFC-0030                     | Educational value of building from scratch, no suitable existing library with TypeScript types, enables deep RFC understanding                      |
| **Configuration Format**       | YAML + dotenv             | js-yaml 4.1.x    | Topology definitions (YAML), runtime config (ENV)          | YAML human-readable for topology files, ENV vars integrate with Docker Compose, standard conventions                                                |
| **Container Base Image**       | node:20-alpine            | 20-alpine        | Docker base image for all containers                       | Small footprint (~150MB), official Node.js image, Alpine Linux security benefits, faster startup                                                    |
| **Container Orchestration**    | Docker Compose            | 2.24.x           | Multi-node network deployment                              | Simple declarative configuration, standard developer tool, supports health checks and networking                                                    |
| **Version Control**            | Git                       | 2.x              | Source control with conventional commits                   | Industry standard, conventional commits enable changelog automation                                                                                 |
| **CI/CD**                      | GitHub Actions            | N/A              | Automated testing, linting, and Docker builds              | Free for open-source, GitHub integration, supports matrix testing across Node versions                                                              |
| **Database**                   | None (In-memory)          | N/A              | No persistence layer for MVP                               | Simplifies architecture, sufficient for ephemeral routing state, aligns with educational/testing use case                                           |
| **Smart Contract Language**    | Solidity                  | 0.8.20           | EVM smart contract development (Epic 8)                    | Industry standard for Ethereum/EVM chains, mature tooling, extensive documentation, security audit ecosystem                                        |
| **Smart Contract Framework**   | Foundry                   | Latest           | Smart contract development, testing, and deployment        | Fast compilation and testing, built-in fuzzing, gas optimization tools, superior developer experience vs Hardhat                                    |
| **Smart Contract Libraries**   | OpenZeppelin Contracts    | 5.5.0            | Audited smart contract implementations                     | Industry-standard secure implementations (SafeERC20, ReentrancyGuard, Ownable), battle-tested security patterns                                     |
| **Blockchain (Development)**   | Anvil (Foundry)           | Latest           | Local Ethereum development node                            | Instant mining, pre-funded accounts, fork mainnet state, zero-config local testing, ships with Foundry                                              |
| **Blockchain (Production)**    | Base L2                   | Mainnet          | Production EVM-compatible L2 blockchain                    | Low gas costs ($0.001-0.01), 2-second finality, Ethereum security, Coinbase infrastructure, no node hosting required                                |
| **Ethereum Client Library**    | ethers.js                 | 6.x              | Blockchain interaction from TypeScript connector           | Complete Ethereum library, TypeScript support, widely adopted, EIP-712 signing support for payment channels                                         |

**Important Notes:**

1. **No External APIs Required:** All functionality self-contained except Docker Hub for base images and Base L2 public RPC endpoints
2. **Monorepo Package Structure:**
   - `packages/connector` - Uses Node.js, TypeScript, Pino, ws, Express (health endpoint), ethers.js (blockchain interaction)
   - `packages/dashboard` - Uses React, Vite, TailwindCSS, Cytoscape.js
   - `packages/shared` - Pure TypeScript types and utilities (ILP packet definitions, OER encoding)
   - `packages/contracts` - Uses Solidity, Foundry, OpenZeppelin (Epic 8 payment channel smart contracts)
3. **TypeScript Configuration:** Strict mode enabled across all packages, shared tsconfig.base.json in monorepo root
4. **Solidity Configuration:** Version 0.8.20 with OpenZeppelin v5.5.0, configured in foundry.toml (Epic 8)
5. **Version Pinning Strategy:** Patch versions flexible (^), minor versions locked for stability, LTS/stable releases preferred
6. **License Compatibility:** All dependencies MIT or Apache 2.0 compatible (open-source project)
7. **Blockchain Deployment:** Smart contracts deploy to Base L2 (testnet and mainnet), connectors connect via public RPC endpoints (no node hosting required)
