# Curated bootstrap seed registry (devnet v0)

`relays.json` is the **signed seed-registry manifest** for the connector's
cold-start bootstrap (toon-meta#153, connector#343). It lists the well-known
TOON devnet relay seed(s) and is signed **as a whole document** with a BIP-340
schnorr signature over `sha256(canonicalJson(manifest minus "sig"))` — see
`packages/connector/src/discovery/bootstrap-manifest.ts`.

Everything in this file is public data (relay URLs + the curator public key +
a signature). The curator **secret** key is never committed anywhere in this
repo.

## Verification

Connectors fetch this document from `bootstrap.registryUrl` and verify the
signature against the **pinned** curator pubkey: `bootstrap.curatorPubkey`
from config, else the hardcoded `FALLBACK_CURATOR_PUBKEY` in
`packages/connector/src/discovery/bootstrap-seeds.ts`. The manifest's own
embedded `curatorPubkey` field is informational, signed data only — it is
never used as the verification key, so a manifest cannot self-certify.

Current devnet curator public key (matches `FALLBACK_CURATOR_PUBKEY`):

```
0342e0b25c7b41cbc36ec3b350bcecf378a386fec7a3c2d49e1dd0de1b1d735a
```

A round-trip test (`packages/connector/src/discovery/bootstrap-manifest.test.ts`)
verifies this committed file against the shipped fallback key on every CI run.

## Regenerating / rotating

The curator secret lives OUTSIDE the repo, by convention under
`~/.toon-curator/` (`devnet-curator.key`, 64-char hex, `chmod 600`). To
re-sign after editing the entry list (or just to refresh `updatedAt`):

```bash
npm run build --workspace=packages/connector
node scripts/sign-seed-manifest.mjs          # reads ~/.toon-curator/devnet-curator.key
```

To rotate the curator key: generate a new BIP-340 keypair into
`~/.toon-curator/`, run `node scripts/sign-seed-manifest.mjs --key <path>`,
update `FALLBACK_CURATOR_PUBKEY` in
`packages/connector/src/discovery/bootstrap-seeds.ts` to the new public key,
and republish this manifest wherever `bootstrap.registryUrl` points.

## Hosting

Operators point `bootstrap.registryUrl` at wherever this file is served over
`https://` (e.g. `https://seeds.devnet.toonprotocol.dev/relays.json`).
Serving it at a public HTTPS URL is a deploy step tracked separately — this
directory is the source of truth, not a live endpoint.

## Future work (production/mainnet)

- Production/mainnet registry with its own curator key and hardened custody
  (offline signer / HSM) — the devnet key here is single-operator custody.
- Long-term hosting on ArNS/Arweave for a permanent, content-addressed
  `registryUrl`.
