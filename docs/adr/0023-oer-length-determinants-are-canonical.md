# OER length determinants are canonical, for every consumer of `oer.rs`

`decode_var_uint` (`crates/connector-domain/src/oer.rs`) now rejects any length determinant
that is not the exact bytes `encode_var_uint` would produce for the value it decodes to: a
non-minimal long form (`0x81 0x03` for the value `3`, canonically the single byte `0x03`), a
zero-length long form aliasing the canonical `0x00` (`0x80`), and a determinant wider than 8
bytes (which cannot fit a `u64` without silently discarding high-order bytes, as the prior
`value = (value << 8) | byte` accumulator did). `decode_var_octet_string` inherits the fix
because its length prefix is itself a VarUInt decoded through the same function.

## The decision this records

`oer.rs` is shared: `crates/connector-domain/src/packet.rs` (the ILPv4 PREPARE/FULFILL/REJECT
codec, RFC-0027) and `crates/connector-domain/src/envelope.rs` (the structured envelope, ADR 0018) both decode through `decode_var_uint`/`decode_var_octet_string`, and neither has its own
copy of the length-determinant logic. Issue #546 asked, as one of its own acceptance criteria,
that this be a decision rather than an accident: **tighten the shared primitive**, so both
callers become canonical at once, rather than adding a second, narrower canonicality check only
inside `envelope.rs` that would leave the packet codec as the sole remaining place a given
packet has more than one valid encoding.

Consequence: `Prepare::decode`, `Fulfill::decode` and `Reject::decode` now reject a non-canonical
`amount`, `data`, `destination`, `message` or `triggered_by` length exactly as `envelope.rs`
does, with no change to `packet.rs` itself -- it already propagates `PacketError` from `oer.rs`
through `?` and needed no new code to inherit the fix, only the two new error variants
(`PacketError::NonCanonicalLength`, `PacketError::LengthDeterminantOverflow`) it now returns
alongside `BufferUnderflow`.

## Why this is safe for the wire, not just the envelope

`packages/shared/src/encoding/oer.ts`'s `encodeVarUInt` -- the encoder `oer.rs` was itself
ported from -- only ever emits the canonical form: a single byte for 0-127, otherwise the
minimal-length big-endian long form. It has no code path that produces a non-minimal or
zero-length-alias determinant. Any well-formed PREPARE, FULFILL or REJECT built by the existing
TypeScript encoder, or by `oer.rs`'s own `encode_var_uint`, was always canonical; this change
only removes acceptance of bytes no conforming encoder emits. It has no effect on real traffic
and narrows what an attacker or a malformed sender can smuggle at either boundary.

## What this does not do

This does not add a canonicality check anywhere outside `decode_var_uint`/
`decode_var_octet_string` -- `decode_fixed_octet_string` and `decode_generalized_time` have no
length determinant to make canonical. It does not change either codec's error type's existing
variants; it adds two new ones to `PacketError` (surfaced by both `packet.rs` and, via
`envelope.rs`'s own `EnvelopeError` mapping, the envelope) rather than reusing
`BufferUnderflow` for a failure that is not actually a truncated buffer.
