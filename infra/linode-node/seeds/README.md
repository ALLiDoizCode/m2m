# Curated bootstrap seed registry (devnet v0)

`relays.json` is the **signed seed-registry manifest** for the connector's
cold-start bootstrap (toon-meta#153, connector#343). It lists the well-known
TOON devnet relay seed(s) and is signed **as a whole document** with a BIP-340
schnorr signature over `sha256(canonicalJson(manifest minus "sig"))`.

> **Frozen (#457).** The implementation of that signing/verification scheme
> lived in `packages/connector/src/discovery/`, which was deleted along with
> the embedded `ConnectorNode`. Nothing in this repository now signs, verifies
> or consumes this manifest, and `scripts/sign-seed-manifest.mjs` — which
> required the built `dist/discovery/bootstrap-manifest.js` and had therefore
> been exiting 1 on every invocation — was removed with it. The committed
> `relays.json` and its signature are still valid and are left in place as the
> record of the devnet seed set; treat this directory as read-only until the
> discovery/bootstrap surface is resolved (it is an open decision on #457, and
> the Rust connector has no equivalent yet). Both the signer script and the
> reference implementation are recoverable from git history:
> `git log -- scripts/sign-seed-manifest.mjs packages/connector/src/discovery`.

Everything in this file is public data (relay URLs + the curator public key +
a signature). The curator **secret** key is never committed anywhere in this
repo.

## Verification

The scheme (as implemented before #457, and as any replacement must behave):
connectors fetch this document from `bootstrap.registryUrl` and verify the
signature against the **pinned** curator pubkey — `bootstrap.curatorPubkey`
from config, else a hardcoded `FALLBACK_CURATOR_PUBKEY`. The manifest's own
embedded `curatorPubkey` field is informational, signed data only — it is
never used as the verification key, so a manifest cannot self-certify.

Current devnet curator public key (matches `FALLBACK_CURATOR_PUBKEY`):

```
0342e0b25c7b41cbc36ec3b350bcecf378a386fec7a3c2d49e1dd0de1b1d735a
```

A round-trip test used to verify this committed file against the shipped
fallback key on every CI run; it was deleted with the discovery surface, so
this file is currently unverified by CI.

## Regenerating / rotating

**Not currently possible in this repo** — see the note at the top. The curator
secret lives OUTSIDE the repo, by convention under `~/.toon-curator/`
(`devnet-curator.key`, 64-char hex, `chmod 600`), and is unaffected. Editing
the entry list, refreshing `updatedAt`, or rotating the curator key all require
a signer, and restoring one means restoring (or reimplementing, in Rust) the
canonical-JSON + BIP-340 code the signature is defined against — a byte-exact
`canonicalJson` is load-bearing, so do not hand-roll a replacement.

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
