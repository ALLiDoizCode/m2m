# Wire vectors

`wire-vectors.json` is the cross-repo contract for the client-edge termination wire (issue #527,
[ADR 0021](../docs/adr/0021-vectors-are-normative-prose-is-not.md)): reproducing these bytes is
what conformance means for `toon-client`, `rig` and `swap`. It is generated, not hand-written --
see `crates/connector-vectors` and `docs/protocol/wire-vectors.md` for the invariants each section
is evidence of. This file is plain JSON so a client SDK can replay it without importing anything
from this repository.

Regenerate after any change to the envelope (`connector_domain::envelope`), the gift wrap
(`connector_signer::giftwrap`), the condition/fulfilment code
(`connector_domain::condition`/`connector_signer::giftwrap::derive_fulfillment`), or the claim
signing scheme (`connector_signer::claim_signature`):

```
cargo run -p connector-vectors --bin generate-vectors
```

`cargo test -p connector-vectors` (part of the workspace gate) fails if this file is stale --
regenerating it against an unchanged implementation is a no-op, so a diff here always means the
wire actually changed.

## Schema

All byte fields are lowercase hex, no `0x` prefix. `schema_version` bumps only when a field's
meaning changes in a way that would make existing replay code misread it; a purely additive field
does not bump it.

### `envelope`

The structured request/response envelope every terminated packet carries once opened
(`docs/protocol/client-edge-spec.md` §1.8).

- `valid[]`: `{ name, encoded_hex, decoded }`. `encoded_hex` is the canonical OER encoding;
  decoding it must reproduce `decoded` exactly, and re-encoding `decoded` must reproduce
  `encoded_hex` exactly. `decoded.direction` is `"request"` (`method`, `target`, `headers`,
  `body_hex`) or `"response"` (`status`, `headers`, `body_hex`). `headers` is an ordered list of
  `[name, value]` pairs -- order and duplicate names are both significant and must survive.
- `invalid[]`: `{ name, direction, bytes_hex, expected_error }`. Decoding `bytes_hex` as the named
  `direction` must fail with `expected_error` (one of: `buffer_underflow`, `non_canonical_length`,
  `length_determinant_overflow`, `invalid_type`, `invalid_utf8`, `trailing_bytes`) -- never
  succeed, never panic, never fail with a different reason.

### `giftwrap`

The sealed wrap around an envelope (ADR 0018). `receiver_identity_secret_hex` /
`receiver_identity_public_hex` are a fixture keypair -- not a real operator key -- for a client SDK
to test against; `receiver_identity_public_hex` is the value a real connector would report from
`GET /ilp/identity`.

