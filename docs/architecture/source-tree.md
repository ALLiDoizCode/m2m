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
│   │   │   │   ├── telemetry-emitter.ts   # Telemetry event emission
│   │   │   │   ├── telemetry-buffer.ts    # Event buffering for high throughput
│   │   │   │   └── types.ts               # Telemetry message types
│   │   │   ├── agent/                     # Agent Society Protocol (Epic 13)
│   │   │   │   ├── event-database.ts      # libSQL Nostr event storage
│   │   │   │   ├── toon-codec.ts          # TOON encoder/decoder
│   │   │   │   ├── agent-config.ts        # Agent configuration schema
│   │   │   │   ├── agent-node.ts          # Main AgentNode orchestrator
│   │   │   │   ├── event-handler.ts       # Kind-based event dispatch
│   │   │   │   ├── follow-graph-router.ts # Nostr follow-based routing
│   │   │   │   ├── subscription-manager.ts # Event subscription matching
│   │   │   │   ├── handlers/              # Built-in event kind handlers
│   │   │   │   │   ├── note-handler.ts    # Kind 1 note storage
│   │   │   │   │   ├── follow-handler.ts  # Kind 3 follow updates
│   │   │   │   │   ├── delete-handler.ts  # Kind 5 event deletion
│   │   │   │   │   └── query-handler.ts   # Kind 10000 query service
│   │   │   │   ├── ai/                    # AI Agent Module (Epic 16)
│   │   │   │   │   ├── ai-agent-config.ts       # AI config types and parsing
│   │   │   │   │   ├── ai-agent-dispatcher.ts   # Core AI event dispatcher
│   │   │   │   │   ├── provider-factory.ts      # AI SDK model factory
│   │   │   │   │   ├── skill-registry.ts        # Skill registration and management
│   │   │   │   │   ├── system-prompt.ts         # System prompt builder
│   │   │   │   │   ├── token-budget.ts          # Rolling window token budget
│   │   │   │   │   ├── skills/                  # Agent skills (AI SDK tools)
│   │   │   │   │   │   ├── store-note-skill.ts  # Kind 1 skill
│   │   │   │   │   │   ├── update-follow-skill.ts # Kind 3 skill
│   │   │   │   │   │   ├── delete-events-skill.ts # Kind 5 skill
│   │   │   │   │   │   ├── query-events-skill.ts  # Kind 10000 skill
│   │   │   │   │   │   ├── forward-packet-skill.ts # Packet forwarding skill
│   │   │   │   │   │   └── get-agent-info-skill.ts # Agent introspection skill
│   │   │   │   │   └── __tests__/               # AI module tests
│   │   │   │   └── index.ts               # Agent module exports
│   │   │   ├── explorer/                  # Packet/Event Explorer (Epic 14)
│   │   │   │   ├── event-store.ts         # libSQL telemetry event storage
│   │   │   │   ├── event-store.test.ts    # EventStore unit tests
│   │   │   │   └── index.ts               # Explorer module exports
│   │   │   ├── settlement/
│   │   │   │   ├── unified-settlement-executor.ts  # Dual-settlement router
│   │   │   │   ├── xrp-channel-lifecycle-manager.ts  # XRP channel lifecycle
│   │   │   │   └── settlement-monitor.ts  # Balance monitoring
│   │   │   ├── wallet/
│   │   │   │   ├── agent-wallet.ts        # Agent wallet implementation
│   │   │   │   └── wallet-db-schema.ts    # Wallet database schema
│   │   │   ├── config/
│   │   │   │   └── config-loader.ts       # YAML config loading
│   │   │   ├── http/
│   │   │   │   └── health-server.ts       # Express health check endpoint
│   │   │   ├── utils/
│   │   │   │   └── logger.ts              # Pino logger configuration
│   │   │   └── index.ts                   # Connector entry point
│   │   ├── explorer-ui/                   # Explorer UI Frontend (Epic 14)
│   │   │   ├── src/
│   │   │   │   ├── App.tsx                # Main application component
│   │   │   │   ├── main.tsx               # React entry point
│   │   │   │   ├── index.css              # Tailwind + shadcn theme
│   │   │   │   ├── components/
│   │   │   │   │   ├── EventTable.tsx     # Event streaming table
│   │   │   │   │   ├── Header.tsx         # Header with node ID
│   │   │   │   │   └── ui/                # shadcn/ui components
│   │   │   │   ├── hooks/
│   │   │   │   │   ├── useEventStream.ts  # WebSocket connection hook
│   │   │   │   │   └── useEventStream.test.ts
│   │   │   │   └── lib/
│   │   │   │       ├── event-types.ts     # Frontend telemetry types
│   │   │   │       └── utils.ts           # shadcn cn() helper
│   │   │   ├── index.html
│   │   │   ├── vite.config.ts
│   │   │   ├── tailwind.config.js
│   │   │   ├── tsconfig.json
│   │   │   └── package.json               # Standalone package (not workspace)
│   │   ├── test/
│   │   │   ├── unit/
│   │   │   │   ├── packet-handler.test.ts
│   │   │   │   ├── routing-table.test.ts
│   │   │   │   └── btp-message-parser.test.ts
│   │   │   └── integration/
│   │   │       ├── multi-node-forwarding.test.ts
│   │   │       ├── agent-channel-integration.test.ts
│   │   │       └── telemetry-event-store.test.ts  # EventStore integration (Epic 14)
│   │   ├── Dockerfile                     # Connector container build
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/                       # Shared TypeScript types and utilities
│       ├── src/
│       │   ├── types/
│       │   │   ├── ilp.ts                 # ILP packet type definitions
│       │   │   ├── btp.ts                 # BTP message types
│       │   │   ├── routing.ts             # Routing table types
│       │   │   ├── telemetry.ts           # Telemetry event types
│       │   │   └── payment-channel-telemetry.ts  # Payment channel telemetry types
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
2. **Clear package boundaries:** `connector`, `shared` are independently buildable
3. **Co-located tests:** Test files alongside source for better discoverability
4. **Docker configs at root:** Easier access for `docker-compose up`
5. **Examples directory:** Pre-configured topologies for quick experimentation
6. **Tools separate:** CLI utilities independent of main packages
7. **Explorer UI standalone:** `explorer-ui/` is a nested package with its own dependencies (not a workspace)

**Note:** Dashboard package removed - visualization deferred. See DASHBOARD-DEFERRED.md in root.
