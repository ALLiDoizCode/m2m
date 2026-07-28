# Wire vectors

`wire-vectors.json` is the cross-repo contract for the client-edge termination wire (issue #527,
[ADR 0021](../docs/adr/0021-vectors-are-normative-prose-is-not.md)): reproducing these bytes is
what conformance means for `toon-client`, `rig` and `swap`. It is generated, not hand-written --
see `crates/connector-vectors` and `docs/protocol/wire-vectors.md` for the invariants each section
is evidence of. This file is plain JSON so a client SDK can replay it without importing anything
from this repository.

Regenerate after any change to the envelope (`connector_domain::envelope`), the gift wrap
(`connector_signer::giftwrap`), or the condition/fulfilment code
(`connector_domain::condition`/`connector_signer::giftwrap::derive_fulfillment`):

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
condition it satisfies.

- `cases[]`: `{ name, shared_secret_hex, fulfilment_hex, condition_hex, matches }`.
  `fulfilment_hex` is what a real connector derives from `shared_secret_hex`; `matches` says
  whether `fulfilment_hex` satisfies `condition_hex` under the standard
  `sha256(fulfilment) == condition` check -- both `true` and `false` cases are included, so a
  replaying SDK exercises rejection as well as acceptance.
