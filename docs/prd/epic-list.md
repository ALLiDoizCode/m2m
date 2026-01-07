# Epic List

**Epic 1: Foundation & Core ILP Protocol Implementation**
Establish monorepo structure, implement RFC-0027 (ILPv4) packet handling and routing logic with OER encoding, and deliver basic packet forwarding capability with unit tests and logging.

**Epic 2: BTP Protocol & Multi-Node Docker Deployment**
Implement RFC-0023 BTP WebSocket communication between connectors, create Docker containerization with Compose orchestration, and enable deployment of configurable N-node networks with health checks.

**Epic 3: Real-Time Visualization Dashboard**
Build React-based network visualization showing topology and animated packet flow, implement telemetry aggregation from connector nodes, and provide interactive packet inspection capabilities.

**Epic 4: Logging, Configuration & Developer Experience**
Implement comprehensive structured logging with filterable log viewer, add support for multiple network topology configurations, create test packet sender utility, and complete documentation for user onboarding.

**Epic 5: Documentation and RFC Integration**
Create comprehensive developer documentation explaining ILP concepts and ensure all RFC references are accurate, accessible, and properly integrated into the M2M project documentation.

**Epic 6: Settlement Foundation & Accounting**
Integrate TigerBeetle as the double-entry accounting database, build account management infrastructure to track balances and credit limits between peers, implement settlement threshold triggers, and provide dashboard visualization of account states and settlement events.

**Epic 7: Local Blockchain Development Infrastructure**
Establish local blockchain node infrastructure with Anvil (Base L2 fork) and rippled (XRP Ledger standalone mode) via Docker Compose, enabling developers to build and test payment channel smart contracts locally without testnet/mainnet dependencies, with instant block finality and zero gas costs.

**Epic 8: EVM Payment Channels (Base L2)**
Implement XRP-style payment channels as EVM smart contracts on Base L2, deploy payment channel infrastructure via Docker, integrate with settlement layer for automatic channel settlement, and enable instant cryptocurrency micropayments between connector peers.

**Epic 9: XRP Payment Channels**
Integrate XRP Ledger payment channels (PayChan) for settlement, implement XRP payment channel state management and claim verification, enable dual-settlement support (both EVM and XRP), and provide unified settlement API for multi-chain operations.

**Epic 10: CI/CD Pipeline Reliability & Test Quality**
Eliminate recurring CI/CD pipeline failures on epic branch pull requests by fixing test quality issues (async handling, mock coverage, timeouts), implementing pre-commit quality gates, and establishing systematic testing workflows that ensure code quality before CI execution.

**Epic 11: AI Agent Wallet Infrastructure**
Implement programmatic wallet creation and management for AI agents, provide HD wallet derivation for scalable agent provisioning, enable per-agent wallet isolation with automated lifecycle management, and deliver wallet monitoring, balance tracking, and recovery procedures for autonomous agent operations.

**Epic 12: Multi-Chain Settlement & Production Hardening**
Add cross-chain settlement coordination, implement production-grade security hardening (key management, rate limiting, fraud detection), optimize for AI agent micropayment performance (10K+ TPS), and deliver complete Docker deployment with simplified peer onboarding for M2M economy ecosystem.

---
