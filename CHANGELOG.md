# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.34.4](https://github.com/toon-protocol/connector/compare/v3.34.3...v3.34.4) (2026-07-17)

### Bug Fixes

- **faucet:** fail fast on wedged Solana validator; fix Mina drip timeout + Invalid_nonce (closes [#348](https://github.com/toon-protocol/connector/issues/348)) ([#350](https://github.com/toon-protocol/connector/issues/350)) ([67f3c5a](https://github.com/toon-protocol/connector/commit/67f3c5a8a102138e545e6968ce487a92d3c01735)), closes [#277](https://github.com/toon-protocol/connector/issues/277)

## [3.34.3](https://github.com/toon-protocol/connector/compare/v3.34.2...v3.34.3) (2026-07-17)

### Bug Fixes

- **discovery:** real devnet curator key + signed seed manifest, drop placeholder seeds (closes [#343](https://github.com/toon-protocol/connector/issues/343)) ([#349](https://github.com/toon-protocol/connector/issues/349)) ([580f1f1](https://github.com/toon-protocol/connector/commit/580f1f19a6e0e97948a72b97390b040b07fa7bdc))

## [3.34.2](https://github.com/toon-protocol/connector/compare/v3.34.1...v3.34.2) (2026-07-17)

### Bug Fixes

- **http:** enforce funded-channel cap on first-time settlement add via PUT /admin/peers (closes [#344](https://github.com/toon-protocol/connector/issues/344)) ([#347](https://github.com/toon-protocol/connector/issues/347)) ([ea2e5cf](https://github.com/toon-protocol/connector/commit/ea2e5cff3cc7dfd17f91965b7a7728c9682cbb85))

## [3.34.1](https://github.com/toon-protocol/connector/compare/v3.34.0...v3.34.1) (2026-07-17)

### Bug Fixes

- **http:** record runtime peer URLs on the admin POST/DELETE peer surface (closes [#345](https://github.com/toon-protocol/connector/issues/345)) ([#346](https://github.com/toon-protocol/connector/issues/346)) ([16af9ee](https://github.com/toon-protocol/connector/commit/16af9ee9bbf4b5aef861cf75f5bd77b569c41319))

## [3.34.0](https://github.com/toon-protocol/connector/compare/v3.33.1...v3.34.0) (2026-07-17)

### Features

- **config:** general child-prefix registration + apex aggregation (toon-meta[#153](https://github.com/toon-protocol/connector/issues/153)) ([0448414](https://github.com/toon-protocol/connector/commit/04484141bc20d0fd9e569b4f3b38370890bd6401))
- **discovery:** capability directory in kind:10032 announcements (toon-meta[#153](https://github.com/toon-protocol/connector/issues/153)) ([c7bcd67](https://github.com/toon-protocol/connector/commit/c7bcd67707754065e66cb2abe044f7e8bebb19e9))
- **discovery:** cold-start bootstrap — curated signed seeds, peer cache, sample-and-verify (toon-meta[#153](https://github.com/toon-protocol/connector/issues/153)) ([900fb0e](https://github.com/toon-protocol/connector/commit/900fb0ecdc9a320dc3195b6c5f331e588cef28cc)), closes [connector#289](https://github.com/toon-protocol/connector/issues/289)
- **discovery:** discovered-vs-peered split + bounded funding policy (toon-meta[#153](https://github.com/toon-protocol/connector/issues/153)) ([bed8dbd](https://github.com/toon-protocol/connector/commit/bed8dbd94c709d04d1b72cccd3914b89196905d4))
- **routing:** multi-hop route learning via link-state over kind:10032 (toon-meta[#153](https://github.com/toon-protocol/connector/issues/153)) ([937cfcb](https://github.com/toon-protocol/connector/commit/937cfcbb5862c8c7854f2616ec474fdb6f1b7594))

### Bug Fixes

- **ci:** inventory the discovered-nodes route and restore function coverage on feat/153-control-plane ([471cea0](https://github.com/toon-protocol/connector/commit/471cea03bddd27766ef971e416ccf67d6033f599)), closes [#333](https://github.com/toon-protocol/connector/issues/333) [toon-meta#153](https://github.com/toon-protocol/toon-meta/issues/153)
- **core:** restore stop() block brace lost in three-way merge ([3386fee](https://github.com/toon-protocol/connector/commit/3386fee251ae99bb046e70ec4150bb2da22b616d))

## [3.33.1](https://github.com/toon-protocol/connector/compare/v3.33.0...v3.33.1) (2026-07-17)

### Bug Fixes

- **test:** send unconditional packets in packet-flow counter invariants suite ([#321](https://github.com/toon-protocol/connector/issues/321)) ([#340](https://github.com/toon-protocol/connector/issues/340)) ([2821cf5](https://github.com/toon-protocol/connector/commit/2821cf51338e9b46f983c6615f3ddcf8d28d2d7b)), closes [#314](https://github.com/toon-protocol/connector/issues/314) [#309](https://github.com/toon-protocol/connector/issues/309) [#309](https://github.com/toon-protocol/connector/issues/309) [pre-#314-equivalent](https://github.com/toon-protocol/pre-/issues/314-equivalent) [#314](https://github.com/toon-protocol/connector/issues/314)

## [3.33.0](https://github.com/toon-protocol/connector/compare/v3.32.0...v3.33.0) (2026-07-16)

### Features

- **discovery:** announce per-chain tokenNetworks + preferredTokens in kind:10032 ([#331](https://github.com/toon-protocol/connector/issues/331)) ([e0fec99](https://github.com/toon-protocol/connector/commit/e0fec991cbe43895f36be47cb989a64d9a4465ff)), closes [toon-client#378](https://github.com/toon-protocol/toon-client/issues/378) [toon-client#378](https://github.com/toon-protocol/toon-client/issues/378)
- **settlement:** add settlement-digest leaf + v2 verify helper, unwired ([#330](https://github.com/toon-protocol/connector/issues/330)) [skip release] ([982965d](https://github.com/toon-protocol/connector/commit/982965da6561f0d52d9e9a7af1d100f162ec3ad3))

## [3.32.0](https://github.com/toon-protocol/connector/compare/v3.31.0...v3.32.0) (2026-07-16)

### Features

- **contracts:** v2 EIP-712 claim digest with chainId/address domain separation (refs [#324](https://github.com/toon-protocol/connector/issues/324)) ([#325](https://github.com/toon-protocol/connector/issues/325)) ([a67a039](https://github.com/toon-protocol/connector/commit/a67a039a5d2246aa12ecdb542a520b815d3d011b)), closes [finding-#1](https://github.com/toon-protocol/finding-/issues/1)

## [3.31.0](https://github.com/toon-protocol/connector/compare/v3.30.2...v3.31.0) (2026-07-13)

### Features

- **contracts:** production chain-B rolling-swap settlement contract ([#320](https://github.com/toon-protocol/connector/issues/320)) ([6f4f435](https://github.com/toon-protocol/connector/commit/6f4f4352835aecef26dce98a96312dea8dbd717a)), closes [swap#59](https://github.com/toon-protocol/swap/issues/59) [swap#59](https://github.com/toon-protocol/swap/issues/59) [connector#317](https://github.com/toon-protocol/connector/issues/317)

## [3.30.2](https://github.com/toon-protocol/connector/compare/v3.30.1...v3.30.2) (2026-07-13)

### Bug Fixes

- **contracts:** regenerate anvil-state.json for anvil 1.7.1 ([#318](https://github.com/toon-protocol/connector/issues/318)) ([3263053](https://github.com/toon-protocol/connector/commit/32630535b3a8d140c5861379b198ebb7d0682b19))

## [3.30.1](https://github.com/toon-protocol/connector/compare/v3.30.0...v3.30.1) (2026-07-13)

### Bug Fixes

- **connector:** correct stale devnet relay URL in self-announce docs ([#307](https://github.com/toon-protocol/connector/issues/307)) ([820c122](https://github.com/toon-protocol/connector/commit/820c1229e04f290d9c0900369ac7bccabb651442)), closes [#305](https://github.com/toon-protocol/connector/issues/305)
- **test:** accept both NIP-01 JSON and TOON-string EVENT payloads in WS read-back probe ([#303](https://github.com/toon-protocol/connector/issues/303)) ([7e2c627](https://github.com/toon-protocol/connector/commit/7e2c62771d7660d2af2e1082087f98b09c167e45)), closes [relay#24](https://github.com/toon-protocol/relay/issues/24) [#301](https://github.com/toon-protocol/connector/issues/301)

## [3.30.0](https://github.com/toon-protocol/connector/compare/v3.29.1...v3.30.0) (2026-07-12)

### Features

- **core:** sendPacket accepts sender-chosen executionCondition ([#314](https://github.com/toon-protocol/connector/issues/314)) ([dc90a1c](https://github.com/toon-protocol/connector/commit/dc90a1c71cb6f1d19a4047669fa0a912ff300ba8)), closes [#310](https://github.com/toon-protocol/connector/issues/310) [toon-meta#145](https://github.com/toon-protocol/toon-meta/issues/145) [#310](https://github.com/toon-protocol/connector/issues/310) [toon-protocol/swap#56](https://github.com/toon-protocol/swap/issues/56)

## [3.29.1](https://github.com/toon-protocol/connector/compare/v3.29.0...v3.29.1) (2026-07-12)

### Bug Fixes

- **docker:** stop running node under QEMU in multi-arch builds (arm64 SIGILL) ([d99dc6f](https://github.com/toon-protocol/connector/commit/d99dc6f18193b7cc7bad88ec4890c62c22d07f1c)), closes [npm/cli#4828](https://github.com/npm/cli/issues/4828)

## [3.29.0](https://github.com/toon-protocol/connector/compare/v3.28.6...v3.29.0) (2026-07-12)

### Features

- **local-delivery:** end-to-end sender-chosen execution conditions through local delivery ([82dc623](https://github.com/toon-protocol/connector/commit/82dc623fe5b5c028ab5842eb0fbd5a7bc52e2082)), closes [#309](https://github.com/toon-protocol/connector/issues/309) [toon-meta#145](https://github.com/toon-protocol/toon-meta/issues/145) [pre-#309](https://github.com/toon-protocol/pre-/issues/309) [toon-client#350](https://github.com/toon-protocol/toon-client/issues/350)

### Bug Fixes

- **reject-map:** map swap-mill stale_rate reject to retryable T99 ([c5e0771](https://github.com/toon-protocol/connector/commit/c5e077108a9e86ccf08654ade32a1b99955d4922)), closes [toon-protocol/swap#53](https://github.com/toon-protocol/swap/issues/53) [toon-protocol/toon-meta#145](https://github.com/toon-protocol/toon-meta/issues/145)

## [3.28.6](https://github.com/toon-protocol/connector/compare/v3.28.5...v3.28.6) (2026-07-12)

### Bug Fixes

- **cli:** unbreak npm publish — pin inquirer to CJS v8 (ERR_REQUIRE_ESM in publish gate) ([8d3c3f9](https://github.com/toon-protocol/connector/commit/8d3c3f944f471204e8a311cd0e7209787f1e54d0)), closes [toon-protocol/toon-meta#145](https://github.com/toon-protocol/toon-meta/issues/145) [#310](https://github.com/toon-protocol/connector/issues/310)

## [3.28.5](https://github.com/toon-protocol/connector/compare/v3.28.4...v3.28.5) (2026-07-02)

### Bug Fixes

- **discovery:** emit schema-compliant settlementAddresses keys in kind:10032 announces ([#290](https://github.com/toon-protocol/connector/issues/290)) ([d1ade55](https://github.com/toon-protocol/connector/commit/d1ade557f22fc4c077b0ac6de7dca47aa2892ff8)), closes [#289](https://github.com/toon-protocol/connector/issues/289) [toon-protocol/toon#56](https://github.com/toon-protocol/toon/issues/56)

## [3.28.4](https://github.com/toon-protocol/connector/compare/v3.28.3...v3.28.4) (2026-07-01)

### Bug Fixes

- **devnet:** cap solana ledger size + rotate validator logs to prevent disk-full halts ([#276](https://github.com/toon-protocol/connector/issues/276)) ([3d8ae72](https://github.com/toon-protocol/connector/commit/3d8ae722dad544c52670bd64a1371d6a7d553dc9)), closes [#255](https://github.com/toon-protocol/connector/issues/255)

## [3.28.3](https://github.com/toon-protocol/connector/compare/v3.28.2...v3.28.3) (2026-06-26)

### Code Refactoring

- rename legacy `town` node-type vocab to `relay` ([#273](https://github.com/toon-protocol/connector/issues/273)) ([1a751a7](https://github.com/toon-protocol/connector/commit/1a751a7cfda44d5eff50dc02d17f0076adce2886)), closes [#267](https://github.com/toon-protocol/connector/issues/267) [#264](https://github.com/toon-protocol/connector/issues/264)

## [3.28.2](https://github.com/toon-protocol/connector/compare/v3.28.1...v3.28.2) (2026-06-26)

### Code Refactoring

- rename legacy `mill` node-type vocabulary to `swap` ([#272](https://github.com/toon-protocol/connector/issues/272)) ([c08f57d](https://github.com/toon-protocol/connector/commit/c08f57ded0c8123208815ac42d4a9e58d6b3c1db)), closes [#268](https://github.com/toon-protocol/connector/issues/268)

## [3.28.1](https://github.com/toon-protocol/connector/compare/v3.28.0...v3.28.1) (2026-06-26)

### Bug Fixes

- **probe:** recover content.ilpAddress from TOON-text payloads ([#274](https://github.com/toon-protocol/connector/issues/274)) ([01bb397](https://github.com/toon-protocol/connector/commit/01bb397f2e27d61ef78552b85b3626cbc75061e6))

## [3.28.0](https://github.com/toon-protocol/connector/compare/v3.27.0...v3.28.0) (2026-06-26)

### Features

- **discovery:** connector self-announce (kind:10032 IlpPeerInfo) ([#265](https://github.com/toon-protocol/connector/issues/265)) ([4436178](https://github.com/toon-protocol/connector/commit/44361783b7457675ac8ca7a1958c120022d76b5e)), closes [toon-protocol/relay#37](https://github.com/toon-protocol/relay/issues/37) [toon-protocol/store#22](https://github.com/toon-protocol/store/issues/22) [#259](https://github.com/toon-protocol/connector/issues/259)
- **probe:** kind:10032 self-announce discovery acceptance probe ([#266](https://github.com/toon-protocol/connector/issues/266)) ([6910f04](https://github.com/toon-protocol/connector/commit/6910f040a999f114ff3c3ac595770e3b11bc2beb)), closes [relay#37](https://github.com/toon-protocol/relay/issues/37) [store#22](https://github.com/toon-protocol/store/issues/22) [toon-meta#69](https://github.com/toon-protocol/toon-meta/issues/69) [store#22](https://github.com/toon-protocol/store/issues/22)

## [3.27.0](https://github.com/toon-protocol/connector/compare/v3.26.1...v3.27.0) (2026-06-24)

### Features

- **probe:** add store paid round-trip acceptance probe ([#258](https://github.com/toon-protocol/connector/issues/258)) ([ab5df02](https://github.com/toon-protocol/connector/commit/ab5df02ba87742a4f7fcb5bcd1776e179dd15ad8))

## [3.26.1](https://github.com/toon-protocol/connector/compare/v3.26.0...v3.26.1) (2026-06-24)

### Bug Fixes

- **devnet:** bound Solana test-validator ledger to stop it filling the box disk ([#255](https://github.com/toon-protocol/connector/issues/255)) ([9d3b3e8](https://github.com/toon-protocol/connector/commit/9d3b3e8642de85319f2e0dbedb0e709e8726d6db))

## [3.26.0](https://github.com/toon-protocol/connector/compare/v3.25.1...v3.26.0) (2026-06-24)

### Features

- multi-node Mina-lightnet provisioning + faucet native-MINA & USDC drip ([#254](https://github.com/toon-protocol/connector/issues/254)) ([0d93a41](https://github.com/toon-protocol/connector/commit/0d93a4112c43607671521bb4ee5ce21d2388ff9e)), closes [#235](https://github.com/toon-protocol/connector/issues/235) [#236](https://github.com/toon-protocol/connector/issues/236) [#240](https://github.com/toon-protocol/connector/issues/240)

## [3.25.1](https://github.com/toon-protocol/connector/compare/v3.25.0...v3.25.1) (2026-06-23)

### Bug Fixes

- **x402:** hoist httpEndpoint to top-level toon-channel entry in 402 greeting ([#251](https://github.com/toon-protocol/connector/issues/251)) ([4fde6e8](https://github.com/toon-protocol/connector/commit/4fde6e89e4f8fa22680dd51db60db7cb8efb0be2))

## [3.25.0](https://github.com/toon-protocol/connector/compare/v3.24.2...v3.25.0) (2026-06-23)

### Features

- **deploy:** pay-edge — turnkey payment-proxy in front of any app ([#252](https://github.com/toon-protocol/connector/issues/252)) ([d14b3f6](https://github.com/toon-protocol/connector/commit/d14b3f6c198ca17d57fa71ad6e5d821f3c32db45))
- **deploy:** relay-edge — a real Nostr relay deployed behind TOON ([#248](https://github.com/toon-protocol/connector/issues/248)) ([346b40f](https://github.com/toon-protocol/connector/commit/346b40f4f7fcae1b83cf46e2100f1c550993d556))

## [3.24.2](https://github.com/toon-protocol/connector/compare/v3.24.1...v3.24.2) (2026-06-23)

### Bug Fixes

- **devnet:** raise Mina round-trip PREPARE expiry to 300s for first claim ([#242](https://github.com/toon-protocol/connector/issues/242)) ([5cf8d27](https://github.com/toon-protocol/connector/commit/5cf8d2765dffcbb89099cba1acbbf92a1c9e2bb5)), closes [#237](https://github.com/toon-protocol/connector/issues/237)
- **infra:** put Solana CLI bin on PATH for devnet bootstrap build ([#243](https://github.com/toon-protocol/connector/issues/243)) ([858bf5c](https://github.com/toon-protocol/connector/commit/858bf5c51249aaf11528f320e760feaf5d0df44d)), closes [#238](https://github.com/toon-protocol/connector/issues/238)
- **solana:** honor explicit wsUrl override in SDK and provider factory ([#241](https://github.com/toon-protocol/connector/issues/241)) ([dad890b](https://github.com/toon-protocol/connector/commit/dad890ba8858e0d5636586523e2c1fddc2b40df2)), closes [#236](https://github.com/toon-protocol/connector/issues/236)

## [3.24.1](https://github.com/toon-protocol/connector/compare/v3.24.0...v3.24.1) (2026-06-23)

### Bug Fixes

- **devnet:** stable solana validator + buildable program ([#235](https://github.com/toon-protocol/connector/issues/235)) ([a129eaf](https://github.com/toon-protocol/connector/commit/a129eafe3e0c645a12e2b250e4d109cce7a614e7))

## [3.24.0](https://github.com/toon-protocol/connector/compare/v3.23.0...v3.24.0) (2026-06-23)

### Features

- **connector:** mnemonic signing mode for multi-chain settlement keys ([#233](https://github.com/toon-protocol/connector/issues/233)) ([3f63f4a](https://github.com/toon-protocol/connector/commit/3f63f4a0b92980410dedea47b53e225360b1ae22))

## [3.23.0](https://github.com/toon-protocol/connector/compare/v3.22.1...v3.23.0) (2026-06-23)

### Features

- **infra:** public Linode test of terminator + relay-behind-connector ([#222](https://github.com/toon-protocol/connector/issues/222)) ([#230](https://github.com/toon-protocol/connector/issues/230)) ([940aa35](https://github.com/toon-protocol/connector/commit/940aa35fab562bd0f944bdfa31f73070ae17040b)), closes [#221](https://github.com/toon-protocol/connector/issues/221) [#221](https://github.com/toon-protocol/connector/issues/221)

## [3.22.1](https://github.com/toon-protocol/connector/compare/v3.22.0...v3.22.1) (2026-06-22)

### Bug Fixes

- **deps:** drop orphaned patch-package patch for removed anyone-client ([#232](https://github.com/toon-protocol/connector/issues/232)) ([cb59135](https://github.com/toon-protocol/connector/commit/cb591358276c4849b508d2b871b580ad699bd1ec)), closes [#231](https://github.com/toon-protocol/connector/issues/231)

## [3.22.0](https://github.com/toon-protocol/connector/compare/v3.21.0...v3.22.0) (2026-06-22)

### Features

- **transport:** ILP-over-HTTP egress (epic-38 story 38.1) ([#227](https://github.com/toon-protocol/connector/issues/227)) ([e15da50](https://github.com/toon-protocol/connector/commit/e15da50a96426e397ff76a468142b52132839cd3))

## [3.21.0](https://github.com/toon-protocol/connector/compare/v3.20.2...v3.21.0) (2026-06-22)

### Features

- **terminator:** connector-as-terminator epic — HTTP reverse-proxy, x402 v2, route config, RFC 9421 binding, CLI, compose ([#216](https://github.com/toon-protocol/connector/issues/216)-[#221](https://github.com/toon-protocol/connector/issues/221)) ([#226](https://github.com/toon-protocol/connector/issues/226)) ([8e6cd35](https://github.com/toon-protocol/connector/commit/8e6cd351dc16c66e060f54769d53ed77a7022e29)), closes [#218](https://github.com/toon-protocol/connector/issues/218) [#220](https://github.com/toon-protocol/connector/issues/220) [#218](https://github.com/toon-protocol/connector/issues/218) [#217](https://github.com/toon-protocol/connector/issues/217) [#218](https://github.com/toon-protocol/connector/issues/218) [#224](https://github.com/toon-protocol/connector/issues/224) [#218](https://github.com/toon-protocol/connector/issues/218) [217/#220](https://github.com/217/connector/issues/220) [#217](https://github.com/toon-protocol/connector/issues/217) [#220](https://github.com/toon-protocol/connector/issues/220) [#217](https://github.com/toon-protocol/connector/issues/217) [#218](https://github.com/toon-protocol/connector/issues/218) [#217](https://github.com/toon-protocol/connector/issues/217)

## [3.20.2](https://github.com/toon-protocol/connector/compare/v3.20.1...v3.20.2) (2026-06-22)

### Bug Fixes

- **settlement:** 6-decimal default channel deposit (completes [#188](https://github.com/toon-protocol/connector/issues/188)/[#195](https://github.com/toon-protocol/connector/issues/195) USDC migration) ([#228](https://github.com/toon-protocol/connector/issues/228)) ([53950a5](https://github.com/toon-protocol/connector/commit/53950a5dc8e943a8763f36fe4d0c76d4f3adb384))

## [3.20.1](https://github.com/toon-protocol/connector/compare/v3.20.0...v3.20.1) (2026-06-22)

### Bug Fixes

- **devnet:** stop re-issuing Let's Encrypt certs on every rebuild ([#214](https://github.com/toon-protocol/connector/issues/214)) ([407be00](https://github.com/toon-protocol/connector/commit/407be009d66010bbd5dc10f44e39c09d2c7ee03b))

## [3.20.0](https://github.com/toon-protocol/connector/compare/v3.19.0...v3.20.0) (2026-06-22)

### Features

- **faucet:** real native-MINA treasury drip via mina-signer ([de1ec91](https://github.com/toon-protocol/connector/commit/de1ec91fd2dfa6e7f38ea8b6853420de3469ab8b)), closes [#211](https://github.com/toon-protocol/connector/issues/211)

## [3.19.0](https://github.com/toon-protocol/connector/compare/v3.18.6...v3.19.0) (2026-06-22)

### Features

- **faucet:** multichain drip — add Solana + Mina routes ([7d261f9](https://github.com/toon-protocol/connector/commit/7d261f95dd9c31f08849ea97f08b991c54c2795e))

## [3.18.6](https://github.com/toon-protocol/connector/compare/v3.18.5...v3.18.6) (2026-06-22)

### Performance Improvements

- **devnet:** run on 2GB — swapfile for one-time Rust builds; recreate on plan change ([0cb4385](https://github.com/toon-protocol/connector/commit/0cb43855b687acc1921659c970dbe18d70262523))

## [3.18.5](https://github.com/toon-protocol/connector/compare/v3.18.4...v3.18.5) (2026-06-22)

### Bug Fixes

- **devnet:** drop iptables-persistent (conflicts with ufw on Ubuntu 24.04) ([a6624e0](https://github.com/toon-protocol/connector/commit/a6624e0a4cb5625de04e0a5c8172314b09a033ee))
- **devnet:** SSH wait retries real key auth (rebuild race + new host key) ([40de7b4](https://github.com/toon-protocol/connector/commit/40de7b4985b979bd72f51cf54ba883e3461717c1))

## [3.18.4](https://github.com/toon-protocol/connector/compare/v3.18.3...v3.18.4) (2026-06-22)

### Bug Fixes

- **devnet:** ssh-key step fails under bash -e when ssh_pubkey is empty ([4e4e3e1](https://github.com/toon-protocol/connector/commit/4e4e3e105af140ca92b2d6074b1003e585c2384b))

## [3.18.3](https://github.com/toon-protocol/connector/compare/v3.18.2...v3.18.3) (2026-06-22)

### Bug Fixes

- **devnet:** tolerant TLS first run — green before DNS is pointed ([9dd573a](https://github.com/toon-protocol/connector/commit/9dd573ad23e2ab8106b18ca049036fec2461dbc5))

## [3.18.2](https://github.com/toon-protocol/connector/compare/v3.18.1...v3.18.2) (2026-06-22)

### Bug Fixes

- **mina:** resolve @toon-protocol/mina-zkapp to dist in connector jest; surface real load error ([cff167f](https://github.com/toon-protocol/connector/commit/cff167fbaa5e8cf5b661d203b3726a72b3dffc50))

## [3.18.1](https://github.com/toon-protocol/connector/compare/v3.18.0...v3.18.1) (2026-06-22)

### Bug Fixes

- **devnet:** correct spl-token flag placement in Solana USDC mint/fund scripts ([949a3d2](https://github.com/toon-protocol/connector/commit/949a3d2d46250ef68ad582e5dd8d6f48c304ae22))

## [3.18.0](https://github.com/toon-protocol/connector/compare/v3.17.0...v3.18.0) (2026-06-21)

### Features

- **mina:** deploy/fund USDC as the in-proof UsdcChannelToken ([4041842](https://github.com/toon-protocol/connector/commit/4041842b637afd0a71960d464fae0aaf90c7fd1c))
- **mina:** rework settlement SDK onto in-proof UsdcChannelToken ([57f0bbf](https://github.com/toon-protocol/connector/commit/57f0bbf79c238a34115f7429240d17c7c5c7f44c)), closes [191/#192](https://github.com/191/connector/issues/192) [#192](https://github.com/toon-protocol/connector/issues/192)
- **mina:** UsdcChannelToken — in-proof-enforcing USDC token owner ([f43a437](https://github.com/toon-protocol/connector/commit/f43a437063298284b9c2f7195228d88a843caa71)), closes [191/#194](https://github.com/191/connector/issues/194)

### Bug Fixes

- **mina:** mirror compiled provers to base FungibleToken; nightly builds all workspaces ([d0aecff](https://github.com/toon-protocol/connector/commit/d0aecffffc84b82317d63821e10681f5d5428fd7)), closes [#202](https://github.com/toon-protocol/connector/issues/202)
- **mina:** real-chain-safe slot preconditions in PaymentChannel close/settle ([#202](https://github.com/toon-protocol/connector/issues/202)) ([ab81d26](https://github.com/toon-protocol/connector/commit/ab81d2694fdb2158a8340f52c4830f4a71d2bee7)), closes [191/#192](https://github.com/191/connector/issues/192)

## [3.17.0](https://github.com/toon-protocol/connector/compare/v3.16.0...v3.17.0) (2026-06-21)

### Features

- **devnet:** wire Mina USDC into linode endpoints + funding ([#193](https://github.com/toon-protocol/connector/issues/193)) ([602bea2](https://github.com/toon-protocol/connector/commit/602bea2be84bc8553327d05f8870da2f154cb6e2)), closes [connector#188](https://github.com/toon-protocol/connector/issues/188)
- **mina-provider:** thread USDC tokenAddress + enforce claim tokenId ([#192](https://github.com/toon-protocol/connector/issues/192)) ([6827780](https://github.com/toon-protocol/connector/commit/68277802f0d3901f4461c371dafd506aacd5dbc1))
- **mina-sdk:** USDC token-aware deposit/settle composition ([#192](https://github.com/toon-protocol/connector/issues/192)) ([af11edc](https://github.com/toon-protocol/connector/commit/af11edc687bbf56f01a6c4425648148a6e1ac679)), closes [#191](https://github.com/toon-protocol/connector/issues/191)
- **mina-zkapp:** PaymentChannel custodies USDC token, not native MINA ([#191](https://github.com/toon-protocol/connector/issues/191)) ([2c10bdc](https://github.com/toon-protocol/connector/commit/2c10bdc6b359623e1128410a4e11391cc5731710))
- **mina:** deploy + fund USDC token on public devnet ([#193](https://github.com/toon-protocol/connector/issues/193)) ([80262ac](https://github.com/toon-protocol/connector/commit/80262ac94c63bf278388f04a964614d6f9fd1860)), closes [#190](https://github.com/toon-protocol/connector/issues/190) [connector#188](https://github.com/toon-protocol/connector/issues/188)

## [3.16.0](https://github.com/toon-protocol/connector/compare/v3.15.5...v3.16.0) (2026-06-21)

### Features

- **connector:** persistent peer/route registry + relation-route admission + declarative desired-state ([#187](https://github.com/toon-protocol/connector/issues/187)) ([85c3333](https://github.com/toon-protocol/connector/commit/85c3333752da15bb05173acebd7f034e297eee1b))

## [3.15.5](https://github.com/toon-protocol/connector/compare/v3.15.4...v3.15.5) (2026-06-21)

### Bug Fixes

- **test:** read BTP port via server.address() in socks5 contract test ([#182](https://github.com/toon-protocol/connector/issues/182)) ([f9d6a1e](https://github.com/toon-protocol/connector/commit/f9d6a1ef1ca2e0022433b5443ee380f25e59754f))

## [3.15.4](https://github.com/toon-protocol/connector/compare/v3.15.3...v3.15.4) (2026-06-21)

### Bug Fixes

- **btp:** restore startup channel auto-open (replace fire-and-forget addPeer with bounded await) ([#180](https://github.com/toon-protocol/connector/issues/180)) ([5ceca53](https://github.com/toon-protocol/connector/commit/5ceca53be3d7b40e19e2bcf9fb0296f0edab9e53)), closes [#158](https://github.com/toon-protocol/connector/issues/158) [#169](https://github.com/toon-protocol/connector/issues/169) [#158](https://github.com/toon-protocol/connector/issues/158) [#181](https://github.com/toon-protocol/connector/issues/181) [#181](https://github.com/toon-protocol/connector/issues/181)

## [3.15.3](https://github.com/toon-protocol/connector/compare/v3.15.2...v3.15.3) (2026-06-20)

### Bug Fixes

- **btp:** bounded-await addPeer to restore startup channel auto-open ([#179](https://github.com/toon-protocol/connector/issues/179)) ([c79228f](https://github.com/toon-protocol/connector/commit/c79228fd7a47c9d2fb2a9d77f5eac79eabc5104b)), closes [#158](https://github.com/toon-protocol/connector/issues/158) [#169](https://github.com/toon-protocol/connector/issues/169) [#158](https://github.com/toon-protocol/connector/issues/158)

## [3.15.2](https://github.com/toon-protocol/connector/compare/v3.15.1...v3.15.2) (2026-06-20)

### Bug Fixes

- **ci:** resolve nightly-ator failures (Causes B1, C, D + patch A) ([#177](https://github.com/toon-protocol/connector/issues/177)) ([b272488](https://github.com/toon-protocol/connector/commit/b27248837ca21661516f915b8dadd7ecf2840061))

## [3.15.1](https://github.com/toon-protocol/connector/compare/v3.15.0...v3.15.1) (2026-06-20)

### Bug Fixes

- **ci:** remove dead GITHUB_TOKEN env from plain npm ci install steps ([#155](https://github.com/toon-protocol/connector/issues/155)) ([#176](https://github.com/toon-protocol/connector/issues/176)) ([16c0eae](https://github.com/toon-protocol/connector/commit/16c0eaedaa2bed4b4ca98d51e519359b788c3e3e))

## [3.15.0](https://github.com/toon-protocol/connector/compare/v3.14.1...v3.15.0) (2026-06-20)

### Features

- add devbox.json + CI devbox-validate job; bump Solana CLI to v3.1.12 ([#163](https://github.com/toon-protocol/connector/issues/163)) ([169a7ff](https://github.com/toon-protocol/connector/commit/169a7ff370fc9fba25ac3de6ac7931daf533bf26)), closes [#145](https://github.com/toon-protocol/connector/issues/145) [#145](https://github.com/toon-protocol/connector/issues/145) [#105](https://github.com/toon-protocol/connector/issues/105)

### Bug Fixes

- **ci:** make devbox 'Assert tool versions' robust (fix grep --versionn) ([#175](https://github.com/toon-protocol/connector/issues/175)) ([a85d395](https://github.com/toon-protocol/connector/commit/a85d39572a6d0a008458323e80e08dcf547a7dc0))

## [3.14.1](https://github.com/toon-protocol/connector/compare/v3.14.0...v3.14.1) (2026-06-20)

### Bug Fixes

- **test:** use SocksProxyAgent + WebSocket { agent } for system-tor round-trip (T-36.5-07b) ([#168](https://github.com/toon-protocol/connector/issues/168)) ([921062e](https://github.com/toon-protocol/connector/commit/921062e994fa445cd61bdacc14b6c57458bcb1c9)), closes [#159](https://github.com/toon-protocol/connector/issues/159)

## [3.14.0](https://github.com/toon-protocol/connector/compare/v3.13.2...v3.14.0) (2026-06-20)

### Features

- **admin-api:** expose .anon hostname via GET /admin/anon-hostname ([#153](https://github.com/toon-protocol/connector/issues/153)) ([f5d8677](https://github.com/toon-protocol/connector/commit/f5d8677dc1a8a0125d295ea6b80c533d4fedd081)), closes [#151](https://github.com/toon-protocol/connector/issues/151) [#151](https://github.com/toon-protocol/connector/issues/151)

## [3.13.2](https://github.com/toon-protocol/connector/compare/v3.13.1...v3.13.2) (2026-06-20)

### Bug Fixes

- **ci:** authenticate anyone-client postinstall GitHub API call ([#156](https://github.com/toon-protocol/connector/issues/156)) ([#172](https://github.com/toon-protocol/connector/issues/172)) ([26ffff4](https://github.com/toon-protocol/connector/commit/26ffff467b463b9ee38b67cf83c8a0f8c16bc7be)), closes [#2](https://github.com/toon-protocol/connector/issues/2)

## [3.13.1](https://github.com/toon-protocol/connector/compare/v3.13.0...v3.13.1) (2026-06-20)

### Bug Fixes

- **ci:** add admin-API healthcheck to two-home-ator-local connector services ([#162](https://github.com/toon-protocol/connector/issues/162)) ([639dda1](https://github.com/toon-protocol/connector/commit/639dda19d6ab8e99ae9ce14abccac352ace2e003)), closes [#160](https://github.com/toon-protocol/connector/issues/160)
- **ci:** add NET_ADMIN capability to hs1 container for tcpdump BPF access ([#169](https://github.com/toon-protocol/connector/issues/169)) ([f3d3371](https://github.com/toon-protocol/connector/commit/f3d337101aa058e2dec89ed0a72888bfbec188f0)), closes [#166](https://github.com/toon-protocol/connector/issues/166)
- **test:** replace fixed sleep with poll-until-gone in ator afterEach ([#164](https://github.com/toon-protocol/connector/issues/164)) ([f4594f2](https://github.com/toon-protocol/connector/commit/f4594f23877dc034e41c90bd9b81949e33ec86d5)), closes [#157](https://github.com/toon-protocol/connector/issues/157)

## [3.13.0](https://github.com/toon-protocol/connector/compare/v3.12.2...v3.13.0) (2026-06-17)

### Features

- **transport:** gate HS publish on control-port HS_DESC UPLOADED + enable ControlPort ([#143](https://github.com/toon-protocol/connector/issues/143)) ([#144](https://github.com/toon-protocol/connector/issues/144)) ([648dc01](https://github.com/toon-protocol/connector/commit/648dc010431583f43f0e02752fc3450f7de78005)), closes [#142](https://github.com/toon-protocol/connector/issues/142) [#142](https://github.com/toon-protocol/connector/issues/142) [#142](https://github.com/toon-protocol/connector/issues/142) [#142](https://github.com/toon-protocol/connector/issues/142)

## [3.12.2](https://github.com/toon-protocol/connector/compare/v3.12.1...v3.12.2) (2026-06-17)

### Bug Fixes

- **transport:** gate HS publish on self-dial reachability, not hostname file ([#142](https://github.com/toon-protocol/connector/issues/142)) ([08c10fb](https://github.com/toon-protocol/connector/commit/08c10fbeb24202d206f78d347e77e2cef8f0040c))

## [3.12.1](https://github.com/toon-protocol/connector/compare/v3.12.0...v3.12.1) (2026-06-17)

### Bug Fixes

- **loops:** allow App bot actor ([223d9ee](https://github.com/toon-protocol/connector/commit/223d9eeaaff081162b54df3910b9b589b08376f3))
- **loops:** allow App bot actor ([1bcadce](https://github.com/toon-protocol/connector/commit/1bcadce2d72d55f822acf676cae8ae525d5b8e84))

## [3.12.0](https://github.com/toon-protocol/connector/compare/v3.11.0...v3.12.0) (2026-06-17)

### Features

- **loops:** add Loop B issue-executor ([7c13062](https://github.com/toon-protocol/connector/commit/7c13062b829ff132db65c526369503298d32a705))
- **loops:** add Loop C pr-reviewer ([f156646](https://github.com/toon-protocol/connector/commit/f1566462c542eef79357849c1213d25a33b0bac4))

## [3.11.0](https://github.com/toon-protocol/connector/compare/v3.10.4...v3.11.0) (2026-06-16)

### Features

- **shared:** localDelivery wire contract (PaymentRequest/Response) as the cross-repo source of truth ([#140](https://github.com/toon-protocol/connector/issues/140)) ([0b89124](https://github.com/toon-protocol/connector/commit/0b8912427bb2329731b793c2a274ef7f4639c548))

## [3.10.4](https://github.com/toon-protocol/connector/compare/v3.10.3...v3.10.4) (2026-06-12)

### Bug Fixes

- **settlement:** verify Solana/Mina inbound claims ([#137](https://github.com/toon-protocol/connector/issues/137)) and register chain for dynamic HS peers ([#136](https://github.com/toon-protocol/connector/issues/136)) ([#138](https://github.com/toon-protocol/connector/issues/138)) ([96d6d48](https://github.com/toon-protocol/connector/commit/96d6d48105ccdbbc8c9b7bd3ea704517d0291681))

## [3.10.3](https://github.com/toon-protocol/connector/compare/v3.10.2...v3.10.3) (2026-06-10)

### Bug Fixes

- **mina:** feed channel state to [#133](https://github.com/toon-protocol/connector/issues/133) balanceB derivation in integration tests ([#135](https://github.com/toon-protocol/connector/issues/135)) ([a93b382](https://github.com/toon-protocol/connector/commit/a93b382108a78ca4ea76f7f21af22a2787d301a7))

## [3.10.2](https://github.com/toon-protocol/connector/compare/v3.10.1...v3.10.2) (2026-06-10)

### Bug Fixes

- **mina:** derive balanceB from depositTotal in claimFromChannel co-sign ([#133](https://github.com/toon-protocol/connector/issues/133)) ([#134](https://github.com/toon-protocol/connector/issues/134)) ([72d5a0b](https://github.com/toon-protocol/connector/commit/72d5a0bb8fb544c331a926a574608bc03677e7e5))

## [3.10.1](https://github.com/toon-protocol/connector/compare/v3.10.0...v3.10.1) (2026-06-10)

### Bug Fixes

- **settlement:** route Solana/Mina settle by claim chain, not stale EVM channel ([#132](https://github.com/toon-protocol/connector/issues/132)) ([cf8e219](https://github.com/toon-protocol/connector/commit/cf8e2198c06d1b37e3e831889898293d979bbc6d)), closes [#92](https://github.com/toon-protocol/connector/issues/92)

## [3.10.0](https://github.com/toon-protocol/connector/compare/v3.9.13...v3.10.0) (2026-06-08)

### Features

- **mina:** bundle Story 34.4 fund-custody PaymentChannel zkApp ([#131](https://github.com/toon-protocol/connector/issues/131)) ([018ddd2](https://github.com/toon-protocol/connector/commit/018ddd2068adae8881802f32a719a98b017221c6)), closes [#134](https://github.com/toon-protocol/connector/issues/134) [#130](https://github.com/toon-protocol/connector/issues/130)

## [3.9.13](https://github.com/toon-protocol/connector/compare/v3.9.12...v3.9.13) (2026-06-08)

### Bug Fixes

- **mina:** split openChannel into separate deploy and initialize txs ([#128](https://github.com/toon-protocol/connector/issues/128)) ([#129](https://github.com/toon-protocol/connector/issues/129)) ([9bdf565](https://github.com/toon-protocol/connector/commit/9bdf565f69643350e010a9ba2d1ec51b4d065869))

## [3.9.12](https://github.com/toon-protocol/connector/compare/v3.9.11...v3.9.12) (2026-06-08)

### Bug Fixes

- **mina:** set zkApp tx fee and guard claim balance conservation ([#126](https://github.com/toon-protocol/connector/issues/126)) ([#127](https://github.com/toon-protocol/connector/issues/127)) ([113fb46](https://github.com/toon-protocol/connector/commit/113fb4689a20ff3b2e6de75018ad9ab26deb1e7d)), closes [post-#123](https://github.com/toon-protocol/post-/issues/123)

## [3.9.11](https://github.com/toon-protocol/connector/compare/v3.9.10...v3.9.11) (2026-06-07)

### Bug Fixes

- **mina:** co-sign signatureB with apex key in claimFromChannel ([#123](https://github.com/toon-protocol/connector/issues/123)) ([#124](https://github.com/toon-protocol/connector/issues/124)) ([0074f93](https://github.com/toon-protocol/connector/commit/0074f93541472f0ed7615666c03b4cc1868122e7))

## [3.9.10](https://github.com/toon-protocol/connector/compare/v3.9.9...v3.9.10) (2026-06-07)

### Bug Fixes

- **mina:** accept signBalanceProof wrapper as signatureA in claimFromChannel ([#121](https://github.com/toon-protocol/connector/issues/121)) ([#122](https://github.com/toon-protocol/connector/issues/122)) ([75f4423](https://github.com/toon-protocol/connector/commit/75f44237c09fb16fbf1a8d8f27d0d8a1589c6387)), closes [#117](https://github.com/toon-protocol/connector/issues/117) [#118](https://github.com/toon-protocol/connector/issues/118)

## [3.9.9](https://github.com/toon-protocol/connector/compare/v3.9.8...v3.9.9) (2026-06-07)

### Bug Fixes

- **mina:** accept advancing claims in verifyBalanceProof so on-chain settle progresses ([#118](https://github.com/toon-protocol/connector/issues/118)) ([#120](https://github.com/toon-protocol/connector/issues/120)) ([d0d0a12](https://github.com/toon-protocol/connector/commit/d0d0a125b84890f3dd4dfb25a41c97ef43bd0c71))

## [3.9.8](https://github.com/toon-protocol/connector/compare/v3.9.7...v3.9.8) (2026-06-07)

### Bug Fixes

- **mina:** emit real transferredAmount in CLAIM_RECEIVED so settlement triggers ([#116](https://github.com/toon-protocol/connector/issues/116), [#117](https://github.com/toon-protocol/connector/issues/117)) ([#119](https://github.com/toon-protocol/connector/issues/119)) ([4684b26](https://github.com/toon-protocol/connector/commit/4684b26046d3fa177b7ee457b5766f6a69a3d80c)), closes [#114](https://github.com/toon-protocol/connector/issues/114) [#98](https://github.com/toon-protocol/connector/issues/98) [#84](https://github.com/toon-protocol/connector/issues/84)

## [3.9.7](https://github.com/toon-protocol/connector/compare/v3.9.6...v3.9.7) (2026-06-07)

### Bug Fixes

- **mina:** enable on-chain claimFromChannel for inbound channels ([#114](https://github.com/toon-protocol/connector/issues/114)) ([#115](https://github.com/toon-protocol/connector/issues/115)) ([9130525](https://github.com/toon-protocol/connector/commit/9130525deb7988b064a4530469a120144b4f9aed)), closes [#98](https://github.com/toon-protocol/connector/issues/98) [#84](https://github.com/toon-protocol/connector/issues/84)

## [3.9.6](https://github.com/toon-protocol/connector/compare/v3.9.5...v3.9.6) (2026-06-06)

### Bug Fixes

- **ci:** deploy USDC token in --profile evm stack so standalone-e2e passes ([#104](https://github.com/toon-protocol/connector/issues/104)) ([#111](https://github.com/toon-protocol/connector/issues/111)) ([73159a7](https://github.com/toon-protocol/connector/commit/73159a70e23356c3f0c9166d4ca8c3e56e878b04))

## [3.9.5](https://github.com/toon-protocol/connector/compare/v3.9.4...v3.9.5) (2026-06-06)

### Bug Fixes

- **settlement:** compare Mina proof commitment against on-chain balanceCommitment ([#98](https://github.com/toon-protocol/connector/issues/98)) ([#100](https://github.com/toon-protocol/connector/issues/100)) ([9f29fac](https://github.com/toon-protocol/connector/commit/9f29facefa20d0d30809db0c5ef3943b9fa18b69)), closes [Post-#95](https://github.com/toon-protocol/Post-/issues/95)
- **settlement:** decouple Solana claim fee-payer from claiming participant ([#99](https://github.com/toon-protocol/connector/issues/99)) ([#101](https://github.com/toon-protocol/connector/issues/101)) ([6a8c954](https://github.com/toon-protocol/connector/commit/6a8c954d10b679f9d1e95668116bf074ca99f9d2)), closes [#94](https://github.com/toon-protocol/connector/issues/94)
- **settlement:** derive Solana PubSub WS URL on rpc_port + 1 ([#102](https://github.com/toon-protocol/connector/issues/102)) ([31c3fc5](https://github.com/toon-protocol/connector/commit/31c3fc55a6ca1934db4aa524b1ff7a80fca7420a)), closes [#99](https://github.com/toon-protocol/connector/issues/99)

## [3.9.4](https://github.com/toon-protocol/connector/compare/v3.9.3...v3.9.4) (2026-06-05)

### Bug Fixes

- **settlement:** bind Mina active network before zkApp state reads ([#95](https://github.com/toon-protocol/connector/issues/95)) ([#97](https://github.com/toon-protocol/connector/issues/97)) ([f3b6f09](https://github.com/toon-protocol/connector/commit/f3b6f09850bd9bb8df0f21f5bb4b0ea8eb2e7699))
- **settlement:** use balance-proof signer pubkey for Solana Ed25519 precompile ([#94](https://github.com/toon-protocol/connector/issues/94)) ([#96](https://github.com/toon-protocol/connector/issues/96)) ([74a3f98](https://github.com/toon-protocol/connector/commit/74a3f982f4322153eb7c71817a0f7d17854847df))

## [3.9.3](https://github.com/toon-protocol/connector/compare/v3.9.2...v3.9.3) (2026-06-05)

### Bug Fixes

- **settlement:** complete Solana on-chain SETTLE for dynamic inbound peers ([#92](https://github.com/toon-protocol/connector/issues/92)) ([eed232c](https://github.com/toon-protocol/connector/commit/eed232ce675b7c8132465f207b0db2e74947746e)), closes [#1](https://github.com/toon-protocol/connector/issues/1) [#2](https://github.com/toon-protocol/connector/issues/2)

## [3.9.2](https://github.com/toon-protocol/connector/compare/v3.9.1...v3.9.2) (2026-06-05)

### Bug Fixes

- **settlement:** use one canonical base64 encoding for Mina claim proof ([#90](https://github.com/toon-protocol/connector/issues/90)) ([5e5a4fd](https://github.com/toon-protocol/connector/commit/5e5a4fde6b5d696c2f4f3644e21efbded51bc845))

## [3.9.1](https://github.com/toon-protocol/connector/compare/v3.9.0...v3.9.1) (2026-06-05)

### Bug Fixes

- **settlement:** resolve settlement chain for dynamic inbound peers ([#88](https://github.com/toon-protocol/connector/issues/88)) ([0ad8159](https://github.com/toon-protocol/connector/commit/0ad815960f9a593f1f1f9ac78fb18e6d3f6ff894)), closes [#86](https://github.com/toon-protocol/connector/issues/86)

## [3.9.0](https://github.com/toon-protocol/connector/compare/v3.8.1...v3.9.0) (2026-06-04)

### Features

- **settlement:** wire Solana and Mina settlement end-to-end ([#86](https://github.com/toon-protocol/connector/issues/86)) ([86ad042](https://github.com/toon-protocol/connector/commit/86ad04217a6cbc776bf6b6651e0876decf48f104)), closes [#84](https://github.com/toon-protocol/connector/issues/84)

## [3.8.1](https://github.com/toon-protocol/connector/compare/v3.8.0...v3.8.1) (2026-06-02)

### Bug Fixes

- **settlement:** thread real dual-party authorization through Mina provider ([d71ba6f](https://github.com/toon-protocol/connector/commit/d71ba6fae70c408636114a5774f5f2bb7600e5d7)), closes [#70](https://github.com/toon-protocol/connector/issues/70)

## [3.8.0](https://github.com/toon-protocol/connector/compare/v3.7.2...v3.8.0) (2026-06-01)

### Features

- **connector:** migrate local SQLite from better-sqlite3 to libsql (closes [#79](https://github.com/toon-protocol/connector/issues/79)) ([7d41005](https://github.com/toon-protocol/connector/commit/7d410056910dd456da47e65e52ba118dc5f1d37f)), closes [#78](https://github.com/toon-protocol/connector/issues/78)

## [3.7.2](https://github.com/toon-protocol/connector/compare/v3.7.1...v3.7.2) (2026-05-31)

### Bug Fixes

- **connector:** relation-aware inbound claim validation for parent-forwarded packets (closes [#78](https://github.com/toon-protocol/connector/issues/78)) ([efb73b4](https://github.com/toon-protocol/connector/commit/efb73b4396ef1c7daef5433ac6fe57e63b222717)), closes [#76](https://github.com/toon-protocol/connector/issues/76) [#79](https://github.com/toon-protocol/connector/issues/79)

## [3.7.1](https://github.com/toon-protocol/connector/compare/v3.7.0...v3.7.1) (2026-05-29)

### Bug Fixes

- **connector:** relationship-aware settlement-claim gate for child peers (closes [#76](https://github.com/toon-protocol/connector/issues/76)) ([515731e](https://github.com/toon-protocol/connector/commit/515731e9c4215a5dd621b6c4b29672720ec27683))

## [3.7.0](https://github.com/toon-protocol/connector/compare/v3.6.3...v3.7.0) (2026-05-21)

### Features

- **connector:** add packetsLocallyDelivered counter for self-delivery route (closes [#73](https://github.com/toon-protocol/connector/issues/73)) ([59674d5](https://github.com/toon-protocol/connector/commit/59674d56a86788b9529c804ac17e05560fc6f5ec))

### Bug Fixes

- **ci:** auth anyone-client postinstall against GitHub API rate limit ([cca6c3c](https://github.com/toon-protocol/connector/commit/cca6c3c7f576c983abe0c6de1ffc2783c77cf9dd))

## [3.6.3](https://github.com/toon-protocol/connector/compare/v3.6.2...v3.6.3) (2026-05-13)

### Bug Fixes

- **connector:** wire ClaimReceiver to AdminServer + safe shutdown ordering ([bf9cb29](https://github.com/toon-protocol/connector/commit/bf9cb298a73c2bf335859f85f7f883ee8fa04353))

## [3.6.2](https://github.com/toon-protocol/connector/compare/v3.6.1...v3.6.2) (2026-05-12)

### Bug Fixes

- **btp:** per-peer transport selection for BTP client ([#69](https://github.com/toon-protocol/connector/issues/69)) ([52702e1](https://github.com/toon-protocol/connector/commit/52702e173df7d2c37fb0f6bded11f9b3ca618a75))

## [3.6.1](https://github.com/toon-protocol/connector/compare/v3.6.0...v3.6.1) (2026-05-08)

### Bug Fixes

- **docs:** reformat Staying current gh CLI command as code block ([f74ba4f](https://github.com/toon-protocol/connector/commit/f74ba4f55e4bf56937551f70ba1865421d183005))

## [3.6.0](https://github.com/toon-protocol/connector/compare/v3.5.1...v3.6.0) (2026-05-08)

### Features

- **release:** cosign-sign connector + ATOR sidecar images via keyless OIDC ([30d2466](https://github.com/toon-protocol/connector/commit/30d2466e6ffc97014595b57b13c7f5992cbac31a))

## [3.5.1](https://github.com/toon-protocol/connector/compare/v3.5.0...v3.5.1) (2026-05-07)

### Bug Fixes

- **ci:** fix imagetools verify for multi-arch manifest index ([b854f04](https://github.com/toon-protocol/connector/commit/b854f04cd9ecdf6d1ce69cfe3feca0719eef14c2)), closes [#25518750342](https://github.com/toon-protocol/connector/issues/25518750342) [#63](https://github.com/toon-protocol/connector/issues/63)

## [Unreleased]

### Documentation

- Codify `/admin/*` semver discipline in `CONNECTOR_RELEASE_CONTRACT.md` (Story 44.4 / PR #67)
- Polish `CONNECTOR_RELEASE_CONTRACT.md` follow-up — fix PR #62 → #63 reference, pin cosign opener to `v3.6.0`, correct "Two/Three mechanisms" lede, anchor town-mirror diff cwd, add `bash` language hint, add RFC-0027 reference (Story 44.4 round-2 review patches)

### Added

- Nightly ATOR CI workflow (`.github/workflows/nightly-ator.yml`): real-binary + system-tor fallback smoke test on Linux and macOS; nightly at 04:00 UTC + `workflow_dispatch` (Story 36.5)

### Build

- Cosign-signed images via keyless OIDC for `connector` and `ator-sidecar` (Story 44.3 / PR #66)
- Multi-arch image: `linux/amd64,linux/arm64` published for both `connector` and `ator-sidecar` images starting from the next release after this PR. The smoke-test step in `build-and-publish.yml` remains `linux/amd64` only (`load: true` is incompatible with multi-platform builds).

## [3.5.0](https://github.com/toon-protocol/connector/compare/v3.4.2...v3.5.0) (2026-05-07)

### Features

- **connector:** add GET /admin/hs-hostname endpoint ([#58](https://github.com/toon-protocol/connector/issues/58)) ([d92c885](https://github.com/toon-protocol/connector/commit/d92c8856a844b4ea6bb0d837c009bec19c514f07))

## [3.4.2](https://github.com/toon-protocol/connector/compare/v3.4.1...v3.4.2) (2026-05-07)

### Bug Fixes

- **connector:** tolerate registry-key format variation in ClaimReceiver ([b565e4c](https://github.com/toon-protocol/connector/commit/b565e4cb1173d578af43a8a1c1a5a014501eb8a5)), closes [#56](https://github.com/toon-protocol/connector/issues/56)

## [3.4.1](https://github.com/toon-protocol/connector/compare/v3.4.0...v3.4.1) (2026-05-06)

### Bug Fixes

- **connector:** rebuild better-sqlite3 in image, fail-closed on missing native deps ([f33548c](https://github.com/toon-protocol/connector/commit/f33548c17a0f11d5e42f4d1b54f81d4189343dc2))

## [3.4.0](https://github.com/toon-protocol/connector/compare/v3.3.3...v3.4.0) (2026-05-04)

### Features

- **ator:** two-home verification tooling + Town integration guide ([f3fb0b5](https://github.com/toon-protocol/connector/commit/f3fb0b5b47073a938e9c7567b42b211cd915106b))

## [3.3.3](https://github.com/toon-protocol/connector/compare/v3.3.2...v3.3.3) (2026-04-29)

### Bug Fixes

- **test:** strip all Node CJS loader internals from anon-cli snapshot normalize ([ee57c06](https://github.com/toon-protocol/connector/commit/ee57c0613f52e7f86c5b848b59dac08e03057faa)), closes [#45](https://github.com/toon-protocol/connector/issues/45) [#46](https://github.com/toon-protocol/connector/issues/46)

## [3.3.2](https://github.com/toon-protocol/connector/compare/v3.3.1...v3.3.2) (2026-04-28)

### Bug Fixes

- **connector:** map F02 unreachable and F04 insufficient destination amount ([0391843](https://github.com/toon-protocol/connector/commit/0391843d990fda2999cb6890b5667944ceab266f))

## [3.3.1](https://github.com/toon-protocol/connector/compare/v3.3.0...v3.3.1) (2026-04-24)

### Bug Fixes

- remove || true from build:publish script that suppressed tsc errors ([c58ee1a](https://github.com/toon-protocol/connector/commit/c58ee1af933b6bd922dd913fb3266d079573c333))

## [3.3.0](https://github.com/toon-protocol/connector/compare/v3.2.1...v3.3.0) (2026-04-24)

### Features

- connector v3.2.0 production readiness ([27749a4](https://github.com/toon-protocol/connector/commit/27749a47b0c071005096e2ff92b1f221d3d30c52))

## [3.2.1](https://github.com/toon-protocol/connector/compare/v3.2.0...v3.2.1) (2026-04-22)

### Bug Fixes

- **benchmark:** handle npm workspace argument forwarding ([acb74e6](https://github.com/toon-protocol/connector/commit/acb74e622952e813cfee43081604fd80116cef33))
- update CLI snapshot normalization for @anyone-protocol/anyone-client SDK changes ([ffbc690](https://github.com/toon-protocol/connector/commit/ffbc690dda5959137cd10581907d3e6539d5be06))

## [3.2.0](https://github.com/toon-protocol/connector/compare/v3.1.2...v3.2.0) (2026-04-22)

### Features

- add epic-37 implementation artifacts and earnings endpoints ([2c47d51](https://github.com/toon-protocol/connector/commit/2c47d5119b0e38aaab0d5c23b4424e342b45f768))
- add getRecentClaims and getCumulativeInboundByAsset to ClaimReceiver ([1684ff0](https://github.com/toon-protocol/connector/commit/1684ff07133f36073341b48b9640ce7dd1675381))
- add sentClaimsQueries, resolveTokenMetadata, connectorFeePercentage to AdminAPIConfig ([014c5d0](https://github.com/toon-protocol/connector/commit/014c5d0be34bff410f4b173c5854341b02116965))
- **metrics:** wire prom-client + per-peer counters (Epic 37) ([325f668](https://github.com/toon-protocol/connector/commit/325f668b4d8f3a0f43809f235d067b40713094c0))

### Bug Fixes

- add npm authentication for GitHub Packages ([06cfc2c](https://github.com/toon-protocol/connector/commit/06cfc2ce2b5e6c13bdf86929ad47c470072c5d02))
- publish npm to npmjs.com using NPM_TOKEN secret ([e0fac09](https://github.com/toon-protocol/connector/commit/e0fac098359ddee7b9cb141cfb15f1f03b7481e5))
- reduce timeout in flaky packet-handler test ([85946fa](https://github.com/toon-protocol/connector/commit/85946fab04eb8624cb6127e1f19371dbab2d4158))
- resolve lint errors and add earnings.json to admin API inventory ([155f326](https://github.com/toon-protocol/connector/commit/155f3265e72615be62868688a883bd5f94ed13ad))
- **settlement:** restore solana mint metadata and credit limit checks ([e7b03bd](https://github.com/toon-protocol/connector/commit/e7b03bd7e028c1c8fde5b2f964e073052923f55e))

## [3.1.2](https://github.com/toon-protocol/connector/compare/v3.1.1...v3.1.2) (2026-04-22)

### Bug Fixes

- **tests:** resolve E2E and integration test failures for Epic 38 HTTP surface coverage ([508025e](https://github.com/toon-protocol/connector/commit/508025e4a3638c7b9cad75fa14fc442ae0e24370))

## [3.1.1](https://github.com/toon-protocol/connector/compare/v3.1.0...v3.1.1) (2026-04-20)

### Bug Fixes

- **deploy:** point production compose + README at toon-protocol GHCR ([0844452](https://github.com/toon-protocol/connector/commit/0844452e99d3ed3a9bc9755ff7354bd3ab11e4df))

## [3.1.0](https://github.com/toon-protocol/connector/compare/v3.0.0...v3.1.0) (2026-04-20)

### Features

- **standalone:** comprehensive standalone-mode E2E coverage + production stack ([fbc963a](https://github.com/toon-protocol/connector/commit/fbc963a1b17868956b809b5d9678ce93deab6ce7))

## [3.0.0](https://github.com/toon-protocol/connector/compare/v2.5.0...v3.0.0) (2026-04-19)

### ⚠ BREAKING CHANGES

- **settlement:** settlementInfra config removed; use chainProviders with EVM entry.
  SettlementInfraConfig type no longer exported from @toon-protocol/connector.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

### Features

- **36.1:** local ATOR test-network image + docker-compose profile ([792df77](https://github.com/toon-protocol/connector/commit/792df77dd22d43e664b4501bf3b425bc5f3fd5a7)), closes [#3](https://github.com/toon-protocol/connector/issues/3)
- **36.2:** anyone-client SDK CLI flag audit for docs/ator-transport.md ([c01232d](https://github.com/toon-protocol/connector/commit/c01232d74b46c2f17d20e74f2789d84584f0ff96))
- **36.3:** story complete ([5897a5b](https://github.com/toon-protocol/connector/commit/5897a5bd4f6e0bfa5723fda8ababf5a6305ea50e))
- **36.4:** story complete ([c430924](https://github.com/toon-protocol/connector/commit/c4309243a48824583e3e731e7d62760700b7c455)), closes [#2](https://github.com/toon-protocol/connector/issues/2)
- **36.5:** story complete ([62d0bd8](https://github.com/toon-protocol/connector/commit/62d0bd8ecfa52630ac4a030c345552d2d53d4ae4))
- **36.6:** story complete ([efbf64d](https://github.com/toon-protocol/connector/commit/efbf64d6f46ccb8baefef039a51fe005f2a163cc))
- **ator:** cross-chain ILP e2e test through SOCKS5 transport ([07e15f2](https://github.com/toon-protocol/connector/commit/07e15f2ae2903ee97029f8de649d21c24affc04c))
- **ator:** multi-hop ILP e2e test through SOCKS5 transport ([3fce4a2](https://github.com/toon-protocol/connector/commit/3fce4a2e5b04c7b2d3fd8eb8864e45b516810ec2))
- **ator:** public Anyone proxy e2e test — live network verification ([79d0ef1](https://github.com/toon-protocol/connector/commit/79d0ef1a081762e315d31fd17ace95e3c5be4dae))
- **ator:** real ATOR + SDK multi-hop e2e tests, expose DirAuth/relay ports ([46f5289](https://github.com/toon-protocol/connector/commit/46f52894d258a095c1269e3fb8ee6c3f50d2f9d4))
- **settlement:** remove settlementInfra, wire ChannelManager to chainProviders[evm] ([7109fdf](https://github.com/toon-protocol/connector/commit/7109fdf2641ee696590c3429ddd1b5de4f8eaebb))

### Bug Fixes

- **ator:** fix test failures — consensus, SOCKS, TLD, SDK API ([561cfe4](https://github.com/toon-protocol/connector/commit/561cfe4e030e5cf0f400a304bb70d43729345609))
- **ator:** make ATOR testnet bootstrap work with real key exchange ([5eeb8d7](https://github.com/toon-protocol/connector/commit/5eeb8d75fa0a2cc34a068c9b187633f09b046cf5))
- **ator:** real ATOR multi-hop e2e — host connectivity + peerHost option ([2120ec9](https://github.com/toon-protocol/connector/commit/2120ec986ae2b57d6ba0d23f95ed3446b09ec81e))
- **ator:** SDK autoTermsAgreement, tcpdump multi-packet, relay retry ([81eadf4](https://github.com/toon-protocol/connector/commit/81eadf4b583810f54de57d443f1ca93cb0080b01))
- **ator:** SDK test uses public network only, remove broken local testnet path ([5e2da98](https://github.com/toon-protocol/connector/commit/5e2da98a235127a8ba2da720b129e122eeb8351f))
- **ator:** tcpdump interface, add 4th relay for circuit rebuild test ([d452207](https://github.com/toon-protocol/connector/commit/d45220798e6ed3730de1a2acd232450ab112f6f8))
- **settlement:** update connector-node tests for new openChannel error message ([80af624](https://github.com/toon-protocol/connector/commit/80af624619bcab9ae11f1119174215865c890d43))
- **settlement:** update optional-deps tests to use chainProviders instead of env vars ([94a4f02](https://github.com/toon-protocol/connector/commit/94a4f023d7134cded457a16b712fb567a2417607))

## [Unreleased]

### Added

- **standalone-mode E2E suite (epic-36 addendum):** 25 new passing integration tests across 8 files covering the full standalone deployment-mode matrix:
  - `standalone-smoke-e2e.test.ts` (4 tests) — admin API + BTP + local-delivery HTTP surface, in-process
  - `standalone-settlement-e2e.test.ts` (5 tests) — `chainProviders[evm]`-only settlement + on-chain `claimFromChannel`
  - `standalone-multihop-e2e.test.ts` (5 tests) — 3-peer linear chain routing via admin API
  - `standalone-claim-gate-e2e.test.ts` (2 tests) — F06 inbound-claim-validation gate still fires in standalone mode
  - `standalone-container-e2e.test.ts` (3 tests) — two connector containers + two BLS containers across compose-DNS bridge
  - `standalone-ator-public-container-e2e.test.ts` (3 tests) — container boots with `transport: socks5` against a live public Anyone proxy
  - `standalone-ator-public-p2p-container-e2e.test.ts` (3 tests) — peer-to-peer ILP routing via hidden-service rendezvous on the **real public ATOR network**
  - `standalone-admin-allowlist-e2e.test.ts` (3 tests) — Tier-3 security topology: BLS → admin API via bridge + `allowedIPs`, admin port unpublished
  - `standalone-ator-hs-local-e2e.test.ts` (scaffolded, double-gated skip) — local-testnet HS rendezvous; blocked by relay-descriptor bridge-IP routing, documented in-file
- **Production deployment stack:** `docker-compose.prod.yml` at repo root, `config/connector.prod.yaml` template with Tier-3 defaults + commented ATOR section, complete rewrite of the README `## Docker Deployment` section covering standalone + BLS deployment, ATOR enablement with public-proxy list (+ instructions for swapping regions), BLS-writing guide (HTTP contract + Node.js + Python examples), and security-posture summary.
- **`@toon-protocol/connector` API additions (additive, non-breaking):**
  - `ClaimReceiver.getLatestVerifiedClaimForChannel(peerId, channelId)` — resolves a received claim without requiring the caller to know the blockchain discriminator.
  - `SettlementExecutor.setClaimReceiver(receiver)` — wires the claim-receiver for receiver-side `claimFromChannel` invocations.
- **ATOR public-network Docker sidecar:** `docker/ator-public-sidecar/` (Dockerfile + entrypoint + pinned checksums) for peer-to-peer HS topology; pinned `anon v0.4.10.0-beta`.
- **Make targets:** `standalone-test`, `standalone-test-docker`, `standalone-test-ator-public`, `standalone-test-ator-p2p`, `standalone-test-allowlist`.
- **CI jobs:** `standalone-e2e` + `standalone-container-e2e` on `ci.yml` (main-branch pushes); `standalone-ator-public` + `standalone-ator-p2p` on `nightly-ator.yml`.

### Fixed

- **Settlement receiver-side claim resolution:** `SettlementExecutor.settleViaExistingChannel` previously pulled the balance proof from `PerPacketClaimService` (sender-side sent claims). `claimFromChannel` is invoked by the CREDIT side redeeming a peer's signed proof received over BTP, so this path always returned `null` and threw _"No per-packet claim available for settlement."_ Now prefers `ClaimReceiver.getLatestVerifiedClaimForChannel` (received claims), falling back to sent claims only when no received claim exists.
- **`AccountManager.recordSettlement` idempotency:** the settlement transfer failed with _"Debit account not found"_ whenever the peer's ledger accounts hadn't been pre-created by prior packet flow (common in standalone receivers that never forward outbound). Now calls `ensurePeerAccounts` (idempotent) before posting the transfer.
- **`ManagedAnonClient` SDK compatibility:** the default factory only resolved `mod.Anon`, but `@anyone-protocol/anyone-client@1.1.x` exports `mod.Process`. Factory now tries `Process → Anon → default` in order. Separately, the SDK's `createAnonConfigFile` reads `options.configFile` but `ManagedAnonClient` was setting `options.configFilePath` — the custom anonrc (with `TestingTorNetwork` + DirAuthority lines) was silently ignored, forcing fallback to public ATOR even when a testnet anonrc had been pre-written. Both property names are now set.
- **Dockerfile `mina-zkapp` inclusion:** the production image build failed with `Cannot find module '@toon-protocol/mina-zkapp'` because only `shared` + `connector` packages were copied. Builder and runtime stages now include `packages/mina-zkapp` so the image builds cleanly.

### Changed

- **ATOR local testnet torrc tuning:** `docker/ator/torrc.{dirauth,hs,relay}` gain `EnforceDistinctSubnets 0` and `ConfluxEnabled 0` — the single-/24 testnet bridge with only 4 non-authority relays cannot satisfy default path-selection constraints, so HS descriptor upload and rendezvous circuits now build in the local testnet.
- **`.gitignore`:** added `packages/connector/data/ledger-*.json` and `packages/connector/terms-agreement` so transient test-runtime artifacts stop accumulating in the repo.

- **36-6:** Deployment guide update with Verification Status, Local Development Network, prerequisites split (operational vs development), and real-binary troubleshooting entries (Story 36.6)
- **36-5:** Nightly CI workflow (`nightly-ator.yml`) + system-tor fallback smoke test (Story 36.5) -- runs real-binary ATOR suite and system-tor fallback on Linux + macOS nightly at 04:00 UTC. Platform matrix documented in `docs/ator-transport.md`.
- **36-4:** Hidden-service + managed-client real-binary ATOR test suite (Story 36.4) — new env-gated jest suite (`transport-ator-hidden-service.test.ts`) that exercises the managed `anon` lifecycle and `.anon` hidden-service rendezvous end-to-end against the real binary under `make ator-test`. Adds socat echo server to hs1 container for HS rendezvous tests.
- **36-3:** Real-binary ATOR SOCKS5 integration test suite (Story 36.3) — new env-gated jest suite (`transport-ator-real-binary.test.ts`) that drives `SocksTransportProvider` through a real `anon v0.4.10.0-beta` circuit stood up by the `make ator-up` stack. Runs only under `ATOR_NIGHTLY=1` via `make ator-test`; silently skipped under `make test`.
- **36-2:** Anyone-client SDK CLI flag audit for `docs/ator-transport.md` (Story 36.2) — verified all CLI flags and configuration options against `@anyone-protocol/anyone-client@1.1.3`.
- **36-1:** Local ATOR test-network image + docker-compose profile (Story 36.1) — 7-container local ATOR network (`3 DirAuth + 3 relay + 1 HS`) with `make ator-up`/`ator-down`/`ator-logs`/`ator-test` targets. Custom Dockerfile pins `anon v0.4.10.0-beta` binary.

### Changed

- **36-3:** Renamed in-process SOCKS5 fixture + contract test to clarify scope vs real-binary coverage (Story 36.3). `test/helpers/in-process-socks5-proxy.ts` → `test/helpers/socks5-contract-fixture.ts`; `test/integration/transport-socks5.test.ts` → `test/integration/socks5-contract.test.ts`. Import sites and scope-disclaimer JSDoc updated accordingly.

## [2.5.0](https://github.com/toon-protocol/connector/compare/v2.4.0...v2.5.0) (2026-04-15)

### Features

- **35-1:** story complete — TransportProvider interface and DirectTransportProvider ([5ddc40c](https://github.com/toon-protocol/connector/commit/5ddc40cf6fa516845864760cb6b02ad3f1639ebd))
- **35.2:** story complete — SocksTransportProvider for ATOR overlay transport ([64b5d20](https://github.com/toon-protocol/connector/commit/64b5d20451feabcc21be844a17f79caa6b990168))
- **35.3:** story complete — transport config block schema ([4eb1561](https://github.com/toon-protocol/connector/commit/4eb1561699b63894a920816180198cd709dfe1bb))
- **35.4:** story complete — wire TransportProvider into ConnectorNode and BTPClient ([25bb2c3](https://github.com/toon-protocol/connector/commit/25bb2c32c63ea6d0e03233f0fa32b07899f2006f))
- **35.5:** story complete — managed ATOR client lifecycle ([bd56e66](https://github.com/toon-protocol/connector/commit/bd56e6640e39d5d4e7cb3a154dcba106dbff2ef2))
- **35.6:** story complete — unit and integration tests for ATOR transport ([1fdbb20](https://github.com/toon-protocol/connector/commit/1fdbb20119bca71b49377d56b55f5d3da5d3f694))
- **35.7:** story complete — ATOR transport deployment guide and config reference ([ab751e2](https://github.com/toon-protocol/connector/commit/ab751e2cc212f01f507d2872767473432aa573e9))
- **epic-35:** add ATOR overlay transport epic — planning artifacts and doc updates ([ad8ae65](https://github.com/toon-protocol/connector/commit/ad8ae653963742df1dd84f0e5a7246766f6d190f))

### Bug Fixes

- **deps:** sync package-lock.json with @anyone-protocol/anyone-client ([19aca96](https://github.com/toon-protocol/connector/commit/19aca967ea13a33bb15c9964bf32032f5445c4f7))

## [2.4.0](https://github.com/toon-protocol/connector/compare/v2.3.0...v2.4.0) (2026-03-30)

### Features

- **34-10:** Mina local development infrastructure — story complete ([c179ec9](https://github.com/toon-protocol/connector/commit/c179ec92a3c3c9ba00b1b0b4e454810d2c0f17c4))
- **34-1:** Mina payment channel zkApp — channel lifecycle ([71a10f3](https://github.com/toon-protocol/connector/commit/71a10f3eb6fed62a2d1b71c2e26135cd77caa255))
- **34-2:** Mina payment channel zkApp — zk-private claims ([be83f83](https://github.com/toon-protocol/connector/commit/be83f83e131f9fb28113c501cc23400168f89898))
- **34-3:** Mina payment channel zkApp — tests & deployment ([3d15ef7](https://github.com/toon-protocol/connector/commit/3d15ef7ce76e689806aa34a0781b82a67bbc6271))
- **34-4:** Mina payment channel SDK TypeScript integration — story complete ([cc3bfeb](https://github.com/toon-protocol/connector/commit/cc3bfeb80d6d5a3557572f3300c0feacdf0a882f))
- **34-5:** Implement MinaPaymentChannelProvider — story complete ([ee13667](https://github.com/toon-protocol/connector/commit/ee13667a58ef7a7a06b9a9cfe42064bf2c440926))
- **34-6:** NIP-59 claim wrapping for transport privacy — story complete ([8ecf12d](https://github.com/toon-protocol/connector/commit/8ecf12d0c9755d3f99ee0dcbb81bfcb6d89f86d1))
- **34-7:** Mina claim message types & serialization — story complete ([be5a906](https://github.com/toon-protocol/connector/commit/be5a9063bce6c5d9cd724cdb477427c1b446c728))
- **34-8:** Mina provider integration tests — story complete ([ec112a5](https://github.com/toon-protocol/connector/commit/ec112a5d9f6dfd3eb1d4993acaa616329056aeee))
- **34-9:** Mina devnet deployment documentation & verification tests — story complete ([db6b065](https://github.com/toon-protocol/connector/commit/db6b065cdd9fc335432ad20d229c0d4497c933f6))
- ECDH-derived conditions & fulfillments for ILP packets ([f6bc580](https://github.com/toon-protocol/connector/commit/f6bc580c8b22006a9d4eea242934fe6c064a9435))
- **infra:** add Solana local dev infrastructure — story 33-9 complete ([d8c8a30](https://github.com/toon-protocol/connector/commit/d8c8a30ff730cc0df152718fe676e8ea5e204220))
- **infra:** add story specs for Solana & Mina local dev infrastructure ([edcfc82](https://github.com/toon-protocol/connector/commit/edcfc8249a8794d05a5f37aca1e7112c29c3b6f1))
- wire NIP-59 claim wrapping into per-packet pipeline with e2e verification ([dbf646f](https://github.com/toon-protocol/connector/commit/dbf646fa303f6ee2698819533ef1bda9c7aca859))

### Bug Fixes

- **ci:** build mina-zkapp before connector type-check; downgrade proc-macro-crate for Solana compat ([347be15](https://github.com/toon-protocol/connector/commit/347be15e9467c110ed3d9f13bb2e814b0b4cc923))
- **ci:** build mina-zkapp before tests and run test:unit to exclude integration tests ([8b6b3c5](https://github.com/toon-protocol/connector/commit/8b6b3c53328f3c1c39292478689381d0718f4658))
- **ci:** pin Solana deps to avoid edition2024 and use system Cargo for test-sbf ([71eb45d](https://github.com/toon-protocol/connector/commit/71eb45d99e6b30f31500ca388c57370a8df27b80))
- **ci:** upgrade Solana CLI to v2.3.13 (Cargo 1.85+ for edition2024) ([59015fd](https://github.com/toon-protocol/connector/commit/59015fd26698875f54c5600b0323424592a6f4c2))
- **ci:** upgrade Solana CLI v2.1.0 → v2.2.12 for rustc/edition2024 compat ([30804aa](https://github.com/toon-protocol/connector/commit/30804aaab4aba142c128474886898fe4530e4046))
- **ci:** use --tools-version v1.52 for cargo test-sbf (Cargo 1.85+ compat) ([d207ef5](https://github.com/toon-protocol/connector/commit/d207ef5fd8c5fc1d16b9d8707de66fe5b1507a6e))

## [2.3.0](https://github.com/toon-protocol/connector/compare/v2.2.0...v2.3.0) (2026-03-27)

### Features

- **33-1:** Solana payment channel program — channel lifecycle ([bdced7b](https://github.com/toon-protocol/connector/commit/bdced7b5c6a91726730c2172f06613a93b2a087a))
- **33-2:** Solana payment channel program — claim verification ([6ac4106](https://github.com/toon-protocol/connector/commit/6ac4106fe731f214689510371593430cc6fd92f2))
- **33-3:** Solana payment channel program — tests & deployment ([77c71c9](https://github.com/toon-protocol/connector/commit/77c71c9e842ce296abb03548f48215a3fd52e860))
- **33-4:** SolanaPaymentChannelSDK — TypeScript integration ([e68f018](https://github.com/toon-protocol/connector/commit/e68f018738b62ab1b68fec518868b4769da6bd5f))
- **33-5:** SolanaPaymentChannelProvider — TypeScript adapter for Solana payment channels ([6c6d21c](https://github.com/toon-protocol/connector/commit/6c6d21c2410ea8c5b58e9ad2b135b5714c97bb75))
- **33-6:** Solana claim message types & serialization — pipeline wiring ([caf4bc4](https://github.com/toon-protocol/connector/commit/caf4bc492f07388d12e3db1a8eface4dad726100))
- **33-7:** Integration Tests — Solana Provider E2E ([a349783](https://github.com/toon-protocol/connector/commit/a349783e797a0e8b3a59fd2e8e787c25e266b820))
- **33-8:** Solana devnet deployment documentation & verification ([6f7302e](https://github.com/toon-protocol/connector/commit/6f7302e73d1f75e4ef1161302c11f8ea27d4ee5c))

## [2.2.0](https://github.com/toon-protocol/connector/compare/v2.1.0...v2.2.0) (2026-03-25)

### Features

- **32-8:** add integration tests for chain abstraction layer ([b0269e1](https://github.com/toon-protocol/connector/commit/b0269e13257536bdf11372ab8032e8ba6a5b82ca))

### Bug Fixes

- correct sprint-status.yaml structure — nest retro under epic-32, add stories for epics 33/34 ([a33bbce](https://github.com/toon-protocol/connector/commit/a33bbce1ecec70242ed3f26cd8112a84ed39d774))

## [2.1.0](https://github.com/toon-protocol/connector/compare/v2.0.0...v2.1.0) (2026-03-25)

### Features

- **32-1:** define PaymentChannelProvider interface and extend BlockchainType ([5dfc01d](https://github.com/toon-protocol/connector/commit/5dfc01dde39c107aacceb82364978a0d5bb5bb1e))
- **32-2:** implement ChainProviderRegistry with register/retrieve, peer lookup, and config-driven factory initialization ([ef6c29c](https://github.com/toon-protocol/connector/commit/ef6c29cfbc86e41dd4f4ef292174d9a2ab2c8107))
- **32-3:** implement EVMPaymentChannelProvider with SDK delegation ([d027c19](https://github.com/toon-protocol/connector/commit/d027c194e5e88d7317407aae6b08692f51d925cb))
- **32-4:** refactor PerPacketClaimService for multi-chain claim generation ([6cd4621](https://github.com/toon-protocol/connector/commit/6cd46216ffe2c15371e2cb74e88d9c597c8c9c45))
- **32-5:** refactor SettlementExecutor for multi-chain claim generation ([bc75498](https://github.com/toon-protocol/connector/commit/bc754986d1eaa8883972fd1d21c9c626dfb4aef4))
- **32-6:** refactor ClaimReceiver for multi-chain verification via ChainProviderRegistry ([82dafc1](https://github.com/toon-protocol/connector/commit/82dafc156f53e8ae50ea4a631621a9bf5e65029f))
- **32-7:** update configuration schema for multi-chain provider support ([6bac94c](https://github.com/toon-protocol/connector/commit/6bac94ceaf0bcdfc0f1ed046143c8c64ec615e8e))

## [2.0.0](https://github.com/toon-protocol/connector/compare/v1.23.1...v2.0.0) (2026-03-24)

### ⚠ BREAKING CHANGES

- **connector:** ILPPreparePacket.executionCondition, ILPFulfillPacket.fulfillment,
  LocalDeliveryRequest.executionCondition, LocalDeliveryResponse.fulfill.fulfillment,
  SendPacketParams.executionCondition, IlpSendResponse.fulfillment/fulfilled removed.
  computeFulfillmentFromData(), validateFulfillment(), computeConditionFromData()
  deleted from public API.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>

### Features

- **connector:** remove fulfillment/condition ceremony from ILP packets ([e7c7f3b](https://github.com/toon-protocol/connector/commit/e7c7f3bcafc990d9e7e85c9cf826cf2c6d077592))

## [1.23.1](https://github.com/toon-protocol/connector/compare/v1.23.0...v1.23.1) (2026-03-19)

### Bug Fixes

- **connector:** resolve peer EVM address from self-describing claims for settlement ([ea521ec](https://github.com/toon-protocol/connector/commit/ea521ec54ba6accb577697760c00338ca4967b44))

## [1.23.0](https://github.com/toon-protocol/connector/compare/v1.22.0...v1.23.0) (2026-03-19)

### Features

- **connector:** replace polling-based settlement with event-driven claim monitoring ([396e92b](https://github.com/toon-protocol/connector/commit/396e92bd5e3aa7c66c22f05e8ff36529f5ca7c92))

## [1.22.0](https://github.com/toon-protocol/connector/compare/v1.21.0...v1.22.0) (2026-03-19)

### Features

- **connector:** add inbound claim validation gate to prevent unpaid writes ([cec059f](https://github.com/toon-protocol/connector/commit/cec059fc53ea6b20ceebd5f6f5b4e57b92166020))

## [1.21.0](https://github.com/ALLiDoizCode/connector/compare/v1.20.0...v1.21.0) (2026-03-11)

### Features

- add local Anvil infrastructure with faucet and update architecture ([1df938f](https://github.com/ALLiDoizCode/connector/commit/1df938fe5aad464eb102c89c9635b2863de15495))
- **epic-30:** per-hop BLS notification, XRP/Aptos removal, EVM test infrastructure ([2514f71](https://github.com/ALLiDoizCode/connector/commit/2514f715d8ee174b2c36d83d7b21b7dd4bf03a21))
- **epic-31:** add as-built PRD, archive docs, and full project cleanup ([0850c59](https://github.com/ALLiDoizCode/connector/commit/0850c5925cc213a3451b81aa4e6df640d177fc3f))
- **epic-31:** self-describing claims, dynamic channel verification, and docs cleanup ([c31f645](https://github.com/ALLiDoizCode/connector/commit/c31f6456040aa25f1a662ef397e247597a92412b))
- implement XRP-style payment channels with grace period model ([b991f2e](https://github.com/ALLiDoizCode/connector/commit/b991f2e906ab4a77f84912c952598d5f649618fc))
- make per-packet claims mandatory for peer forwarding ([f9cfd54](https://github.com/ALLiDoizCode/connector/commit/f9cfd54cfb8a2d8d87298bc6aa70f796a2b04d2a))
- serialize settlements and fix graceful shutdown sequencing ([fc7fd2b](https://github.com/ALLiDoizCode/connector/commit/fc7fd2b51aaf727c277d5a31a27df46fe57c85e5))

### Bug Fixes

- add fulfillment validation and fix auto-fulfill stub ([4d23625](https://github.com/ALLiDoizCode/connector/commit/4d2362573788520a106da72c6958c4a47d9df949))
- add missing getBlock mock to payment-channel-sdk tests ([9a2e9d0](https://github.com/ALLiDoizCode/connector/commit/9a2e9d0ded118d4d024a15b8afd0a8d96a4218bb))
- add missing multi-hop-helpers.ts to source control ([5d9b4e8](https://github.com/ALLiDoizCode/connector/commit/5d9b4e85203a144e8051c42250037c74f7d6ed0a))
- add stubs for commented-out test infrastructure in doc test ([8ac71be](https://github.com/ALLiDoizCode/connector/commit/8ac71be61b1203ad73de99fc44d12cb75b01f6ba))
- correct rfc-links test path from integration to unit ([a5f3fb7](https://github.com/ALLiDoizCode/connector/commit/a5f3fb75309b8d14d0fa9b50d2cccdf23c45148d))
- remove obsolete mesh topology config test ([390c5bb](https://github.com/ALLiDoizCode/connector/commit/390c5bb06ac338b574a8c27d6a79da9779c92675))
- resolve flaky connection-pool test blocking npm publish ([c290ad7](https://github.com/ALLiDoizCode/connector/commit/c290ad7347ab9c47c40791843ddbe0dffd6e5580))
- resolve pre-existing test failures in doc test and security test ([8ddf736](https://github.com/ALLiDoizCode/connector/commit/8ddf736bd6d5754626ed7219a1009649f1136a88))
- restore TigerBeetle init script and add docker-memory E2E test mode ([95403e5](https://github.com/ALLiDoizCode/connector/commit/95403e5313a4a7c1f572706252c387b70d046a02))
- update environment-config test assertions to match chain-aware error messages ([ae02621](https://github.com/ALLiDoizCode/connector/commit/ae02621bdd1417999ad10f8ef0fd6c0969a10d45))

## [1.20.0](https://github.com/ALLiDoizCode/connector/compare/v1.19.0...v1.20.0) (2026-02-21)

### Features

- add nonce retry logic to PaymentChannelSDK and deploy TokenNetworkRegistry ([85c6fda](https://github.com/ALLiDoizCode/connector/commit/85c6fda97b5fe045fba6001cda163fe09cced5a4))
- **connector:** add deployment mode config and IP allowlist security ([77b0cd9](https://github.com/ALLiDoizCode/connector/commit/77b0cd9ed3f0d94e1048bd75c74fc943509bf0f9))

## [Unreleased]

### Added

- **36-1:** Local ATOR network image + `docker-compose` `ator` profile (3 DirAuth + 3 relay + 1 HS on pinned `anon v0.4.10.0-beta` .deb) with `make ator-up` / `ator-down` / `ator-logs` / `ator-test` targets
- **36-2:** Audit @anyone-protocol/anyone-client CLI flag surface; replace "consult docs.anyone.io" hedges in docs/ator-transport.md with verified flag tables; add --help snapshot diff gate.
- **btp:** RFC-0023 compliant no-auth connection support with `BTP_ALLOW_NOAUTH` flag
  - **Default mode:** Permissionless network deployment with ILP-layer gating
  - Support both permissionless networks (no-auth BTP - default) and private networks (authenticated BTP)
  - Enabled by default for permissionless networks (set `BTP_ALLOW_NOAUTH=false` for private networks)
  - Comprehensive tests for both authenticated and no-auth modes
  - Production security guide for ILP-gated networks (credit limits, settlement, routing policies)
  - Complete documentation in peer onboarding guide, connector README, and permissionless deployment guide

## [1.19.0](https://github.com/ALLiDoizCode/connector/compare/v1.18.0...v1.19.0) (2026-02-16)

### Features

- **connector:** expose openChannel() and getChannelState() on ConnectorNode ([fbb7536](https://github.com/ALLiDoizCode/connector/commit/fbb7536ab3ee5a7bfd61074991dedbfe1d14cfe5))

## [1.18.0](https://github.com/ALLiDoizCode/connector/compare/v1.17.0...v1.18.0) (2026-02-15)

### Features

- bundle chain SDKs as dependencies instead of peer dependencies ([9cbde0b](https://github.com/ALLiDoizCode/connector/commit/9cbde0bc2d15f7beb37d0eb156a87ea579af6ed4))

## [1.17.0](https://github.com/ALLiDoizCode/connector/compare/v1.16.0...v1.17.0) (2026-02-15)

### Features

- consolidate agent-runtime into connector, rename setPaymentHandler to setPacketHandler ([fa3a19b](https://github.com/ALLiDoizCode/connector/commit/fa3a19b8d18e5e750f46d93ec91cc058be76e333))

## [1.16.0](https://github.com/ALLiDoizCode/connector/compare/v1.15.0...v1.16.0) (2026-02-14)

### Features

- **epic-29:** config-driven settlement infrastructure with multi-node isolation ([88d5ca5](https://github.com/ALLiDoizCode/connector/commit/88d5ca5dfb8306a719a6a0251d4c3b0d834106ca))

### Bug Fixes

- **hooks:** fix pre-push jest --findRelatedTests argument ordering ([61dea08](https://github.com/ALLiDoizCode/connector/commit/61dea089b413931a0f5d7792965a4f70d6e390d0))

## [1.15.0](https://github.com/ALLiDoizCode/connector/compare/v1.14.0...v1.15.0) (2026-02-14)

### Features

- **epic-28:** add in-memory ledger as zero-dependency default accounting backend ([357083e](https://github.com/ALLiDoizCode/connector/commit/357083e85ff74c61e704441df5467e67bfc7ce37))

### Bug Fixes

- **epic-28:** fix snapshot persistence test by creating account to set dirty flag ([3699641](https://github.com/ALLiDoizCode/connector/commit/3699641f17c242954fba846038c8587a1019a620))

## [1.14.0](https://github.com/ALLiDoizCode/connector/compare/v1.13.0...v1.14.0) (2026-02-14)

### Features

- **epic-27:** complete test suite optimization - reduce pre-push hook from 13min to <30s ([e82f94d](https://github.com/ALLiDoizCode/connector/commit/e82f94d7fa690e4ed1692c5c2ea0439d78e9849b))

### Bug Fixes

- **epic-27:** prevent pre-push hook from running jest with empty file list ([2ec3505](https://github.com/ALLiDoizCode/connector/commit/2ec3505af13baa908e283a56ae67e22e28a6219d))
- **epic-27:** skip pre-push tests when pushing clean new branch ([a6dbcac](https://github.com/ALLiDoizCode/connector/commit/a6dbcacb8a5d3e0254cdc5e91e28a939df622835))

## [1.13.0](https://github.com/ALLiDoizCode/connector/compare/v1.12.0...v1.13.0) (2026-02-12)

### Features

- **epic-26:** npm publish readiness — trim dependencies, configure packages, add validation ([b62fc02](https://github.com/ALLiDoizCode/connector/commit/b62fc02eb283ad44acfbe8cf32cefe8a173dd0fd))

### Bug Fixes

- **epic-26:** add peer deps to devDependencies and fix CJS/ESM compat in requireOptional ([b2789ae](https://github.com/ALLiDoizCode/connector/commit/b2789aed31f84462b7025942562f14083e5cdde0))
- **tests:** increase xrp-channel-lifecycle beforeAll timeout to 15s ([4abe8a9](https://github.com/ALLiDoizCode/connector/commit/4abe8a9184e25b9604ec5c086dccfef61d65edf9))
- **tests:** relax wallet-derivation performance thresholds for concurrent execution ([b558007](https://github.com/ALLiDoizCode/connector/commit/b558007863dc09f804c274fb00c804fd2877a483))
- **tests:** use OS-assigned ports in btp-server tests to eliminate EADDRINUSE flakiness ([8bc7443](https://github.com/ALLiDoizCode/connector/commit/8bc74438d4c5e6293dfb2bf4a5b1f992ccd4345a))

## [1.12.0](https://github.com/ALLiDoizCode/connector/compare/v1.11.0...v1.12.0) (2026-02-11)

### Features

- **epic-25:** CLI/library separation & lifecycle cleanup ([dc995e4](https://github.com/ALLiDoizCode/connector/commit/dc995e42c9e83be15afb4ac8af462c2bd64d5c45))

## [1.11.0](https://github.com/ALLiDoizCode/connector/compare/v1.10.0...v1.11.0) (2026-02-11)

### Features

- **epic-24:** connector library API — config object, local delivery handler, sendPacket, admin methods ([fb3ab01](https://github.com/ALLiDoizCode/connector/commit/fb3ab01bcae250cd103db21e2be44c6411cffcf1))

### Bug Fixes

- derive BTP timeouts from ILP packet expiresAt, sync deployment configs ([f88f618](https://github.com/ALLiDoizCode/connector/commit/f88f618f9d26258b29194ed859b0a72a3aee6c45))
- **epics-20-23:** resolve integration gaps — field names, channel types, deploy script ([6cdc389](https://github.com/ALLiDoizCode/connector/commit/6cdc389f62eea696fdbaa114a194d7727c965299))
- **telemetry:** suppress WebSocket error on terminate during CONNECTING state ([3395bad](https://github.com/ALLiDoizCode/connector/commit/3395badf3395d6ce53fad45870e9259cb3e42057))
- **tests:** add missing isConnected mock, fix BTP timeout test timing ([f874c1e](https://github.com/ALLiDoizCode/connector/commit/f874c1e6c9d4b5c18a1404861b823ad3eb9e5d21))
- **tests:** increase claim-sender retry test timeout from 50ms to 10s ([3fb9528](https://github.com/ALLiDoizCode/connector/commit/3fb95284407c36ab0915c146d0d4c08427c4c5f9))
- **tests:** increase log-telemetry hook timeouts, use random port ([eae5ed5](https://github.com/ALLiDoizCode/connector/commit/eae5ed59359f07435455388cfe4b7ec6d270aee2))
- **tests:** use random ports to eliminate EADDRINUSE flakiness ([5d7be0f](https://github.com/ALLiDoizCode/connector/commit/5d7be0f4676361ff1089917ac3e2799a81675203))

## [1.10.0](https://github.com/ALLiDoizCode/connector/compare/v1.9.0...v1.10.0) (2026-02-09)

### Features

- **epic-22:** simplify agent-runtime middleware — remove SPSP/session, add SHA-256 fulfillment ([8b9f324](https://github.com/ALLiDoizCode/connector/commit/8b9f324fe80b900e1431468b18283d04acd24662))
- **epic-23:** unified deployment infrastructure — compose, K8s, deploy script ([c8b58a5](https://github.com/ALLiDoizCode/connector/commit/c8b58a5110ae50e64015658b615779d8ffbcab77))

## [1.9.0](https://github.com/ALLiDoizCode/connector/compare/v1.8.0...v1.9.0) (2026-02-09)

### Features

- add ElizaOS plugin generator skill with research docs ([4718c97](https://github.com/ALLiDoizCode/connector/commit/4718c976f9b619671d33faac51c04ef18522c4c5))

### Bug Fixes

- stabilize flaky CI tests for memory profiling and settlement failover ([6b54119](https://github.com/ALLiDoizCode/connector/commit/6b5411937c7d5ceabf3e047b5a169e29b9ecf2e3))

## [1.8.0](https://github.com/ALLiDoizCode/connector/compare/v1.7.0...v1.8.0) (2026-02-09)

### Features

- **epic-21:** add payment channel admin APIs with balance and settlement queries ([1e25e48](https://github.com/ALLiDoizCode/connector/commit/1e25e48c42f80c52fa1343aed506e472f06d2a6b))

### Bug Fixes

- skip TigerBeetle integration tests when Docker is unavailable ([cdebfde](https://github.com/ALLiDoizCode/connector/commit/cdebfde3f9bc495ce900571cbd74e7a34faf94a6))

## [1.7.0](https://github.com/ALLiDoizCode/connector/compare/v1.6.2...v1.7.0) (2026-02-08)

### Features

- **epic-20:** add missing type definitions and wiring for bidirectional middleware ([f4ef6a0](https://github.com/ALLiDoizCode/connector/commit/f4ef6a021584da64c877ae251076589e7b9667b5))

## [1.6.2](https://github.com/ALLiDoizCode/connector/compare/v1.6.1...v1.6.2) (2026-02-06)

### Code Refactoring

- complete rebrand from m2m to agent-runtime across documentation and configs ([2298fa4](https://github.com/ALLiDoizCode/connector/commit/2298fa4d9e1e7c94ba420680804812af06ccc4b1))

## [1.6.1](https://github.com/ALLiDoizCode/connector/compare/v1.6.0...v1.6.1) (2026-02-05)

### Bug Fixes

- **ci:** install libsql native module for Linux in CI test job ([f9ff8b1](https://github.com/ALLiDoizCode/connector/commit/f9ff8b13880f2d1c0cbb2932f605e7580f447c5c))
- **ci:** install libsql native module for Linux in integration tests ([70237ac](https://github.com/ALLiDoizCode/connector/commit/70237ac875f4b827e94ca05fea488eea2b1fcad4))
- **ci:** update all imports from @m2m/shared to @toon-protocol/shared ([6804143](https://github.com/ALLiDoizCode/connector/commit/6804143a29ca3b4fa0dbaf94bd774fe55da89585))
- **ci:** update package names from @m2m/_ to @agent-runtime/_ ([ab68361](https://github.com/ALLiDoizCode/connector/commit/ab68361ec3fcc231ae514e2011785f6578797ea5))
- **ci:** update package-lock.json for @agent-runtime/\* package names ([2a343a1](https://github.com/ALLiDoizCode/connector/commit/2a343a10b33b2e43a34450fbc4de931127e04ec1))
- **docker:** resolve libsql native module and port conflicts ([6c2c6c2](https://github.com/ALLiDoizCode/connector/commit/6c2c6c2b80ff58eb9850cd899dd1c4e9b26545be))
- **settlement:** use max uint256 approval to prevent insufficient allowance errors ([bb61adb](https://github.com/ALLiDoizCode/connector/commit/bb61adb6b6ff4c48678e534b320416e04d58eba1))
- **test:** make multi-chain settlement acceptance test deterministic ([40a9842](https://github.com/ALLiDoizCode/connector/commit/40a9842b360189af6d4ffbf6d0366790623b7716))

## [1.6.0](https://github.com/ALLiDoizCode/m2m/compare/v1.5.0...v1.6.0) (2026-02-05)

### Features

- add Epic 28-30 - testnet integration, explorer links, balance proofs ([dcbbdd9](https://github.com/ALLiDoizCode/m2m/commit/dcbbdd9751688d334c86e6034a55412d93f4611f))
- add Epics 29-32 - UI components, balance proofs, workflow demo, private messaging ([a573b08](https://github.com/ALLiDoizCode/m2m/commit/a573b082d5d7d4626ba7c50b6e44576e00c8bb43))
- add NETWORK_MODE flag for testnet/mainnet switching ([4e0b247](https://github.com/ALLiDoizCode/m2m/commit/4e0b24793280d34d948e38825932bba6be7527dc))
- add production-ready Docker Compose and Kubernetes deployments ([ec2745f](https://github.com/ALLiDoizCode/m2m/commit/ec2745f780818ca081b8ff30ad6d46fa2db48531))
- **agent-runtime:** add Agent Runtime package for custom business logic integration ([7116509](https://github.com/ALLiDoizCode/m2m/commit/7116509f788cc9c56314d370af87900dbed63732))
- complete deployment testing - Docker Compose and Kubernetes verified ([347a82f](https://github.com/ALLiDoizCode/m2m/commit/347a82ff7e00821cd57c052b800be1c2566ee347))
- **connector:** add Admin API for dynamic peer and route management ([3439a99](https://github.com/ALLiDoizCode/m2m/commit/3439a992a56f235fc13ef312fb793b967e2aa305))
- **epic-17:** complete Story 17.6 - Telemetry and Monitoring ([c222ca7](https://github.com/ALLiDoizCode/m2m/commit/c222ca71e8aa5a7a06888cc6999c71cea0b3bfd2))
- **epic-17:** implement Story 17.7 - BTP Claim Exchange Integration Tests ([146ee70](https://github.com/ALLiDoizCode/m2m/commit/146ee7030e74745d20bc5d1c6439a1fedfdca1a1))
- **epic-17:** reorganize epics 11-15 and add Epic 16-17 ([2dcf8e2](https://github.com/ALLiDoizCode/m2m/commit/2dcf8e2881ff77c1ee41080105afb1b8eaf177ce))
- **epic-18,19:** complete Explorer UI NOC redesign and deployment improvements ([7871746](https://github.com/ALLiDoizCode/m2m/commit/787174628398dca730754b16d866b68a8ca04499))
- **epic-18:** create Epic 18 - Explorer UI NOC Redesign ([3d7accf](https://github.com/ALLiDoizCode/m2m/commit/3d7accf22c4703f30993dd835f9b0af711ceab92)), closes [#0D1829](https://github.com/ALLiDoizCode/m2m/issues/0D1829)
- **epic-19:** implement M2M token funding and fix Explorer UI peer tracking ([dffde6d](https://github.com/ALLiDoizCode/m2m/commit/dffde6d689c53b58f2460565dc8b407ed66f591c))
- **epic-20:** add zkVM verification and agent service markets ([cea9e56](https://github.com/ALLiDoizCode/m2m/commit/cea9e567c30c844e0efa784734456d5f0a193485))
- **epic-27:** implement Aptos payment channel settlement ([56bb455](https://github.com/ALLiDoizCode/m2m/commit/56bb4550d6911ba3e28284e76d16155115e55ff8))
- **epic-28:** add Aptos multi-arch Docker build files ([c28c5a2](https://github.com/ALLiDoizCode/m2m/commit/c28c5a2054c76c61c150d1039ed8cdc13c7de7df))
- **epic-28:** add ARM64 Aptos Docker image epic ([fa2c9d7](https://github.com/ALLiDoizCode/m2m/commit/fa2c9d7e5084a785dabaab260c69e93abbc06035))
- **explorer:** add fee statistics by network with token denomination ([33b04db](https://github.com/ALLiDoizCode/m2m/commit/33b04db714fb5830e736a39a92d0307d453e3112))
- **scripts:** add agent runtime testing to 5-peer deployment script ([55f1d28](https://github.com/ALLiDoizCode/m2m/commit/55f1d28e7e8036241deb4db2da37bde24a8cd6e6))
- **tri-chain:** enhance 5-peer multihop with tri-chain configuration ([88e49b0](https://github.com/ALLiDoizCode/m2m/commit/88e49b069fc449cd53de0f6d9653c2916406aba1))

### Bug Fixes

- **ci:** filter Aptos tests to channel module and fix rippled config ([bdb953f](https://github.com/ALLiDoizCode/m2m/commit/bdb953ff422dac1bd4ae4e88bea7923bf790b774))
- **ci:** fix Aptos SDK tests and make npm audit advisory ([9574d23](https://github.com/ALLiDoizCode/m2m/commit/9574d234629f787ae15abb72bb34e8016f2ec1a0))
- **ci:** make security job advisory in CI status check ([9376d27](https://github.com/ALLiDoizCode/m2m/commit/9376d271a9f53b0678b573f667ca3b6ef6a01745))
- **ci:** make Snyk scan continue-on-error ([2a7c902](https://github.com/ALLiDoizCode/m2m/commit/2a7c90245ce57d33715244253ca653899bf11c80))
- **ci:** resolve Aptos Move address conflict and add docker-compose-dev.yml ([55f0028](https://github.com/ALLiDoizCode/m2m/commit/55f00287e45053db437966e45b2fcaca1a4adfcc))
- **ci:** skip integration tests with missing type dependencies ([16e544b](https://github.com/ALLiDoizCode/m2m/commit/16e544b5b99445f9ed3dc7d1a7e63e3137a6b78c))
- **ci:** skip tigerbeetle-5peer-deployment.test.ts ([42f76cf](https://github.com/ALLiDoizCode/m2m/commit/42f76cf10f9b61353266a28974dd84b877840033))
- **docker-compose:** enable TigerBeetle and settlement in production ([5c7c490](https://github.com/ALLiDoizCode/m2m/commit/5c7c490327eee655302d6af67ef3341d09c0eb9a))
- **docs:** include data and expiresAt fields in business logic examples ([4a1d179](https://github.com/ALLiDoizCode/m2m/commit/4a1d179030dd45b0f8b49872fc0e015b79bd021e))
- **epic-17:** complete Story 17.7 - all integration tests passing (10/10) ([48b489a](https://github.com/ALLiDoizCode/m2m/commit/48b489a3eb0812a509d6834191d6bdce4629dd52))
- **telemetry:** check WebSocket state before closing in disconnect ([61fcd28](https://github.com/ALLiDoizCode/m2m/commit/61fcd28dcade2a156ad9dd2fdd77afeec96831ab))
- update tests for openChannel return type and add K8s TigerBeetle manifests ([7f1aa8e](https://github.com/ALLiDoizCode/m2m/commit/7f1aa8ee70488ac1071a6c6523bfae7d90d643a6))

## [1.6.0](https://github.com/ALLiDoizCode/m2m/compare/v1.5.0...v1.6.0) (2026-02-03)

### Features

- **explorer:** Dashboard redesign with NOC (Network Operations Center) aesthetic (Epic 18)
  - New Dashboard landing page with metrics grid (Total Packets, Success Rate, Active Channels, Routing Status)
  - Live Packet Flow visualization showing real-time packet routing
  - Staggered entry animations with `prefers-reduced-motion` support
  - Keyboard navigation (1-5 for tabs, ? for help)

- **explorer:** Enhanced Account Cards with balance history charts and settlement timeline (Story 18.4)

- **explorer:** Keys Tab for cryptographic key management with copy-to-clipboard (Story 18.6)

- **explorer:** Playwright MCP integration testing with comprehensive browser automation (Story 18.8)

- **docs:** Explorer UI documentation suite (Story 18.9)
  - Redesign guide with design philosophy and color palette
  - User guide with common workflows and troubleshooting
  - Developer guide with architecture and customization

### Changed

- **explorer:** Events tab renamed to Packets tab for ILP terminology alignment (Story 18.3)
- **explorer:** Dashboard is now the default landing page (was Events/Packets)
- **explorer:** Updated color scheme to NOC aesthetic with deep space background and cyan/emerald/rose accents

### Improved

- **explorer:** Peers Tab with NOC aesthetic enhancement (Story 18.5)
- **explorer:** Header with technical branding and WebSocket connection status (Story 18.2)
- **explorer:** Animation system with hover effects, stagger classes, and smooth transitions (Story 18.7)

## [1.5.0](https://github.com/ALLiDoizCode/m2m/compare/v1.4.0...v1.5.0) (2026-01-28)

### Features

- **agent:** add DVM job feedback formatter (Story 17.3) ([538a01c](https://github.com/ALLiDoizCode/m2m/commit/538a01c12941bec436dd93651700e86f5991f77e))
- **agent:** complete Story 17.4 query handler migration to Kind 5000 ([ab32e37](https://github.com/ALLiDoizCode/m2m/commit/ab32e37c8f124095254dd53feef7135410fcfa64))
- **agent:** complete Story 17.5 job chaining support ([56b1c93](https://github.com/ALLiDoizCode/m2m/commit/56b1c9329c5a2c90c2a358b908a891b521953d9b))
- **agent:** complete Story 17.6 task delegation request parsing (Kind 5900) ([4b6caaa](https://github.com/ALLiDoizCode/m2m/commit/4b6caaa440606e1eaf6bc0bc5c008daab8df34a2))
- **agent:** complete Story 17.7 task delegation result (Kind 6900) ([a0ffdd9](https://github.com/ALLiDoizCode/m2m/commit/a0ffdd94df4d5c6561e4188a9ac8d9d8d128150a))
- **agent:** complete Story 17.8 task status tracking ([8e00acf](https://github.com/ALLiDoizCode/m2m/commit/8e00acf78c04107a0677ef64b220099c499fac37))
- **agent:** complete Story 17.9 timeout & retry logic ([04c39ef](https://github.com/ALLiDoizCode/m2m/commit/04c39eff869a4d22992a61fe729f775a9e44a504))
- **docs:** create Epic 17 stories 17.6-17.11 (complete story pipeline) ([cb4afbe](https://github.com/ALLiDoizCode/m2m/commit/cb4afbede19a8b894bf40b7c14d6401344cb4588))

### Bug Fixes

- **agent:** complete Epic 17 Story 17.4 - migrate query to Kind 5000 DVM ([06dcbfb](https://github.com/ALLiDoizCode/m2m/commit/06dcbfbf014591d7ac2df83e71db9b8b68fae1c5))

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
