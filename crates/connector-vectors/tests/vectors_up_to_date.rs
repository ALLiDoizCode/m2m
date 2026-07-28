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
