//! The gate issue #527's own acceptance criterion requires: a change to the
//! envelope, giftwrap or condition/fulfilment code that does not also
//! regenerate `vectors/wire-vectors.json` fails `cargo test --workspace`.
//!
//! Compared as parsed JSON, not raw bytes: this repo's pre-commit hook runs
//! `prettier --write` over staged `*.json` files, which reflows short
//! arrays onto one line and would make a byte-exact comparison flag a
//! difference that carries no data -- the invariant this gate protects is
//! that the *data* is unchanged, not this generator's own indentation
//! choices.

use std::path::PathBuf;

#[test]
fn committed_vectors_match_what_the_implementation_generates_today() {
    let regenerated: serde_json::Value =
        serde_json::from_str(&connector_vectors::to_json(&connector_vectors::generate()))
            .expect("generate() always produces valid JSON");

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/wire-vectors.json");
    let committed_text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    let committed: serde_json::Value = serde_json::from_str(&committed_text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));

    assert_eq!(
        regenerated, committed,
        "vectors/wire-vectors.json is stale -- run \
         `cargo run -p connector-vectors --bin generate-vectors` from the repo root and commit \
         the result"
    );
}

/// The committed contract, read as a payer reads it: a Solana claim's
/// `programId` names the settlement program its `channelAccount` lives under
/// (`docs/protocol/client-edge-spec.md` §1.3), which is the same 32 bytes
/// ADR 0053 puts at offset 16 of the signed balance proof.
///
/// This asserts on the **committed artifact**, not on the generator, because
/// the artifact is what `toon-client`, `rig` and `swap` replay (ADR 0021).
/// Until issue #1127 the fixture declared the system program while the
/// connector verified against the channel's own program, so the one
/// cross-repo statement of this field taught every payer reading it that any
/// base58 32-byte value would do -- and that is exactly why the connector
/// still only warns on a disagreement (§1.3) instead of refusing.
///
/// The system-program exclusion is spelled out rather than implied: it is the
/// specific wrong value this vector shipped, and re-introducing it would be
/// silent under an equality check alone.
#[test]
fn the_solana_claim_vector_declares_the_program_its_signature_is_bound_to() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/wire-vectors.json");
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read the committed vectors"))
            .expect("the committed vectors are valid JSON");

    let case = &committed["peer_carriage"]["claim_solana"];
    let claim: serde_json::Value = serde_json::from_str(
        case["json"]
            .as_str()
            .expect("claim_solana carries its claim as a JSON string"),
    )
    .expect("the claim string is itself valid JSON");

    let declared = claim["programId"]
        .as_str()
        .expect("a Solana claim declares a programId");
    let declared_bytes = bs58::decode(declared)
        .into_vec()
        .expect("programId is base58");
    assert_eq!(
        declared_bytes.len(),
        32,
        "a programId is a 32-byte Solana address"
    );

    let signed_message = hex::decode(
        case["signed_message_hex"]
            .as_str()
            .expect("claim_solana carries the message its signature covers"),
    )
    .expect("signed_message_hex is hex");
    assert_eq!(
        signed_message.len(),
        96,
        "ADR 0053's balance proof is 96 bytes"
    );

    assert_eq!(
        &signed_message[16..48],
        declared_bytes.as_slice(),
        "the declared programId must be the program the signature is bound to -- a fixture that \
         declares one program and signs under another is not a contract anyone can conform to"
    );
    assert_ne!(
        declared, "11111111111111111111111111111111",
        "the system program is not a settlement program: no channel lives under it, so a claim \
         declaring it names nothing (issue #1127)"
    );
}