**Mechanism** (everything a replaying SDK needs and cannot get from this file's field names alone):

- The receiver's identity key is a secp256k1 keypair; `receiver_identity_public_hex` is the
  65-byte uncompressed form (`0x04 || X || Y`). The sender ECDHs a fresh, per-packet secp256k1
  ephemeral key against this public key; the shared secret is the ECDH result's raw X-coordinate
  (32 bytes) -- not hashed or otherwise processed before going into HKDF.
- The AEAD key is derived with **HKDF-SHA256, no salt** (`HKDF-Extract` is called with an all-zero
  salt, i.e. `Hkdf::new(None, ikm)`), expanded to 32 bytes with one of three fixed ASCII `info`
  strings, each domain-separating a different derived value from the same ECDH/shared-secret
  input: `toon-giftwrap-request` (the request's AEAD key), `toon-giftwrap-response` (the
  response's AEAD key), `toon-giftwrap-fulfillment` (the `fulfilment` section below).
- The AEAD is **ChaCha20-Poly1305** (RFC 8439), 12-byte nonce, no additional authenticated data.
- Wire framing:
  - A **request** (`request_wrap_hex`) is `0x01 || ephemeral_public_key (65 bytes, uncompressed) ||
nonce (12 bytes) || ciphertext`. The plaintext AEAD encrypts is `shared_secret (32 bytes) ||
encoded_envelope` -- the 32-byte shared secret rides _inside_ the encrypted request, not
    alongside it, which is what lets the response be sealed with no second key exchange.
  - A **response** (`response_wrap_hex`) is `0x02 || nonce (12 bytes) || ciphertext`, where the
    plaintext is just the encoded response envelope -- no embedded secret, since the response is
    sealed directly with `shared_secret_hex`.

Each `cases[]` entry pins every input a real seal draws at random (`ephemeral_secret_hex`,
`shared_secret_hex`, `request_nonce_hex`, `response_nonce_hex`) so the output is reproducible:

- `request_envelope` / `request_envelope_hex`: the plaintext envelope, structured and encoded.
- `request_wrap_hex`: `request_envelope_hex` and `shared_secret_hex` sealed to
  `receiver_identity_public_hex` -- the bytes that ride as `Prepare.data`. Opening it with the
  fixture's secret key must recover `request_envelope_hex` and `shared_secret_hex` exactly.
- `response_envelope` / `response_envelope_hex`: the plaintext response envelope.
- `response_wrap_hex`: `response_envelope_hex` sealed with `shared_secret_hex` (no second key
  exchange) -- the bytes that ride as `Fulfill.data`. Opening it with `shared_secret_hex` must
  recover `response_envelope_hex` exactly, and must fail to open under any other secret.

### `fulfilment`

The fulfilment a terminating connector derives from a request's shared secret (ADR 0019), and the
condition it satisfies. `fulfilment_hex` is `HKDF-SHA256(salt=none, ikm=shared_secret_hex,
info="toon-giftwrap-fulfillment")`, expanded to 32 bytes -- the same HKDF construction as the
`giftwrap` section above, domain-separated from both its AEAD keys by this section's own `info`
string. `condition_hex` is `sha256(fulfilment_hex)`, the standard ILPv4/RFC-0022 condition/
fulfilment relationship.

- `cases[]`: `{ name, shared_secret_hex, fulfilment_hex, condition_hex, matches }`.
  `fulfilment_hex` is what a real connector derives from `shared_secret_hex`; `matches` says
  whether `fulfilment_hex` satisfies `condition_hex` under the standard
  `sha256(fulfilment) == condition` check -- both `true` and `false` cases are included, so a
  replaying SDK exercises rejection as well as acceptance.

### `claim`

A signed EIP-712 `BalanceProof` (ADR 0024) -- the digest and signature scheme both a peer-wire
claim (`docs/protocol/peer-wire-spec.md` §3.5) and a client-edge claim (`client-edge-spec.md` §1.3
step 4) are checked against. This is the scheme that replaced a SHA-256 tuple nothing on chain ever
verified; a client that still signs the old tuple has nothing else in this repository that would
tell it.

- `cases[]`: `{ name, chain_id, token_network_address_hex, channel_id_hex, nonce,
transferred_amount, locked_amount, locks_root_hex, digest_hex, signer_secret_hex,
signer_address_hex, signature_hex }`.
- `chain_id` / `token_network_address_hex` are the EIP-712 domain's `chainId` and
  `verifyingContract` -- configured **per channel** (`ClaimBook::set_channel_domain`), never a
  node-wide default. A vector hardcoding one real chain's values is not evidence of what another
  chain's channel signs; treat this case's `chain_id`/`token_network_address_hex` as one example
  domain, not the only one a real claim can be signed under.
- `channel_id_hex` is the channel's on-chain `bytes32` identifier -- the exact 32 bytes hashed into
  the struct, not a peering relation's own string label for the channel.
- `locked_amount` and `locks_root_hex` are always zero on the wire today (ADR 0004) but are still
  part of the hashed struct -- omitting them computes a different digest than the one a real
  signer signs.
- `digest_hex` is the EIP-712 digest: `keccak256(0x1901 || domainSeparator || structHash)`, where

  ```text
  domainSeparator = keccak256(abi.encode(
                        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                        keccak256("TokenNetwork"), keccak256("1"), chainId, verifyingContract))
  structHash       = keccak256(abi.encode(
                        keccak256("BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"),
                        channelId, nonce, transferredAmount, lockedAmount, locksRoot))
  ```

  every integer field (`chainId`, `nonce`, `transferredAmount`, `lockedAmount`) is a 32-byte
  big-endian ABI word, matching Solidity's `uint256` encoding, and `verifyingContract` is a 20-byte
  address right-aligned into a 32-byte word.

- `signer_secret_hex` / `signer_address_hex` are a fixture secp256k1 keypair -- not a real
  operator or counterparty key -- so a replaying SDK can check both directions: that it computes
  the same `digest_hex` from the other fields, and that a 65-byte `r || s || recovery_id` signature
  over that digest (`signature_hex`; `recovery_id` is raw `0`/`1`, not the `27`/`28` a wallet's own
  signature carries) recovers to `signer_address_hex`.
