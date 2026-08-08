//! Guards the README's config-key table against the parser (issue #900).
//!
//! `README.md`'s "Configure" section documented `peer_wire_addr`, a key the
//! parser refuses by name -- an operator who copied it got a node that
//! refused to start (connector#849). `refuses_to_start.rs` proves the
//! parser's side of that; nothing proved the README's. This file reads the
//! committed table and, for every key it names, hands the same parser a
//! probe config setting that key and asserts it is not rejected as an
//! unrecognized or removed key.
//!
//! Deliberately does not read a second, hand-maintained list of "the keys
//! the README should have" -- that list would drift from the table under
//! test exactly the way the table drifted from the parser. The table's own
//! rows are the input.

use std::io::Write;

use connector_config::Config;

const README: &str = include_str!("../../../README.md");

/// The "## Configure" section's text, up to (not including) the next `##`
/// heading -- scopes every later step to the one table this check is about,
/// so a backtick anywhere else in this ~400-line file (there are hundreds)
/// can never be misread as a config key.
fn configure_section(readme: &str) -> &str {
    let heading = "\n## Configure\n";
    let start = readme
        .find(heading)
        .expect("README.md has a '## Configure' section")
        + heading.len();
    let rest = &readme[start..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    &rest[..end]
}

/// The key-table's data rows, as the literal backticked text of each row's
/// first column -- `client_edge_addr`, `[signer]`, `[[routes]]`, and so on.
///
/// A markdown table row here is `| `key` | ... |`; the header row (`| Key |
/// ...`) and the separator row (`| --- | ...`) don't start their first cell
/// with a backtick and are excluded by that shape, not by skipping a fixed
/// number of lines -- so inserting or reordering rows can't desync this
/// from the table it reads.
fn table_keys(section: &str) -> Vec<String> {
    section
        .lines()
        .filter_map(|line| {
            let first_cell = line.split('|').nth(1)?.trim();
            let inner = first_cell.strip_prefix('`')?.strip_suffix('`')?;
            (!inner.is_empty()).then(|| inner.to_string())
        })
        .collect()
}

/// What TOML shape a table key's own spelling says it is: `[[routes]]` is
/// an array of tables, `[signer]` is a table, anything else (`apex`,
/// `peer_expose`, ...) is a plain key. Read off the key text itself so
/// nothing here has to hand-maintain a second copy of which section each
/// key lives in.
enum Shape {
    Scalar,
    Table,
    Array,
}

fn parse_key(raw: &str) -> (&str, Shape) {
    if let Some(inner) = raw.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
        (inner, Shape::Array)
    } else if let Some(inner) = raw.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        (inner, Shape::Table)
    } else {
        (raw, Shape::Scalar)
    }
}

/// A probe config: the minimal document `Config::load` accepts
/// (`client_edge_addr` plus a `[signer]` pointing at a real, if content-free,
/// key file -- `SecretLocation::resolve` only checks the path exists), with
/// `field` added in the shape its README spelling calls for and, for a
/// scalar, set to a dummy string value.
///
/// `key_file` has to name a real file: `Config::load` resolves the signer
/// before it ever reaches most other fields, so a missing key file would
/// fail every probe on that alone and never exercise the key under test.
fn probe_toml(field: &str, shape: &Shape, key_file: &std::path::Path) -> String {
    let mut doc = String::from("client_edge_addr = \"127.0.0.1:0\"\n");
    if matches!(shape, Shape::Scalar) && field != "client_edge_addr" {
        doc.push_str(&format!("{field} = \"dummy\"\n"));
    }
    doc.push_str(&format!(
        "\n[signer]\nkey_file = \"{}\"\n",
        key_file.display()
    ));
    match shape {
        Shape::Table if field != "signer" => doc.push_str(&format!("\n[{field}]\n")),
        Shape::Array => doc.push_str(&format!("\n[[{field}]]\n")),
        _ => {}
    }
    doc
}

/// Whether an error's message names `error` as a key this parser does not
/// currently accept, rather than some unrelated problem with the dummy
/// value or the rest of the probe (a missing field inside an empty
/// `[[routes]]` entry, say -- that's a real key rejecting a fake value,
/// not a fake key).
///
/// The two phrasings below are this crate's own, consistent vocabulary for
/// "this key is not a thing you may write": serde's `deny_unknown_fields`
/// message for a key no `Raw*` struct declares at all, and this codebase's
/// own convention (`error.rs`'s `PeerWireAddrRemoved`,
/// `RawPeer.addr`'s reader) for a key that used to be read and now exists
/// only to name itself removed.
fn names_an_unrecognized_key(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("unknown field") || lower.contains("was removed")
}

#[test]
fn every_readme_config_key_is_known_to_the_parser() {
    let keys = table_keys(configure_section(README));
    assert!(
        keys.len() >= 10,
        "expected to find the README's '## Configure' key-table rows, found {}: {keys:?} -- \
         did the table move or change shape?",
        keys.len(),
    );

    let mut key_file = tempfile::NamedTempFile::new().expect("temp signer key file");
    key_file
        .write_all(&[7u8; 32])
        .expect("write signer key file");

    for raw_key in &keys {
        let (field, shape) = parse_key(raw_key);
        let text = probe_toml(field, &shape, key_file.path());

        let mut config_file = tempfile::NamedTempFile::new().expect("temp probe config file");
        write!(config_file, "{text}").expect("write probe config");

        if let Err(error) = Config::load(config_file.path()) {
            let message = error.to_string();
            assert!(
                !names_an_unrecognized_key(&message),
                "README.md's config-key table documents `{raw_key}`, but connector-config's \
                 parser rejects it as unknown or removed: {message}\n\nprobe config:\n{text}"
            );
        }
    }
}

/// A negative control on the mechanism itself: `peer_wire_addr` is a real
/// key this parser refuses by name (ADR 0027, issue #679) -- the same
/// defect this whole file exists to catch if it ever reappeared in the
/// README's table. If this stopped failing, the positive test above would
/// be green no matter what the table said.
#[test]
fn the_probe_flags_a_key_the_parser_actually_refuses() {
    let mut key_file = tempfile::NamedTempFile::new().expect("temp signer key file");
    key_file
        .write_all(&[7u8; 32])
        .expect("write signer key file");

    let text = probe_toml("peer_wire_addr", &Shape::Scalar, key_file.path());
    let mut config_file = tempfile::NamedTempFile::new().expect("temp probe config file");
    write!(config_file, "{text}").expect("write probe config");

    let error = Config::load(config_file.path()).expect_err("peer_wire_addr must be refused");
    assert!(
        names_an_unrecognized_key(&error.to_string()),
        "expected the probe to flag peer_wire_addr as removed, got: {error}"
    );
}
