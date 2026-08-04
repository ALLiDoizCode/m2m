//! §2.1, §6.4(3), §11: what a **loaded configuration** says about this
//! carriage, asserted against `Config::load` rather than against a
//! hand-built value -- because the two properties under test are precisely
//! the ones the carriage must **not** decide for itself.
//!
//! 1. **Which carriage this connector dials a peer on is decided solely by
//!    the scheme of that peer's `endpoint`** (§2.1). The HTTP transport
//!    registers `https://` peerings and no others; a `wss://` peering is the
//!    BTP carriage's and an endpoint-less one is accept-only. `Config::load`
//!    has already refused any other scheme (`PeerEndpointScheme`) and a
//!    peering that can never establish (`PeerUndialable`), so dialability is
//!    config's answer and is not re-derived at runtime.
//! 2. **An accept-only peering carries an explicit ceiling, or it does not
//!    load** (§6.4(3), `AcceptOnlyPeerWithoutCeiling`). It is the only real
//!    bound that side has -- it cannot originate, so it cannot prompt a payer
//!    that has stopped sending, and unlike BTP it has no live session to read
//!    liveness from. This crate therefore has no runtime default to fall back
//!    on, and this test is what says that is deliberate.

use std::io::Write;
use std::path::Path;

use connector_config::{Config, ConfigError};
use connector_peer_http::dial::PeerRelation;

const CHANNEL: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_CHANNEL: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const THIRD_CHANNEL: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const KEY: &str = "0x2222222222222222222222222222222222222222";
const TOKEN_NETWORK: &str = "0x3333333333333333333333333333333333333333";

/// One connector that dials one peer over HTTP, one over BTP, and accepts a
/// third -- the three shapes §2.1 distinguishes, in one file.
fn peering_config(key_path: &Path, state_dir: &Path, accept_only_ceiling: &str) -> String {
    format!(
        r#"
client_edge_addr = "127.0.0.1:3000"
peer_expose = "btp"
state_dir = "{state_dir}"

[signer]
key_file = "{key_file}"

[[peers]]
id = "over-http"
endpoint = "https://peer.example:443/ilp"
credential = {{ secret = "shared-secret" }}
ceiling = 1000000

[[peers]]
id = "over-btp"
endpoint = "wss://peer.example:443/btp"
credential = {{ secret = "shared-secret" }}
ceiling = 1000000

[[peers]]
id = "accept-only"
credential = {{ secret = "shared-secret" }}
{accept_only_ceiling}

[[peer_channels]]
peer_id = "over-http"
channel_id = "{CHANNEL}"
counterparty_key = "{KEY}"
chain_id = 31337
token_network = "{TOKEN_NETWORK}"

[[peer_channels]]
peer_id = "over-btp"
channel_id = "{OTHER_CHANNEL}"
counterparty_key = "{KEY}"
chain_id = 31337
token_network = "{TOKEN_NETWORK}"

[[peer_channels]]
peer_id = "accept-only"
channel_id = "{THIRD_CHANNEL}"
counterparty_key = "{KEY}"
chain_id = 31337
token_network = "{TOKEN_NETWORK}"
"#,
        state_dir = state_dir.display(),
        key_file = key_path.display(),
    )
}

fn load(accept_only_ceiling: &str) -> Result<Config, ConfigError> {
    let state_dir = tempfile::tempdir().expect("temp state dir");
    let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
    key_file.write_all(b"not a real key").expect("write key");
    let mut config_file = tempfile::Builder::new()
        .suffix(".toml")
        .tempfile()
        .expect("temp config file");
    config_file
        .write_all(
            peering_config(key_file.path(), state_dir.path(), accept_only_ceiling).as_bytes(),
        )
        .expect("write config");
    Config::load(config_file.path())
}

#[test]
fn only_an_https_endpoint_selects_this_carriage() {
    let config = load("ceiling = 250000").expect("load");

    let dialed: Vec<&str> = config
        .peers()
        .iter()
        .filter(|peer| PeerRelation::from_config(peer, config.peer_channels()).is_some())
        .map(connector_config::PeerConfig::id)
        .collect();

    assert_eq!(
        dialed,
        vec!["over-http"],
        "the carriage is the endpoint's scheme and nothing else (§2.1)"
    );
}

/// §6.4(3): the accept-only side's ceiling is explicit, and this carriage
/// reads it rather than defaulting one -- a defaulted ceiling on the one
/// configuration where the ceiling is the sole bound is an unowned credit
/// decision.
#[test]
fn an_accept_only_peering_carries_an_explicit_ceiling_or_does_not_load() {
    let config = load("ceiling = 250000").expect("load");
    let accept_only = config
        .peers()
        .iter()
        .find(|peer| peer.id() == "accept-only")
        .expect("the accept-only peering");

    assert_eq!(accept_only.endpoint(), None);
    assert_eq!(accept_only.dial(), None);
    assert_eq!(accept_only.ceiling(), Some(250_000));

    assert!(
        matches!(
            load(""),
            Err(ConfigError::AcceptOnlyPeerWithoutCeiling { ref id }) if id == "accept-only"
        ),
        "an accept-only peering with no ceiling must not load (§11)"
    );
}
