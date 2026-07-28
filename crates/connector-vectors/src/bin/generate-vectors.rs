//! Writes the committed vector set to `vectors/wire-vectors.json` at the
//! repository root. Run after any change to the envelope, giftwrap or
//! condition/fulfilment code -- `cargo test -p connector-vectors` is the
//! gate that fails if this was needed and wasn't run (issue #527).

use std::fs;
use std::path::PathBuf;

fn main() {
    let vectors = connector_vectors::generate();
    let json = connector_vectors::to_json(&vectors);

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors/wire-vectors.json");
    fs::write(&path, json).unwrap_or_else(|e| panic!("failed to write {}: {e}", path.display()));
    println!("wrote {}", path.display());
}
