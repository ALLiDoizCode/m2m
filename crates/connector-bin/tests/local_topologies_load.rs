//! The committed `local/*/connector.toml` files load, and say what the
//! compose file beside them assumes they say.
//!
//! `local/`'s configs are committed rather than generated, for the reason ADR
//! 0009 gives: a config nobody reads is a config nobody reviews. The cost of
//! that choice is drift -- a renamed compose service, a moved mount path, or a
//! settlement address that quietly stops matching what the chain actually
//! deploys, none of which the TOML alone can notice. `devnet_configs_load.rs`
//! holds the two fleet configs to exactly this standard; these are the local
//! ones, and they are cheaper to check because everything they name is
//! deterministic.
//!
//! What is substituted, and only this: the key files (real key material is
//! never committed -- `local/keys.sh` writes them into a gitignored directory
//! at run time), `state_dir` and `client_edge_addr` (container paths and fixed
//! ports that no test host can supply). Every other line -- the route, the
//! price, every settlement address -- is the literal committed content.

use std::io::Write;
use std::path::Path;

use connector_config::Config;
use connector_settlement_solana::test_support::LOCAL_TEST_PROGRAM_ID;

const SOLO_CONFIG: &str = include_str!("../../../local/solo/connector.toml");
const SOLO_COMPOSE: &str = include_str!("../../../local/solo/compose.yml");

/// A file holding `contents`, kept alive by the returned handle.
fn file_with(dir: &Path, name: &str, contents: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    let mut handle = std::fs::File::create(&path).expect("create sandbox file");
    handle
        .write_all(contents.as_bytes())
        .expect("write sandbox file");
    path
}

fn replace_expecting_a_match(raw: &str, from: &str, to: &str) -> String {
    assert!(
        raw.contains(from),
        "expected to find `{from}` in the committed config -- if that line was renamed, update \
         this test rather than letting the substitution silently do nothing"
    );
    raw.replace(from, to)
}

/// The committed text with only the unsupplyable lines swapped out.
fn loadable(raw: &str, dir: &Path) -> String {
    let key = file_with(
        dir,
        "key",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let bearer = file_with(dir, "bearer", "a-sandbox-token");
    let allowlist = file_with(
        dir,
        "allowlist",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
    );
    let state = dir.join("state");
    std::fs::create_dir_all(&state).expect("create sandbox state dir");

    let mut out = raw.to_string();
    for line in [
        "key_file = \"/app/data/signer.key\"",
        "key_file = \"/app/data/settlement.key\"",
        "key_file = \"/app/data/settlement-solana.key\"",
    ] {
        out = replace_expecting_a_match(&out, line, &format!("key_file = \"{}\"", key.display()));
    }
    out = replace_expecting_a_match(
        &out,
        "bearer_token_file = \"/app/data/operator-bearer-token\"",
        &format!("bearer_token_file = \"{}\"", bearer.display()),
    );
    out = replace_expecting_a_match(
        &out,
        "write_keys_file = \"/app/data/operator-write-keys\"",
        &format!("write_keys_file = \"{}\"", allowlist.display()),
    );
    out = replace_expecting_a_match(
        &out,
        "state_dir = \"/app/state\"",
        &format!("state_dir = \"{}\"", state.display()),
    );
    replace_expecting_a_match(
        &out,
        "client_edge_addr = \"0.0.0.0:3000\"",
        "client_edge_addr = \"127.0.0.1:0\"",
    )
}

#[test]
fn the_solo_topologys_committed_config_loads() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = file_with(
        dir.path(),
        "connector.toml",
        &loadable(SOLO_CONFIG, dir.path()),
    );
    let config = Config::load(&path).expect("local/solo/connector.toml must load");

    assert_eq!(
        config.routes().len(),
        1,
        "solo terminates exactly one route"
    );
    assert_eq!(config.routes()[0].prefix(), "g.local.solo");
    assert_eq!(
        config.settlements().len(),
        2,
        "the point of the solo topology is BOTH settlement backends attached at once -- the one \
         shape `cargo test` never stands up and no fleet box is checked in"
    );
}

/// The program id is committable only because `infra/solana/entrypoint.sh`
/// loads the `.so` into genesis under a bare id rather than deploying against
/// a per-machine keypair. If that constant moves, this config silently points
/// at an account that does not exist and the node refuses to start with
/// nothing naming the cause.
#[test]
fn the_solo_config_names_the_program_id_the_local_validator_loads() {
    assert!(
        SOLO_CONFIG.contains(LOCAL_TEST_PROGRAM_ID),
        "local/solo/connector.toml must name {LOCAL_TEST_PROGRAM_ID} as its \
         [settlement.solana] program_id -- the id infra/solana/entrypoint.sh loads \
         payment_channel.so under"
    );
}

/// Names that live in two files at once. A compose service rename or a moved
/// mount is invisible to the TOML, and shows up as a connector that refuses to
/// start or a route that cannot reach its app.
#[test]
fn the_solo_config_and_its_compose_file_agree() {
    for (value, why) in [
        (
            "http://anvil:8545",
            "the EVM rpc_url must name the compose `anvil` service, which is only reachable by \
             that name because both files are merged into ONE compose project",
        ),
        (
            "http://solana-validator:8899",
            "the Solana rpc_url must name the compose `solana-validator` service",
        ),
        (
            "http://stub-app:3100/",
            "the route's handler_url must name the compose `stub-app` service and the port it \
             is given on its command line",
        ),
    ] {
        assert!(SOLO_CONFIG.contains(value), "{why}");
    }

    for service in ["stub-app:", "connector:", "sender:"] {
        assert!(
            SOLO_COMPOSE.contains(service),
            "local/solo/compose.yml no longer declares a `{service}` service, but \
             connector.toml or the rehearsal still assumes it"
        );
    }
    assert!(
        SOLO_COMPOSE.contains("./local/solo/connector.toml:/app/config/connector.toml:ro"),
        "compose must mount THIS file at the path the image's CMD reads. Note the mount is \
         written relative to the REPOSITORY ROOT, because compose resolves relative paths \
         against the project directory -- the directory of the first `-f` file."
    );
    assert!(
        SOLO_COMPOSE.contains("--expect-fulfill"),
        "the sender must run with --expect-fulfill, or the rehearsal reports a REJECT and exits \
         zero -- a green tick over an unpaid, undelivered packet"
    );
}

/// No credential may be written literally into a committed config, local or
/// not: `bearer_token`/`write_keys` inline is a secret in a public repository.
/// Line-anchored on the key left of the `=`, because `bearer_token_file`
/// starts with `bearer_token` and the file's own prose names both at length.
#[test]
fn the_solo_config_carries_no_literal_credential() {
    for field in ["bearer_token", "write_keys"] {
        for line in SOLO_CONFIG.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let Some((left, _)) = line.split_once('=') else {
                continue;
            };
            assert_ne!(
                left.trim(),
                field,
                "local/solo/connector.toml sets `{field}` literally. Operator credentials are \
                 named by path (`{field}_file`) and written by local/keys.sh -- never committed."
            );
        }
    }
}
