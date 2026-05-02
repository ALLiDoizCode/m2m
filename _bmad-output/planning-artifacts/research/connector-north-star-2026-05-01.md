# Connector North Star — Goal of Record

**Date:** 2026-05-01
**Status:** Canonical. This is what the connector is building toward. Other planning artifacts (directives, handoffs, research) serve this goal.

---

## The goal, in one sentence

**One passkey, one identity, every chain, every transport, every level — composed atop the connector's local-delivery pipeline so that any HTTP service can be a paid, settlement-backed TOON node without ILP, SDK, or seed-phrase friction.**

---

## The acceptance test (binary)

Can a stranger, on a fresh laptop, with one passkey ceremony, deploy a docker container that becomes a paid TOON node receiving ILP packets, settling claims on three chains, signing everything with their own key, with no SDK code and no seed phrase to write down?

If yes — goal met.
If no — we ship the next phase until yes.

This test is intentionally end-to-end. It collapses into a single yes/no the four constraints we keep restating: (a) any HTTP container can be a node, (b) one passkey is the entire identity story, (c) settlement spans EVM + Solana + Mina, (d) zero SDK and zero seed phrase.

---

## Three tiers of the goal

### Tier 1 — Mechanical (Phase 1)

Move the ILP payment boundary into the connector's `LocalDeliveryClient` so any HTTP service plus a `toon.json` becomes a TOON node. The connector owns Schnorr verification, per-pubkey nonce monotonicity, dedup, and pricing enforcement before the app ever sees the request. The app receives a signed-off, paid-for HTTP request and returns 200/4xx.

Concrete artifacts: `connector-directives-ilp-as-tcp-2026-05-01.md` is the v1 spec for this tier — three-phase commit pipeline, two-phase nonce store, native-signing pre-stages, v2 envelope behind a config flag, `accept_from` allowlist, strict zod schema with no parsed-but-unused fields.

Acceptance for Tier 1: unmodified `strfry` stores Nostr events via ILP with zero SDK imports, in nightly HTTP-surface CI.

### Tier 2 — Architectural (Phase 2)

One passkey ceremony, processed through the WebAuthn PRF extension and HKDF with domain-separated `info` strings, deterministically derives every signing key the operator and connector need:

- **Ed25519** — RFC 9421 HTTP-Sig on admin API, ILP-over-HTTP peer, connector-to-app
- **secp256k1 ECDSA** — BTP claim signing, EVM settlement TXs
- **Ed25519** — Solana settlement TXs
- **Schnorr-over-Pallas** — Mina settlement TXs
- **BIP-340 Schnorr secp256k1** — Nostr event signing (for TOON envelope identity, settlement-attestation receipts, kind-30400 TownHub registry events)
- **Ed25519** — app-side verify key for echo / receipt path

The passkey is the root. Each level signs in its native algorithm. Recovery enforced by ≥ 2 passkeys at registration (principle P-7 from the research). Seed-phrase fallback shipped from day one — no Coinbase Smart Wallet repeat.

Concrete artifact: `technical-http-sigs-webauthn-nostr-research-2026-05-01.md`, Architecture B + Pattern E, four-phase roadmap in §9.

Acceptance for Tier 2: a new operator registers with one passkey, the connector configures all six derived keys, settlement crosses thresholds on all three chains using the operator's own keys, the operator never types or copies a seed phrase.

### Tier 3 — Strategic (the why)

The connector becomes the standards-aligned, user-sovereign payment substrate for the open web. ILP as the transport. TOON as the application layer atop ILP. RFC 9421 as the wire authentication. WebAuthn-PRF as the identity root. Nostr as the cross-domain identity surface and settlement-attestation layer.

Other projects ship one of these axes — passkey wallets without standards-aligned transport, signed-HTTP frameworks without crypto identity, Nostr clients without payment rails. The strategic asset is the composition, not any single layer. This connector is the only place where all three are layered correctly atop a multi-chain settlement engine.

#### Concrete realization: paid home hosting

The strategic claim above is abstract. The concrete realization, end-to-end, is this: **a developer with a Raspberry Pi and a residential internet connection can host an HTTP service, advertise it, and be paid for it — with no public IP, no port forward, no DNS registration, no datacenter, no payment processor, and no centralized gatekeeper at any layer.**

Four orthogonal systems compose to make this work, each owning one axis:

| System | What it contributes | Owned by |
|---|---|---|
| **ATOR overlay (Anyone Protocol fork of Tor 0.4.9.x)** | NAT traversal without port forwarding; operator IP privacy; `.anon` hidden-service addressing; token-incentivized relays | `transport.type: "socks5"` in this codebase; Epic 35; pinned `v0.4.10.0-beta`; nightly real-binary CI |
| **Connector pipeline (this project)** | ILP routing, multi-chain settlement (EVM/Solana/Mina), local-delivery pipeline that turns any HTTP service into a paid TOON node, RFC 9421 wire auth, passkey-PRF identity root | Tier 1 + Tier 2 of this doc |
| **TownHub registry over Nostr** | Discovery: kind:30400 events advertise a node's `.anon` address, kinds it serves, pricing | Townhouse / TOON Protocol team |
| **Operator passkey** | Single hardware-backed identity root → six native signing keys via WebAuthn-PRF | Tier 2 of this doc |

**End-to-end flow:** developer ships a docker image of their service, drops a `toon.json` next to it, runs it on a Pi at home behind a residential router. Connector boots ATOR, spawns a `.anon` hidden service, advertises the node in a kind:30400 Nostr event signed by the operator's passkey-derived Nostr key. Anyone in the world finds the node via Nostr, resolves the `.anon` address through ATOR, sends an ILP packet, the connector verifies + settles + delivers. Money moves on EVM/Solana/Mina; data moves over onion-routed HTTP; identity is one passkey; no public IP touched anywhere.

