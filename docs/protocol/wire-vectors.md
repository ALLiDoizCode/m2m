# Wire vectors: the invariants behind them

**Status:** Non-normative. Per [ADR 0021](../adr/0021-vectors-are-normative-prose-is-not.md), the
committed vector set (`vectors/wire-vectors.json`) is the cross-repo contract; this document only
names the invariants it is evidence of, written down before any vector was generated, per its own
acceptance criterion. A disagreement between this text and the vectors is a bug in this text.
**Consumers:** anyone regenerating or extending the vector set (`crates/connector-vectors`);
`toon-client`, `rig` and `swap`, as background for what the bytes they replay are supposed to mean.

## Scope

This covers the **client edge** termination wire (issue #498): the structured envelope
(`connector_domain::envelope`), the gift wrap sealing it (`connector_signer::giftwrap`), and the
fulfilment a terminating connector derives from it (ADR 0019). It does not cover the **peer wire**
(`docs/protocol/peer-wire-spec.md`) — that wire is operator-to-operator on both ends (ADR 0003),
already normative prose for a different reason, and out of this issue's scope.

## Invariants

### 1. An envelope round-trips

Encoding an [`EnvelopeRequest`] or [`EnvelopeResponse`] and decoding the result returns exactly
the value that was encoded — for every value the type can hold, not only worked examples.

Held open by `connector-domain`'s `envelope::tests::any_request_round_trips` and
`any_response_round_trips` (arbitrary method/target/headers/body, arbitrary status), plus
`header_list_round_trips_exactly` (order and duplicate names both survive, since a header list is
encoded as a sequence, never a map).

### 2. Decode refuses malformed input, distinguishably and without panicking

`EnvelopeRequest::decode`/`EnvelopeResponse::decode` never panic on arbitrary bytes
(`decode_never_panics_on_arbitrary_bytes`), and every byte sequence either one accepts re-encodes
to exactly itself — no two distinct byte sequences decode to the same envelope
(`request_decode_accepts_only_bytes_that_reencode_to_themselves`,
`response_decode_accepts_only_bytes_that_reencode_to_themselves`). This is what makes the OER
length determinants canonical (ADR 0023): a non-minimal encoding, a zero-length long-form alias,
and an over-wide determinant are each refused with a distinct, named `EnvelopeError` variant
rather than accepted as a synonym for some other encoding of the same value or truncated into
one. A wrong type byte and trailing bytes after an otherwise-complete envelope are refused the
same way.

### 3. A sealed payload opens only under the intended key, in both directions

A request sealed with [`seal_request`] to a receiver's public key opens with [`open_request`]
under that receiver's own `Signer` and recovers exactly the plaintext and shared secret that were
sealed — and fails to open under any other identity's `Signer`, including one holding a
structurally valid but different key pair. A response sealed with [`seal_response`] under a
shared secret opens with [`open_response`] under that same secret and recovers exactly the
plaintext — and fails to open under any other 32 bytes. Neither direction ever needs a second key
exchange for the response: the secret the request carried is what seals the answer.

Held open by `connector-signer`'s `giftwrap::tests` module: the existing worked examples
(`a_sealed_request_opens_with_the_receivers_signer`,
`a_sealed_request_does_not_open_under_a_different_identity`,
`a_response_opens_with_the_shared_secret_from_its_request`,
`a_response_does_not_open_under_the_wrong_shared_secret`) plus new proptest properties over
arbitrary plaintext (`any_plaintext_round_trips_through_seal_and_open_request`,
`any_plaintext_round_trips_through_seal_and_open_response`) that generalize them past fixed
byte strings.

### 4. A derived fulfilment satisfies the condition its sender minted

For any shared secret, `derive_condition(derive_fulfillment(secret))` — sha256 of the HKDF output
`connector_signer::giftwrap::derive_fulfillment` produces — equals the condition a sender who
minted `derive_condition(derive_fulfillment(secret))` before sealing would have attached to the
same packet, and only that exact fulfilment satisfies it
(`connector_domain::condition::fulfillment_matches_condition`). This is two already-held
invariants composed, not a new mechanism: `condition::tests::only_the_derived_preimage_matches_its_condition`
holds for any 32 bytes, `giftwrap::tests::derive_fulfillment_is_deterministic_for_the_same_secret`
holds for any secret, and
`giftwrap::tests::a_terminating_connector_derives_the_same_fulfillment_the_sender_would` ties them
to a genuine `seal_request`/`open_request` pair rather than to a secret handed to both sides out
of band.

## Generation

`crates/connector-vectors` builds the committed set from **fixed literal fixtures** — hardcoded
keys, secrets, nonces and payloads, not values sampled anew each run — and self-verifies each
entry against the same functions these invariants name (an envelope vector is decoded back and
compared before being serialized; a giftwrap vector is opened back with the receiver's own signer;
a fulfilment vector's condition is checked against `fulfillment_matches_condition`) before writing
it out. Regenerating (`cargo run -p connector-vectors --bin generate-vectors`) against an
unchanged implementation is therefore a no-op — same fixtures through the same code always produce
the same bytes — and `cargo test -p connector-vectors` is the gate: it regenerates the set
in-memory and fails if it no longer matches `vectors/wire-vectors.json` on disk, so a change to the
wire that does not regenerate the committed vectors fails `cargo test --workspace`.

See `vectors/README.md` for the file's schema, aimed at a reader in another repository who is not
importing any Rust from this one.

[`EnvelopeRequest`]: ../../crates/connector-domain/src/envelope.rs
[`EnvelopeResponse`]: ../../crates/connector-domain/src/envelope.rs
[`seal_request`]: ../../crates/connector-signer/src/giftwrap.rs
[`open_request`]: ../../crates/connector-signer/src/giftwrap.rs
[`seal_response`]: ../../crates/connector-signer/src/giftwrap.rs
[`open_response`]: ../../crates/connector-signer/src/giftwrap.rs
