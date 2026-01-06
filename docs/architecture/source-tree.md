# Source Tree

```
m2m/                                  # Monorepo root
├── packages/
│   ├── connector/                    # ILP Connector service
│   │   ├── src/
│   │   │   ├── core/
│   │   │   │   ├── connector-node.ts      # Main ConnectorNode orchestrator
│   │   │   │   ├── packet-handler.ts      # ILP packet processing logic
│   │   │   │   └── routing-table.ts       # Routing table implementation
│   │   │   ├── btp/
│   │   │   │   ├── btp-server.ts          # BTP WebSocket server
│   │   │   │   ├── btp-client.ts          # BTP WebSocket client
│   │   │   │   ├── btp-client-manager.ts  # Peer connection manager
│   │   │   │   └── btp-message-parser.ts  # BTP protocol encoding/decoding
│   │   │   ├── telemetry/
│   │   │   │   └── telemetry-emitter.ts   # Dashboard telemetry client
│   │   │   ├── config/
│   │   │   │   └── config-loader.ts       # YAML config loading
│   │   │   ├── http/
│   │   │   │   └── health-server.ts       # Express health check endpoint
│   │   │   ├── utils/
│   │   │   │   └── logger.ts              # Pino logger configuration
│   │   │   └── index.ts                   # Connector entry point
│   │   ├── test/
│   │   │   ├── unit/
│   │   │   │   ├── packet-handler.test.ts
│   │   │   │   ├── routing-table.test.ts
│   │   │   │   └── btp-message-parser.test.ts
│   │   │   └── integration/
│   │   │       └── multi-node-forwarding.test.ts
│   │   ├── Dockerfile                     # Connector container build
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── contracts/                    # Smart contracts (Foundry - Epic 8)
│   │   ├── src/                            # Solidity contract source
│   │   │   ├── MockERC20.sol               # Test ERC20 token (Story 8.1)
│   │   │   ├── TokenNetworkRegistry.sol    # Factory for TokenNetwork contracts (Story 8.2)
│   │   │   └── TokenNetwork.sol            # Payment channel contract (Story 8.3)
│   │   ├── script/                         # Deployment scripts (.s.sol)
│   │   │   └── Deploy.s.sol                # Multi-environment deployment (local/testnet/mainnet)
│   │   ├── test/                           # Foundry tests (.t.sol)
│   │   │   ├── Deploy.t.sol                # Deployment verification tests
│   │   │   ├── Integration.t.sol           # Integration tests
│   │   │   ├── TokenNetworkRegistry.t.sol  # Registry unit tests (Story 8.2)
│   │   │   └── TokenNetwork.t.sol          # TokenNetwork unit tests (Story 8.3)
│   │   ├── lib/                            # Foundry dependencies
│   │   │   ├── forge-std/                  # Foundry standard library
│   │   │   └── openzeppelin-contracts/     # OpenZeppelin v5.5.0 library
│   │   ├── out/                            # Compiled contract artifacts (gitignored)
│   │   ├── cache/                          # Foundry build cache (gitignored)
│   │   ├── broadcast/                      # Deployment transaction logs
│   │   ├── foundry.toml                    # Foundry configuration (Solidity 0.8.20)
│   │   ├── remappings.txt                  # Import path remappings
│   │   ├── .gitignore                      # Ignore out/, cache/, broadcast/
│   │   ├── package.json                    # npm scripts (build, test, deploy)
│   │   └── README.md                       # Smart contract development guide
│   │
│   ├── dashboard/                    # Visualization dashboard
│   │   ├── server/
│   │   │   ├── telemetry-server.ts        # WebSocket telemetry aggregator
│   │   │   ├── http-server.ts             # Express static file server
│   │   │   └── index.ts                   # Dashboard backend entry point
│   │   ├── src/                           # React UI source
│   │   │   ├── components/
│   │   │   │   ├── NetworkGraph.tsx       # Cytoscape.js network visualization
│   │   │   │   ├── PacketAnimation.tsx    # Animated packet flow layer
│   │   │   │   ├── LogViewer.tsx          # Filterable log display
│   │   │   │   ├── PacketDetailPanel.tsx  # Packet inspection panel
│   │   │   │   └── NodeDetailPanel.tsx    # Connector status panel
│   │   │   ├── hooks/
│   │   │   │   ├── useTelemetry.ts        # WebSocket telemetry hook
│   │   │   │   └── useNetworkGraph.ts     # Cytoscape graph state
│   │   │   ├── types/
│   │   │   │   └── telemetry.ts           # UI-specific types
│   │   │   ├── App.tsx                    # Main React app
│   │   │   ├── main.tsx                   # Vite entry point
│   │   │   └── index.css                  # Tailwind imports
│   │   ├── public/
│   │   │   └── index.html
│   │   ├── test/
│   │   │   └── components/
│   │   │       ├── NetworkGraph.test.tsx
│   │   │       └── LogViewer.test.tsx
│   │   ├── Dockerfile                     # Dashboard container build
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   └── tailwind.config.js
│   │
│   └── shared/                       # Shared TypeScript types and utilities
│       ├── src/
│       │   ├── types/
│       │   │   ├── ilp.ts                 # ILP packet type definitions
│       │   │   ├── btp.ts                 # BTP message types
│       │   │   ├── routing.ts             # Routing table types
│       │   │   └── telemetry.ts           # Telemetry event types
│       │   ├── encoding/
│       │   │   └── oer.ts                 # OER encoder/decoder implementation
│       │   ├── validation/
│       │   │   └── ilp-address.ts         # ILP address validation (RFC-0015)
│       │   └── index.ts                   # Shared package exports
│       ├── test/
│       │   ├── encoding/
│       │   │   └── oer.test.ts            # OER encoding test vectors
│       │   └── validation/
│       │       └── ilp-address.test.ts
│       ├── package.json
│       └── tsconfig.json
│
├── tools/                            # CLI utilities
│   └── send-packet/
│       ├── src/
│       │   └── index.ts                   # Test packet sender CLI
│       ├── package.json
│       └── tsconfig.json
│
├── docker/                           # Docker configurations
│   ├── docker-compose.yml                 # Default 3-node linear topology
│   ├── docker-compose.mesh.yml            # 4-node mesh topology
│   └── docker-compose.custom.yml          # Custom topology template
│
├── examples/                         # Example topology configurations
│   ├── linear-3-nodes.yaml                # Linear chain topology config
│   ├── mesh-4-nodes.yaml                  # Full mesh topology config
│   └── hub-spoke.yaml                     # Hub-and-spoke topology config
│
├── docs/                             # Documentation
│   ├── architecture.md                    # This file
│   ├── prd.md                             # Product requirements
│   ├── brief.md                           # Project brief
│   └── rfcs/                              # Copied relevant Interledger RFCs
│       ├── rfc-0027-ilpv4.md
│       ├── rfc-0023-btp.md
│       └── rfc-0030-oer.md
│
├── .github/
│   └── workflows/
│       ├── ci.yml                         # GitHub Actions CI pipeline
│       └── docker-build.yml               # Docker image build workflow
│
├── package.json                      # Root package.json (workspaces)
├── tsconfig.base.json                # Shared TypeScript configuration
├── .eslintrc.json                    # ESLint configuration
├── .prettierrc.json                  # Prettier configuration
├── .gitignore
├── README.md                         # Project overview and quick start
├── CONTRIBUTING.md                   # Contribution guidelines
├── LICENSE                           # MIT or Apache 2.0 license
└── CHANGELOG.md                      # Version history
```

**Key Directory Decisions:**

1. **Monorepo with npm workspaces:** Simplifies dependency management and type sharing
2. **Clear package boundaries:** `connector`, `dashboard`, `shared` are independently buildable
3. **Co-located tests:** Test files alongside source for better discoverability
4. **Docker configs at root:** Easier access for `docker-compose up`
5. **Examples directory:** Pre-configured topologies for quick experimentation
6. **Tools separate:** CLI utilities independent of main packages