**This is what the strategic claim cashes out to.** The substrate that makes home hosting commercially viable for the open web — not as a side-effect of abstract design, but as the explicit composition of four already-shipping or already-specified systems.

#### What this realization is bounded by

To prevent over-claiming:

- **Latency profile is request-response, not interactive.** ATOR adds 200–600 ms per circuit. Fine for paid APIs, transcoding jobs, DVMs, relays, batch services. Not fine for video streaming, gaming, or sub-100 ms interactive UIs. The substrate is "decentralized API economy," not "Tor-replacement web2."
- **State is the operator's problem.** The composition handles network and payment. Persistent storage, backups, redundancy are out of scope. Stateless or small-state services run great on a Pi; large-state apps still need infrastructure.
- **Discovery centralization is bounded by Nostr's relay diversity.** TownHub is more open than DNS, but it's not zero-trust. If the few relays a node publishes to all go down, the node becomes unreachable until republished.
- **Legal posture is unchanged.** Operators of services are still operators of services in their jurisdictions. ATOR hides IP, not regulatory liability.
- **DOS resistance is not free.** ATOR doesn't rate-limit; the connector's per-pubkey limits and pricing gate help, but a Pi getting hammered still falls over.

These constraints scope the claim; they don't break it. Within scope, the composition is real and the implementation is shipping.

---

## What this goal is NOT

To pre-empt drift:

- **Not "RFC 9421 signs at every level."** RFC 9421 is HTTP-transport-only. Architecture C (Nostr-key-as-RFC-9421-keyid) remains aspirational, blocked on an IANA registration that no one has filed. The unifier across levels is the **passkey-PRF root**, not a single wire format.
- **Not "Nostr replaces ILP."** ILP remains the routing and settlement substrate; Nostr is the identity and event-publishing layer. They compose; neither subsumes the other.
- **Not "every node is a Nostr relay."** A TOON node is any HTTP service + `toon.json`. Relays are one example (the strfry acceptance test). DVMs, mills, Arweave gateways, Tor onion services are equally valid TOON nodes.
- **Not "the SDK goes away tomorrow."** v2 envelope ships behind a config flag; v1 envelope is preserved through a long migration window per the directives doc. The SDK becomes optional, then deprecated, then deleted — over multiple releases.
- **Not a closed system.** Every layer is an open standard (IETF, W3C, FIDO Alliance, Nostr NIPs). The connector ships reference implementations; it does not ship a private protocol.
- **Not a Tor-replacement for general web browsing.** The ATOR overlay is wired for paid request-response services and inter-peer privacy, not for replacing the clearnet web. Latency profile is wrong for interactive media (see "What this realization is bounded by" above).

---

## Phased path

| Phase | Tier | Status | Exit gate |
|---|---|---|---|
| 0 — Foundations | T1 prep | not started | Vitest fixtures for RFC 9421 §B golden vectors green; `@noble/curves` confirmed; `better-sqlite3` migration tooling ready |
| 1 — Local delivery pipeline | T1 | spec complete (directives doc) | Unmodified `strfry` passes acceptance test in nightly CI |
| 2 — Passkey-PRF identity root | T2 | research complete | New operator registers with passkey; six derived keys live; settlement on all three chains uses operator's own keys; no seed phrase typed |
| 3 — Schnorr-secp256k1 IANA contribution | T3 polish | optional | Either IANA registration accepted or private-profile shipped; Architecture C becomes available |
| 4 — PQ migration | T3 future | tracking | ML-DSA + Ed25519 hybrid stable in WebAuthn and RFC 9421 drafts; ~12-18 months out |

Phases 1 and 2 are in scope for the current planning horizon. Phase 3 is a strategic standards contribution opportunity, not a delivery commitment. Phase 4 is a tracking issue.

---

## How to use this document

- New planning artifacts (PRDs, tech specs, story breakdowns) MUST cite this north star and explain how the proposed work serves Tier 1, 2, or 3.
- Architectural decisions that conflict with this north star require an explicit override doc citing why the goal has changed, not a quiet drift.
- The acceptance test (above) is the single binary indicator. If a proposed feature does not move the acceptance-test answer from "no" to "yes" — or maintain a "yes" answer once we have one — it is not a goal-aligned investment.
- Tier 1 work product is owned by the connector team. Tier 2 work product is owned jointly with Townhouse (passkey UX is in their scope; the derived-key plumbing is in ours). Tier 3 is a community contribution and not on any team's delivery sprint.

---

## Related artifacts (in the same research dir)

- `connector-handoff-ilp-as-tcp-2026-05-01.md` — Townhouse's original ask
- `connector-reply-ilp-as-tcp-2026-05-01.md` — connector's diagnostic reply with eight design gaps
- `townhouse-reply-to-connector-ilp-as-tcp-2026-05-01.md` — Townhouse's gap resolutions
- `connector-directives-ilp-as-tcp-2026-05-01.md` — connector's authoritative spec for Tier 1 (the local-delivery pipeline)
- `technical-http-sigs-webauthn-nostr-research-2026-05-01.md` — research basis for Tier 2 (Architecture B / Pattern E) and Tier 3 (Architecture C)
- `technical-tor-onion-routing-research-2026-04-13.md` — research basis for the ATOR overlay transport layer of the concrete realization (Epic 35; shipping in `transport.type: "socks5"`)
- `toon-ilp-as-tcp-townhub-design-2026-05-01.md` — Townhouse's full architecture spec (TownHub registry, mill NIP, DVM splitting, dashboard UX)
