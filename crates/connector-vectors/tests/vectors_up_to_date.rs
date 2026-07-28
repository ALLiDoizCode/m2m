//! The gate issue #527's own acceptance criterion requires: a change to the
//! envelope, giftwrap or condition/fulfilment code that does not also
//! regenerate `vectors/wire-vectors.json` fails `cargo test --workspace`.

use std::path::PathBuf;

#[test]
fn committed_vectors_match_what_the_implementation_generates_today() {
    let regenerated = connector_vectors::to_json(&connector_vectors::generate());

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/wire-vectors.json");
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));

    assert_eq!(
        regenerated, committed,
        "vectors/wire-vectors.json is stale -- run \
         `cargo run -p connector-vectors --bin generate-vectors` from the repo root and commit \
         the result"
    );
}
