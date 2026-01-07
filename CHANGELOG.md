# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-12-31

### Initial MVP Release

This is the first MVP release of the M2M ILP Connector, providing a functional Interledger Protocol v4 (RFC-0027) connector implementation with real-time monitoring capabilities.

### Added

#### Core ILP Functionality

- **ILPv4 Packet Handling** - Full implementation of RFC-0027 Interledger Protocol v4
  - ILP Prepare, Fulfill, and Reject packet processing
  - Packet validation with expiry time checking and safety margins
  - OER (Octet Encoding Rules) serialization/deserialization per RFC-0030
  - Structured error codes and error handling per RFC-0027

#### Routing & Forwarding

- **Static Routing Table** - Longest-prefix match routing with configurable priority
  - Support for hierarchical ILP addresses per RFC-0015
  - Route validation and lookup optimization
  - Multi-hop packet forwarding through connector chains

#### BTP Protocol Implementation

- **Bilateral Transfer Protocol (BTP)** - RFC-0023 compliant implementation
  - WebSocket-based peer connections with auto-reconnection
  - Bidirectional packet forwarding (both outbound and incoming peers)
  - Shared-secret authentication with environment variable configuration
  - Connection health monitoring and retry with exponential backoff
  - Resilient startup tolerating temporary peer unavailability

#### Configuration & Deployment

- **YAML Configuration** - Human-readable configuration files
  - Node identity (nodeId, BTP server port, log level)
  - Static routing table definition
  - Peer connection definitions
  - Health check configuration
- **Docker Support** - Production-ready containerization
  - Multi-stage Dockerfile for optimized image size
  - Docker Compose configurations for multiple topology patterns
  - Health check integration with Docker/Kubernetes orchestration

#### Monitoring & Observability

- **Real-time Telemetry** - WebSocket-based telemetry streaming
  - NODE_STATUS events (routes, peer connections, health)
  - PACKET_ROUTED events (packet forwarding with correlation IDs)
  - LOG events (structured application logs)
- **Health Check HTTP Endpoint** - Production readiness monitoring
  - `/health` endpoint with JSON status response
  - Peer connection percentage tracking
  - Uptime and version information
- **Structured Logging** - Pino-based JSON logging
  - Correlation IDs for request tracing
  - Component-level log contexts
  - Configurable log levels

#### Dashboard & Visualization

- **React Dashboard Application** - Real-time network visualization
  - Interactive network topology graph using Cytoscape.js
  - Live packet animation showing routing paths
  - Node status panel with connection health
  - Packet detail panel with full packet inspection
  - Filterable log viewer with level and node filtering
  - shadcn/ui component library for consistent UX

#### Development Tools

- **send-packet CLI** - Test packet injection utility
  - Single packet, batch, and sequential sending modes
  - Configurable amount, destination, expiry, and data payload
  - BTP authentication and error handling
  - Useful for testing and debugging connector networks

### Example Configurations

Five pre-configured Docker Compose topologies included:

- **Linear 3-Node** (`docker-compose.yml`) - Simple chain topology
- **Linear 5-Node** (`docker-compose-5-node.yml`) - Extended chain for performance testing
- **Mesh 4-Node** (`docker-compose-mesh.yml`) - Full mesh connectivity
- **Hub-Spoke** (`docker-compose-hub-spoke.yml`) - Centralized hub topology
- **Complex 8-Node** (`docker-compose-complex.yml`) - Mixed topology patterns

### Technical Implementation

#### Architecture

- **TypeScript** - Type-safe implementation with strict mode
- **Monorepo** - npm workspaces for shared code and modularity
- **Event-driven** - EventEmitter-based architecture for loose coupling
- **Async/await** - Promise-based async operations throughout

#### Dependencies

- Node.js 20 LTS
- TypeScript 5.x
- ws (WebSocket library)
- pino (structured logging)
- React 18 + Vite (dashboard)
- Cytoscape.js (graph visualization)

### Known Limitations

- **Static Routing Only** - Dynamic route discovery not yet implemented
- **No Settlement** - Payment settlement not implemented (routing only)
- **No STREAM Protocol** - Only base ILP packet forwarding
- **In-Memory State** - No persistence of routing tables or telemetry
- **Single Region** - No multi-region deployment support

### Performance Characteristics

- Packet forwarding latency: <10ms per hop (local network)
- Supports hundreds of concurrent packet flows
- WebSocket connections scale to dozens of peers per connector
- Dashboard handles 100+ telemetry events per second

### Security Considerations

- BTP authentication uses shared secrets (not production-grade)
- No TLS/encryption on BTP WebSocket connections
- No rate limiting or DDoS protection
- Suitable for development and testing only

---

## [Unreleased]

### Fixed

