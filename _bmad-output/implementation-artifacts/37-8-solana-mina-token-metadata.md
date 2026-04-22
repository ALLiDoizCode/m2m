# Story 37.8: On-Chain Token Metadata for Solana and Mina

Status: ready-for-dev
Filed: 2026-04-22
Origin: Story 37.4 deferred-work D4.

## Story

As the Townhouse dashboard,
I want `(assetCode, assetScale)` on `/admin/earnings.json` to be resolved via real on-chain lookups for Solana SPL tokens and Mina zkApp tokens (matching the EVM behaviour shipped in 37.4),
so that multi-chain deployments display human-readable symbols and correct decimal scaling instead of raw mint/token-ID strings.

**Epic:** 37.
**Priority:** P2 (only matters for Solana/Mina deployments; EVM-only deployments already work).
**Estimated effort:** 2 points (~half day).

## Context

Story 37.4's `ConnectorNode._createTokenMetadataResolver()` returns a real on-chain resolver for EVM via `ethers.Contract.symbol()` + `decimals()`. Solana and Mina fall back to `{ assetCode: raw_address, assetScale: 0 }`:

```ts
if (blockchain !== 'evm' || !this._paymentChannelSDK || !tokenAddress) {
  this._tokenMetadataCache.set(cacheKey, fallback);
  return fallback;
}
```

Townhouse's dashboard will render a USDC balance on Solana as `{ assetCode: '<SPL mint base58>', assetScale: 0, amount: '5000000' }` — unusable.

## Acceptance Criteria

### AC 1: Solana SPL mint decimals resolved via on-chain RPC

```gherkin
Scenario: Solana assetScale reflects SPL mint decimals
  Given a Solana peer with claims on an SPL token mint 'MintAaaaa...'
  And the on-chain mint has decimals=6
  When GET /admin/earnings.json is requested
  Then the corresponding byAsset entry reports assetScale=6
  And assetCode is either the mint's Metaplex Token Metadata symbol (when available) or the mint address truncated to 8 chars as a fallback
```

### AC 2: Mina zkApp token metadata

```gherkin
Scenario: Mina tokens surface with documented fallback behaviour
  Given a Mina peer with claims on tokenId='<base58 token id>'
  When GET /admin/earnings.json is requested
  Then byAsset[].assetCode is set to the tokenId string (Mina has no standard token-symbol field)
  And byAsset[].assetScale is set from the zkApp's on-chain state if the provider exposes a `tokenDecimals` field, otherwise defaults to 9 (Mina native precision)
  And the fallback behaviour is explicitly documented in the resolver's JSDoc
```

### AC 3: Cache + fallback parity with EVM

- Results cached in `ConnectorNode._tokenMetadataCache` for the connector's lifetime.
- On RPC failure, returns the raw-address fallback and logs at warn level — mirrors the EVM path, never throws into the endpoint.

### AC 4: No regression in EVM behaviour or 37.4 tests

Full suite green.

## Tasks / Subtasks

- [ ] T1. Add `SolanaPaymentChannelProvider.getTokenMetadata(tokenAddress)` OR add a `SolanaPaymentChannelSDK.getMintDecimals(mintAddress)` helper (depending on which layer owns on-chain reads). Use `@solana/spl-token`'s `getMint()` via the existing `Connection`.
- [ ] T2. (Optional) Integrate Metaplex Token Metadata Program lookup for symbol resolution. If that's out of scope, document that Solana `assetCode` is always the raw mint address.
- [ ] T3. Add `MinaPaymentChannelProvider.getTokenMetadata(tokenId)`. Read on-chain token metadata via o1js / GraphQL — or document that Mina tokens don't carry standard metadata and return `{ assetCode: tokenId, assetScale: 9 }` as a typed fallback.
- [ ] T4. Extend `ConnectorNode._createTokenMetadataResolver()` to dispatch to the Solana / Mina providers based on the `blockchain` argument. The current switch is one `if (blockchain !== 'evm')` line.
- [ ] T5. Tests:
  - Unit test for each provider's `getTokenMetadata` against a known mint/token fixture.
  - Integration test in the earnings-endpoint suite seeding a Solana claim and asserting the resolver outputs the right scale.
- [ ] T6. Update `37-4` dev-notes to reflect the new chain coverage.

## Dev Notes

- SPL Token's `getMint()` only returns `decimals` + `supply` + `mintAuthority` — no symbol. Metaplex adds a separate metadata account at a PDA derived from the mint. Implementing full Metaplex lookup is a half-day of work on its own; ship this story with decimals-only if Metaplex turns out to be a rabbit hole.
- Mina's Token ID is a hash; there's no canonical `(symbol, decimals)` on-chain for non-native tokens. Document this limitation explicitly.
- When an RPC call times out or the mint account doesn't exist, return fallback + warn log. Never let the metadata resolver break the endpoint — that's the contract set in 37.4.

## Links

- Origin: `_bmad-output/implementation-artifacts/37-4-admin-earnings-json-endpoint.md` follow-up D4.
- EVM precedent: `ConnectorNode._createTokenMetadataResolver()`.
- `@solana/spl-token` — already a transitive dep via `solana-payment-channel-sdk.ts`.

## Change Log

| Date | Change |
|------|--------|
| 2026-04-22 | Story promoted from 37.4 D4. Status: ready-for-dev. |
