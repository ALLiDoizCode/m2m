# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0](https://github.com/ALLiDoizCode/m2m/compare/v1.3.0...v1.4.0) (2026-01-28)

### Features

- **agent:** add AI agent module with Vercel AI SDK integration (Epic 16) ([3a36c64](https://github.com/ALLiDoizCode/m2m/commit/3a36c64893180e1956b299ad574428f109f8a941))
- **agent:** complete Epic 16 stories 16.3-16.7 with QA gates ([f96e0db](https://github.com/ALLiDoizCode/m2m/commit/f96e0db6404eb6220961daa44ef3f07ae48c87b7))

## [1.3.0](https://github.com/ALLiDoizCode/m2m/compare/v1.2.0...v1.3.0) (2026-01-27)

### Features

- **contracts:** deploy TokenNetworkRegistry to Base Sepolia and Base Mainnet ([8569685](https://github.com/ALLiDoizCode/m2m/commit/8569685b484689d549c26f02ac7389dff02ef9ce))

## [1.2.0](https://github.com/ALLiDoizCode/m2m/compare/v1.1.0...v1.2.0) (2026-01-27)

### Features

- **agent:** implement real EVM payment channels for Docker agent test ([bce647f](https://github.com/ALLiDoizCode/m2m/commit/bce647fbc24db34ac9cfb1928e0858b9d73d4105))
- **explorer:** add ILP packet type display with routing fields ([9974d71](https://github.com/ALLiDoizCode/m2m/commit/9974d71a42b0c3f7b5fd5279eeea2731e4794086))
- **explorer:** add on-chain wallet panel and improve accounts view ([b260a81](https://github.com/ALLiDoizCode/m2m/commit/b260a8144101fd86dc24fc2d8f1f704df80e2150))
- **explorer:** add packet ID correlation and improve status display ([fe5e582](https://github.com/ALLiDoizCode/m2m/commit/fe5e582157dec817bedb0ecf8ea34f0035e4b2b6))
- **explorer:** add Peers & Routing Table view, historical data hydration, and QA reviews ([285b8a3](https://github.com/ALLiDoizCode/m2m/commit/285b8a30074d1992c7b37a517c1a98ae3d2375c1))
- **explorer:** Epic 15 — Agent Explorer polish, performance & visual quality ([d10037c](https://github.com/ALLiDoizCode/m2m/commit/d10037ceea6c23b2ab5eb7e7fa3e0f6711a529c5))
- **explorer:** implement Packet/Event Explorer UI (Epic 14) ([de13d82](https://github.com/ALLiDoizCode/m2m/commit/de13d82d6a70f1caf1de83457c1a209b0188c2d0))

### Bug Fixes

- **build:** exclude test files from explorer-ui production build ([df63d4d](https://github.com/ALLiDoizCode/m2m/commit/df63d4dca56bb5f9af2c42a6291afca41236d415))
- **explorer:** emit telemetry when receiving packet responses ([c923628](https://github.com/ALLiDoizCode/m2m/commit/c923628676fef98d2c4435a2aa5056ac77d6c2f4))
- **test:** set EXPLORER_PORT in mesh config tests to avoid port conflict ([c0cfed4](https://github.com/ALLiDoizCode/m2m/commit/c0cfed4e670e6da6dfc4129a2fba20523b2acea5))

## [1.1.0](https://github.com/ALLiDoizCode/m2m/compare/v1.0.0...v1.1.0) (2026-01-24)

### Features

- **agent:** implement Agent Society Protocol stories 13.3-13.8 ([cb4e0a4](https://github.com/ALLiDoizCode/m2m/commit/cb4e0a4acfcd8aaf2acf59e8caa443b71305fdec))
- **agent:** implement TOON codec and event database (Epic 13) ([2d70a20](https://github.com/ALLiDoizCode/m2m/commit/2d70a20dd2a82c1ca48367f58dc9d4684a4e3b5e))

### Bug Fixes

- Increase HEAP_MB threshold to 1000 for CI variability ([5d6b189](https://github.com/ALLiDoizCode/m2m/commit/5d6b18998c0568aa79c502fe81c9636649c98146))
- Increase slope threshold to 10 for CI memory test variability ([e5e093b](https://github.com/ALLiDoizCode/m2m/commit/e5e093b365148341aed7eb6837380c01348221d1))

## 1.0.0 (2026-01-23)

### Features

- Add agent wallet balance tracking and monitoring (Story 11.3) ([87979ec](https://github.com/ALLiDoizCode/m2m/commit/87979ec5b7dbb77cf114dcd70c99075b9538e09c))
- Add automated agent wallet funding (Story 11.4) ([0be5045](https://github.com/ALLiDoizCode/m2m/commit/0be5045dca9b54b6703a481f2726fd661138a1cb))
- Add HD wallet master seed management (Story 11.1) ([1bc688e](https://github.com/ALLiDoizCode/m2m/commit/1bc688ee32bf8b0822d6ad3bf2156651b8234f34))
- Add test utilities for isolation and mock factories ([398ed8a](https://github.com/ALLiDoizCode/m2m/commit/398ed8ace56686b564e2d0a9e471a4c0fefc9326))
- Complete audit logging, environment config, and comprehensive tests (Story 12.2) ([054a3f9](https://github.com/ALLiDoizCode/m2m/commit/054a3f9b0bfb2b7f3f992aedb51de2f97bfdeb96))
- Complete Epic 12 Stories 12.3, 12.4, 12.5 - Security and Performance ([22fead2](https://github.com/ALLiDoizCode/m2m/commit/22fead2a27b2904e09a9c40a840bba83177b10dd))
- Complete Epic 12 Stories 12.6-12.9 - Production Infrastructure & Documentation ([a250dc1](https://github.com/ALLiDoizCode/m2m/commit/a250dc11a9be4c73f66f90338f02f1b04968c76a))
- Complete Stories 8.6-8.10 - Payment Channel SDK and Dashboard Visualization ([b7b839f](https://github.com/ALLiDoizCode/m2m/commit/b7b839f193589e631565e41d1d0cf1194a833293))
- Complete Story 11.10 - Agent Wallet Documentation with QA Review ([88b9456](https://github.com/ALLiDoizCode/m2m/commit/88b94569b62d55494952c53acea38e947d46aa06))
- Complete Story 11.5 - Agent Wallet Lifecycle Management ([a65d750](https://github.com/ALLiDoizCode/m2m/commit/a65d7501b7bf249537a610cc14638f5a730ffe78))
- Complete Story 12.10 and create Story 13.1 draft ([8af827b](https://github.com/ALLiDoizCode/m2m/commit/8af827b2b69518e209f97643bf809ba7ee340a99))
- Complete Story 8.2 - TokenNetworkRegistry smart contract with QA review ([ca5aaa3](https://github.com/ALLiDoizCode/m2m/commit/ca5aaa38284d736be4a87b8e4a177887c4601515))
- Epic 10 CI/CD Pipeline Reliability (Stories 10.1-10.3) ([8d8324a](https://github.com/ALLiDoizCode/m2m/commit/8d8324a1c161a76490cdb9338774cc55dafe020e))
- **epic-11:** Complete Story 11.6 - Payment Channel Integration for Agent Wallets ([09f8411](https://github.com/ALLiDoizCode/m2m/commit/09f8411eaab7879bfa70e96891769030bda74aa9))
- Implement Epic 9 - XRP Payment Channels Integration ([235acb5](https://github.com/ALLiDoizCode/m2m/commit/235acb5f89f6dea62ef6ca2e255b7a14df26f715))
- Implement HSM/KMS key management and automated rotation (Story 12.2 Tasks 5-6) ([c090361](https://github.com/ALLiDoizCode/m2m/commit/c0903614918fd32e0679f115e7722485d8ac3416))
- Implement TokenNetwork payment channels (Stories 8.3-8.5) ([c0cc270](https://github.com/ALLiDoizCode/m2m/commit/c0cc2708f1b7929676026275587bed94d31c82cd))

### Bug Fixes

- Add 30s default timeout to connector tests ([1ac45f6](https://github.com/ALLiDoizCode/m2m/commit/1ac45f66bca26f867164c65711d38397bfaf1ea5))
- Add BigInt serialization support in wallet-backup-manager tests ([3bc30ef](https://github.com/ALLiDoizCode/m2m/commit/3bc30ef00a90442258665926d709c155a6f3d264))
- Add build step to integration tests workflow before running tests ([f79c9bb](https://github.com/ALLiDoizCode/m2m/commit/f79c9bb51504232f95f48dd7bdc6997770b90f69))
- Add custom rippled config to bind RPC endpoints to 0.0.0.0 ([75e770c](https://github.com/ALLiDoizCode/m2m/commit/75e770c2986535dcee61455caeaf1560f363dbfd))
- Add explicit return types to all component functions ([1ff858b](https://github.com/ALLiDoizCode/m2m/commit/1ff858b2bdadf3565e498b9b6284f34bfb8adcdf))
- Add missing forge-std submodule to root .gitmodules ([1ca73c2](https://github.com/ALLiDoizCode/m2m/commit/1ca73c2d5c86734a579d9c7e8f4f17193a3be64e))
- Add missing TelemetryEvent import to telemetry-server ([19eb0bb](https://github.com/ALLiDoizCode/m2m/commit/19eb0bbc827656efd3688027622372a4c448191e))
- Add missing variables and fix method names in additional test cases ([80b37b7](https://github.com/ALLiDoizCode/m2m/commit/80b37b7919ccf3fdcf45b736a450ebefd425d587))
- Add test isolation cleanup in wallet-disaster-recovery tests ([85fbb6d](https://github.com/ALLiDoizCode/m2m/commit/85fbb6dd964c0176b7e370127eb5ba69d4e0af87))
- Add type assertions in logger.test.ts for signer property access ([2c8dd35](https://github.com/ALLiDoizCode/m2m/commit/2c8dd3578a170f94e542525fad9e49f2ca45500a))
- Add type assertions to resolve TypeScript compilation errors ([6149071](https://github.com/ALLiDoizCode/m2m/commit/6149071a34e2b1bba5e67664330d9e2405a5bdd5))
- Add type definitions and null checks to wallet disaster recovery test ([839b7c8](https://github.com/ALLiDoizCode/m2m/commit/839b7c8b58ccf636af1a6880b684d63a6a2ddd7f))
- Add type guard for req.account in mock implementation ([0a80060](https://github.com/ALLiDoizCode/m2m/commit/0a80060151959f96578d3376a516b8eab46ef11c))
- Adjust dashboard coverage thresholds to current levels ([f385fc5](https://github.com/ALLiDoizCode/m2m/commit/f385fc5159ab92829f1bdf901094abe46394484e))
- Adjust latency test threshold for timer resolution variance ([790be5e](https://github.com/ALLiDoizCode/m2m/commit/790be5e03604c9d68b13890e768260f447c4c84a))
- Adjust performance test thresholds for CI environment variability ([c9ae928](https://github.com/ALLiDoizCode/m2m/commit/c9ae9289a0b479358847d706ae5009e5f422ede8))
- Cast TelemetryMessage to TelemetryEvent for handler methods ([65507f5](https://github.com/ALLiDoizCode/m2m/commit/65507f584fff9e476ca6f9e2d18b78766ac02af4))
- Configure OpenZeppelin contracts as Git submodule ([16baac7](https://github.com/ALLiDoizCode/m2m/commit/16baac707fdc94b76ddd8dfda0da1aed1a2a6ab7))
- Correct Anvil command format to listen on all interfaces ([83fbab4](https://github.com/ALLiDoizCode/m2m/commit/83fbab4898603c0dad82f08b4f30c9e77231ce4c))
- Correct AWS KMS SDK enum values and TypeScript errors ([bd8b36c](https://github.com/ALLiDoizCode/m2m/commit/bd8b36cf968e7032c79a8df7234a94a3098ca0a4))
- Create peer agents in channel state restore test ([f323cea](https://github.com/ALLiDoizCode/m2m/commit/f323ceaede8ba35443d5e81661a245b256098981))
- Disable dashboard coverage thresholds and add testing guidelines ([2894ca0](https://github.com/ALLiDoizCode/m2m/commit/2894ca040a24183c46eb5652c4f7b367d299b115))
- Exclude cloud KMS backend tests from Jest runs ([c1bc3ab](https://github.com/ALLiDoizCode/m2m/commit/c1bc3ab3c02b5e292abdeb4226cfa49c787b1406))
- Fix another timing-sensitive assertion in token-bucket test ([8c7d577](https://github.com/ALLiDoizCode/m2m/commit/8c7d5776deb38ceb98fac39d20add28addde3409))
- Fix CI test failures in integration tests ([5099d7a](https://github.com/ALLiDoizCode/m2m/commit/5099d7ab2a1aece9752b8d57257d0b22c6159343))
- Fix ESLint errors and RFC link test failures in CI ([a8488e2](https://github.com/ALLiDoizCode/m2m/commit/a8488e2ea602c7866844051a68b4c2626f842619))
- Fix timing variance in concurrent measurements test ([085baba](https://github.com/ALLiDoizCode/m2m/commit/085baba4e04102f62c7339070445f4b806bb2138))
- Fix timing variance in getAvailableTokens test ([10aa092](https://github.com/ALLiDoizCode/m2m/commit/10aa09278db15004463b75ec095049cc891aa880))
- Fix TypeScript errors and test failures in XRP test files ([a0f806a](https://github.com/ALLiDoizCode/m2m/commit/a0f806a5c1b46c06c3a59ac7b83fcd0b447722a0))
- Fix TypeScript errors in XRP test files and update fix-ci command ([8c7acc0](https://github.com/ALLiDoizCode/m2m/commit/8c7acc03635082ba4cbcd6c6689a45c22cae6407))
- Fix TypeScript type errors in agent-balance-tracking integration test ([e04d3a0](https://github.com/ALLiDoizCode/m2m/commit/e04d3a00169972dedbf59618c9e95a52d44c389a))
- Increase Anvil startup timeout to prevent CI failures ([206d66b](https://github.com/ALLiDoizCode/m2m/commit/206d66b1c46735b514e58e5a34ccebbb7e546000))
- Increase HEAP_MB threshold to 1000 for CI variability ([ba580ef](https://github.com/ALLiDoizCode/m2m/commit/ba580ef5fdf8343a48a15ec475524d01f0e71385))
- Lower dashboard coverage thresholds to match Story 8.10 baseline ([5bdeebe](https://github.com/ALLiDoizCode/m2m/commit/5bdeebe1f8969f6cf337eeb333d7d5be3f700ae0))
- Make timing-safe comparison test more robust for CI ([24ad104](https://github.com/ALLiDoizCode/m2m/commit/24ad104f6e70111ac5d88e358ce00fab637f7dc7))
- Override Anvil entrypoint to ensure --host 0.0.0.0 is respected ([39f8569](https://github.com/ALLiDoizCode/m2m/commit/39f85692d00e82139d8a7b9e3c32295a4a2e8686))
- Properly narrow unknown types in type guards ([3fd76b8](https://github.com/ALLiDoizCode/m2m/commit/3fd76b83b6823c3f7d3f9f63186fe8dd5ec298ee))
- Relax performance assertion in agent-wallet-uniqueness test ([2ce1ae2](https://github.com/ALLiDoizCode/m2m/commit/2ce1ae2d2cf7f2f70da42a560849ff3bccd2ef34))
- Remove explicit --conf argument for rippled (entrypoint adds it automatically) ([2708684](https://github.com/ALLiDoizCode/m2m/commit/2708684d48a512cd3c0db420d672101e0abd8bd7))
- Replace Docker healthchecks with runner-based connectivity tests ([ac9aaf6](https://github.com/ALLiDoizCode/m2m/commit/ac9aaf6f4e93521350c35822540894b962f8a14f))
- Resolve CI test failures and update Docker Compose to V2 ([3730dad](https://github.com/ALLiDoizCode/m2m/commit/3730dad45b7d7479ae380e7dc5487834cc63ca25))
- Resolve CI test failures in Epic 11 ([3117780](https://github.com/ALLiDoizCode/m2m/commit/31177808296f1b66117bf182c4bafd126811ba02))
- Resolve ESLint errors in wallet integration tests ([896277f](https://github.com/ALLiDoizCode/m2m/commit/896277f734e9a37f7fa74ef2a7ffd27320d6b217))
- Resolve ESLint no-explicit-any and no-var-requires errors ([c08d64e](https://github.com/ALLiDoizCode/m2m/commit/c08d64eebff481ce6ebc91dbef068405f6bd72a2))
- Resolve integration test failures in CI ([184b57e](https://github.com/ALLiDoizCode/m2m/commit/184b57e25b2438d00c4629f8f6d88c9c7cd5de45))
- Resolve integration test failures in CI ([7174a59](https://github.com/ALLiDoizCode/m2m/commit/7174a595728ec3fae79954bff9204e5599ba5dae))
- Resolve test failures in wallet-backup-manager and doc tests ([90931ea](https://github.com/ALLiDoizCode/m2m/commit/90931ea6346a9792e8cc3fe053ecbdfe56ae790e))
- Resolve TypeScript and test failures in wallet components ([7385b0d](https://github.com/ALLiDoizCode/m2m/commit/7385b0d4da899e0fe48a522c978ea0f91f48c94c))
- Resolve TypeScript compilation errors in wallet-backup-manager ([8601d17](https://github.com/ALLiDoizCode/m2m/commit/8601d17361d834b2c778642e26c60562b5748151))
- Resolve TypeScript errors and test failures in CI ([eaa7bd7](https://github.com/ALLiDoizCode/m2m/commit/eaa7bd7fd87833edad27bac2b48400e94830486c))
- Resolve TypeScript errors and test failures in wallet components ([a9c10e0](https://github.com/ALLiDoizCode/m2m/commit/a9c10e0fd670645c260db3617e7600b2b31f07f1))
- Skip flaky XRP integration tests in CI environment ([631e5f8](https://github.com/ALLiDoizCode/m2m/commit/631e5f862f1631f29ae6083d62b8f4d55a857d95))
- Skip heavy wallet derivation tests in CI and fix TypeScript errors ([58787ea](https://github.com/ALLiDoizCode/m2m/commit/58787ea455130322930ee89fe8b150550fddac42))
- Sync package-lock.json with package.json ([a91d57a](https://github.com/ALLiDoizCode/m2m/commit/a91d57a3765d1beca0f5c38a2f85a93051f3e9cd))
- Synchronize package-lock.json with package.json ([355d8ce](https://github.com/ALLiDoizCode/m2m/commit/355d8ce0cd029b03311c1af57466a19676c17f3b))
- Update integration tests to use docker-compose-dev infrastructure ([e0f0a08](https://github.com/ALLiDoizCode/m2m/commit/e0f0a087bcbd693599aee2c7fd04d1cac864ceb6))
- Update test files for changed constructor signatures ([193b161](https://github.com/ALLiDoizCode/m2m/commit/193b1612256ebb4c37f9473bc057a7fc7e223bbd))
- Update test files to use current API signatures ([004779f](https://github.com/ALLiDoizCode/m2m/commit/004779f343e01c8f0c44ea95027000c0b47f977f))
- Use block eslint-disable for test mock setup ([1855b7e](https://github.com/ALLiDoizCode/m2m/commit/1855b7e6dc8a4e5cdd4108f8d8f59df9bab43d07))
- Use full path for tigerbeetle command in init script ([2240b5d](https://github.com/ALLiDoizCode/m2m/commit/2240b5d4ae0505600360e7f4cd68ad5f0f6774c0))
- Wait for all 3 services to be healthy before running integration tests ([b438ffe](https://github.com/ALLiDoizCode/m2m/commit/b438ffe91ebf6b016301887f3b3d797fd448aec3))

### Code Refactoring

- Remove dashboard package and defer visualization to future project ([43334b6](https://github.com/ALLiDoizCode/m2m/commit/43334b61a52c5533e34b7f183b2ca67ee3fd0fd4))

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