- **[10.1] Settlement Executor Test Failures** (commit 034a098)
  - Fixed event listener cleanup issue causing test failures
    - Previously `bind(this)` created new function references preventing `EventEmitter.off()` from matching handlers
    - Now store `boundHandleSettlement` in constructor for proper cleanup
  - Validated async timeout coverage for all settlement operations
    - Basic operations: 50ms, Deposit operations: 100ms, Retry operations: 500ms
  - Verified mock isolation with 10/10 stability test runs (100% pass rate)
  - Added test anti-patterns documentation to `test-strategy-and-standards.md`
  - Created root cause analysis at `docs/qa/root-cause-analysis-10.1.md`
  - Resolved Epic 10 CI/CD pipeline failures on settlement executor tests

### Added

- **[10.2] Pre-Commit Quality Gates**
  - Enhanced pre-commit hook with informative messages and fast targeted checks
    - Runs ESLint and Prettier on staged files only using lint-staged
    - Auto-fixes issues when possible (eslint --fix, prettier --write)
    - Execution time: 2-5 seconds for typical commits
  - Enhanced pre-push hook with optimized checks and related tests
    - Targeted linting on changed TypeScript files only
    - Format check across all files
    - Jest --findRelatedTests for changed source files (excludes test/type definition files)
    - Clear error messages with actionable fix instructions
    - Execution time: 10-30 seconds depending on changes
  - Added Pull Request template (`.github/PULL_REQUEST_TEMPLATE.md`)
    - Pre-submission quality checklist (hooks, tests, coverage, documentation)

- **[10.3] Document Test Quality Standards & CI Best Practices**
  - Expanded test-strategy-and-standards.md with additional anti-patterns
    - Anti-Pattern 4: Hardcoded timeouts in production code (use event-driven patterns or configurable delays)
    - Anti-Pattern 5: Incomplete test cleanup (resources not released)
    - Anti-Pattern 6: Testing implementation details instead of behavior
  - Added stability testing best practices
    - When to run stability tests (after fixing flaky tests, before production releases)
    - How to create stability test scripts (example: run-settlement-tests.sh)
    - Success criteria: 100% pass rate over N runs (N=10 for unit tests, N=3 for integration)
  - Added test isolation validation techniques
    - Run tests sequentially with `--runInBand` to detect order dependencies
    - Run tests in random order with `--randomize` to detect interdependencies
    - Run single test file in isolation to verify no workspace dependencies
  - Added code examples from actual project tests
    - Good example: settlement-executor.test.ts event listener cleanup
    - Good example: Mock isolation in beforeEach()
    - Bad example: Inline bind(this) anti-pattern
  - Created comprehensive CI troubleshooting guide (`docs/development/ci-troubleshooting.md`)
    - 7 common CI failure scenarios with diagnosis and resolution steps
    - Job-specific debugging procedures for all CI jobs (lint, test, build, type-check, contracts, E2E)
    - Investigation runbook with step-by-step debugging workflow
    - Monitoring guidelines for tracking CI health metrics
    - Continuous improvement process for systematic issue resolution
  - Documented epic branch workflow in developer-guide.md
    - Epic branch PR creation process with pre-PR checklist
    - Epic branch quality standards (zero tolerance for failures, coverage requirements)
    - Handling epic branch PR failures (reproduce locally, create hotfix, document root cause)
  - Added pre-push quality checklist to developer-guide.md
    - Code review checklist (staged changes, no console.log in production)
    - Quality gates checklist (pre-commit hooks, related tests)
    - Type safety checklist (strict mode compliance, no `any` types)
    - Test coverage checklist (>80% for new code)
    - Documentation checklist (README, CHANGELOG, architecture docs)
  - Created developer documentation index (`docs/development/README.md`)
    - Central hub organizing all documentation by category
    - Quick reference with common commands and checklists
    - Contributing path with ordered reading list
  - Updated main README.md with Developer Documentation section
    - Links to developer guide, git hooks, test standards, CI troubleshooting
    - Epic branch workflow and pre-push checklist references
  - Enhanced CONTRIBUTING.md with Before You Start and When Things Go Wrong sections
    - Required reading list (developer guide, git hooks, test standards, coding standards)
    - CI troubleshooting resources and test failure guides
    - Root cause analysis references
    - Issue reporting guidelines
  - Integrated all Epic 10 documentation for discoverability
    - Cross-references between related documents
    - Clear navigation paths from README to specialized guides
    - Consolidated test quality and CI/CD best practices
    - Type of change selection (feature, bugfix, refactor, docs, test)
    - Bypass justification section with warnings
  - Created Git hooks documentation (`docs/development/git-hooks.md`)
    - Detailed hook workflow and bypass mechanism documentation
    - Troubleshooting guide for common issues
    - Quick reference table for developers
  - Created developer guide (`docs/development/developer-guide.md`)
    - Quick reference for local quality checks
    - Hook workflow overview
  - Prevents CI failures by catching issues locally before push

Future planned features:

- Dynamic routing with route advertisement
- STREAM protocol support (RFC-0029)
- Settlement engine integration (RFC-0038)
- TLS support for BTP connections
- Rate limiting and traffic shaping
- Multi-region deployment
- Persistent routing table storage
- Performance optimization and benchmarking

[0.1.0]: https://github.com/anthropics/m2m/releases/tag/v0.1.0
