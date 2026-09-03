//! Every committed config's declared EIP-712 domain, held against the
//! deployment the node it configures will actually settle through (issue
//! #1136) -- offline, before anyone waits for a chain to say so.
//!
//! # What this is the offline half of
//!
//! `[[peer_channels]]`, `[[pay_channels]]` and `[[client_channels]]` each
//! declare a `chain_id` and a `TokenNetwork`. Together those are the EIP-712
//! domain (ADR 0024) a claim on that channel is signed and verified under.
//! Until #1136 nothing compared either to the contract the node redeems
//! through -- `[settlement.evm]` names a `TokenNetworkRegistry`, not a
//! `TokenNetwork`, and the verifying contract is whatever
//! `getTokenNetwork(token_address)` answers on connect.
//!
//! `connector_cli::runtime`'s `check_evm_channel_domains` closes that at
//! boot, against the live chain. This file closes the part of it a chain is
//! not needed for, and which a boot refusal would only tell you about after
//! a deploy:
//!
//! 1. **One node, one domain.** A node resolves exactly one `TokenNetwork`
//!    from its one `[settlement.evm]` table, so two different declared
//!    domains in one file guarantee at least one row will refuse to boot.
//!    That is checkable with no chain at all, in any config, and it is the
//!    reason the declaration is kept and corroborated rather than derived
//!    from the backend: a domain that exists only after an RPC dial cannot
//!    be gate-checked here.
//! 2. **`local/`'s domain is `local/`'s chain.** The local topologies are
//!    run against a deterministic `anvil` whose committed state deploys the
//!    `TokenNetwork` at a fixed address, recorded by
//!    `packages/contracts/regen-anvil-state.sh`. Those configs hardcode that
//!    address, and nothing held them to it -- a contract change that moved
//!    it would have surfaced as `make local-verify` failing to boot, which
//!    is a slow and confusing way to learn it.
//!
//! Deliberately parsed as raw TOML rather than through `Config::load`: this
//! is a drift gate over what the *files say*, it needs none of the key
//! material and container paths a real load demands, and it keeps working if
//! the typed shape of those tables changes.

use std::collections::BTreeSet;

/// Every committed config that declares a channel table, with the path a
/// failure should name. Written out rather than globbed for the reason
/// `local_topologies_load.rs` gives for its own list: a new topology that
/// forgets its own test still has to touch this one.
const EVERY_CONFIG: &[(&str, &str)] = &[
    (
        "local/solo/connector.toml",
        include_str!("../../../local/solo/connector.toml"),
    ),
    (
        "local/two-hop/connector-a.toml",
        include_str!("../../../local/two-hop/connector-a.toml"),
    ),
    (
        "local/two-hop/connector-b.toml",
        include_str!("../../../local/two-hop/connector-b.toml"),
    ),
    (
        "local/mixed-chain/connector-a.toml",
        include_str!("../../../local/mixed-chain/connector-a.toml"),
    ),
    (
        "local/mixed-chain/connector-b.toml",
        include_str!("../../../local/mixed-chain/connector-b.toml"),
    ),
    (
        "local/mixed-chain/connector-c.toml",
        include_str!("../../../local/mixed-chain/connector-c.toml"),
    ),
    (
        "infra/linode-relay/connector-rust.toml",
        include_str!("../../../infra/linode-relay/connector-rust.toml"),
    ),
    (
        "infra/linode-store/connector-rust.toml",
        include_str!("../../../infra/linode-store/connector-rust.toml"),
    ),
];

/// The chain compose `make local-up` merges every topology on top of -- the
/// one place the local `anvil`'s chain id is actually set.
const ROOT_COMPOSE: &str = include_str!("../../../docker-compose.yml");

/// The script that produces `packages/contracts/anvil-state.json`, and the
/// only committed record of which addresses that deterministic deploy lands
/// the contracts at.
const REGEN_ANVIL_STATE: &str = include_str!("../../../packages/contracts/regen-anvil-state.sh");

/// One declared EIP-712 domain, in the spelling a comparison can use: the
/// address lowercased, because EIP-55 checksum casing is presentation and
/// two files may legitimately differ on it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct DeclaredDomain {
    chain_id: i64,
    token_network: String,
    /// Where it was written, so a failure can name the row rather than the
    /// file.
    site: String,
}

/// Every EVM domain a config declares, across all three channel tables.
/// A Solana row declares no `chain_id`/`token_network` at all and is skipped
/// by construction -- its signed message binds the settlement program
/// instead (ADR 0053, issue #1134).
fn declared_domains(name: &str, raw: &str) -> Vec<DeclaredDomain> {
    let parsed: toml::Value = toml::from_str(raw).unwrap_or_else(|error| {
        panic!("{name} must be readable as TOML for this gate to mean anything: {error}")
    });
    let mut found = Vec::new();
    for (table, address_key) in [
        ("peer_channels", "token_network"),
        ("pay_channels", "token_network"),
        ("client_channels", "token_network_address"),
    ] {
        let Some(rows) = parsed.get(table).and_then(toml::Value::as_array) else {
            continue;
        };
        for (index, row) in rows.iter().enumerate() {
            let (Some(chain_id), Some(token_network)) = (
                row.get("chain_id").and_then(toml::Value::as_integer),
                row.get(address_key).and_then(toml::Value::as_str),
            ) else {
                continue;
            };
            found.push(DeclaredDomain {
                chain_id,
                token_network: token_network.to_lowercase(),
                site: format!("[[{table}]] #{index}"),
            });
        }
    }
    found
}

/// A node holds one `[settlement.evm]` table, which resolves one
/// `TokenNetwork`, so it can judge claims under exactly one EIP-712 domain.
/// Two in one file is a config where at least one row now refuses to boot
/// (issue #1136) -- and, before #1136, was a node that accepted claims under
/// one domain while redeeming through the other.
#[test]
fn no_committed_config_declares_two_evm_domains() {
    for (name, raw) in EVERY_CONFIG {
        let domains = declared_domains(name, raw);
        let distinct: BTreeSet<(i64, &str)> = domains
            .iter()
            .map(|domain| (domain.chain_id, domain.token_network.as_str()))
            .collect();
        assert!(
            distinct.len() <= 1,
            "{name} declares {} different EIP-712 domains across its channel tables, but a node \
             resolves exactly one TokenNetwork from its one [settlement.evm] table -- at least \
             one of these rows names a contract this node can never redeem through, and it \
             refuses to boot (issue #1136): {domains:#?}",
            distinct.len()
        );
    }
}

/// The chain id `docker-compose.yml` starts the local `anvil` with.
fn local_chain_id() -> i64 {
    let marker = "--chain-id ";
    let index = ROOT_COMPOSE
        .find(marker)
        .expect("docker-compose.yml's anvil service must still pass --chain-id");
    let rest = &ROOT_COMPOSE[index + marker.len()..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end]
        .parse()
        .expect("--chain-id is followed by a decimal chain id")
}

/// The `TokenNetwork` the committed anvil state's deterministic deploy lands
/// at, as `regen-anvil-state.sh` records it.
fn local_token_network() -> String {
    let marker = "#   TokenNetwork (USDC)";
    let index = REGEN_ANVIL_STATE.find(marker).expect(
        "packages/contracts/regen-anvil-state.sh must still record the deterministic \
         TokenNetwork address -- it is the only committed statement of what the local chain \
         actually deploys, and this gate is worthless without it",
    );
    let rest = &REGEN_ANVIL_STATE[index + marker.len()..];
    let line = rest
        .lines()
        .next()
        .expect("a recorded address is on a line");
    line.trim().to_lowercase()
}

/// The local topologies hardcode the `TokenNetwork` their `anvil` deploys,
/// because `[settlement.evm]` names only the registry and nothing in a
/// config file can name the resolved contract. Since #1136 a node refuses to
/// start when those two disagree, so a contract change that moved the
/// deterministic address would take `make local-verify` down at boot. This
/// catches it in the workspace gate instead, where the change that moved it
/// is still on screen.
#[test]
fn every_local_config_declares_the_domain_its_anvil_actually_deploys() {
    let chain_id = local_chain_id();
    let token_network = local_token_network();
    assert!(
        token_network.starts_with("0x") && token_network.len() == 42,
        "the recorded local TokenNetwork `{token_network}` is not a 20-byte hex address -- \
         regen-anvil-state.sh's comment block changed shape and this gate stopped reading it"
    );

    let mut checked = 0;
    for (name, raw) in EVERY_CONFIG {
        if !name.starts_with("local/") {
            continue;
        }
        for domain in declared_domains(name, raw) {
            assert_eq!(
                domain.chain_id, chain_id,
                "{name}'s {} declares chain id {}, but docker-compose.yml starts the local anvil \
                 with --chain-id {chain_id}. A claim signed under the wrong chain id recovers to \
                 a different address, and this node now refuses to boot rather than accept one \
                 (issue #1136)",
                domain.site, domain.chain_id
            );
            assert_eq!(
                domain.token_network, token_network,
                "{name}'s {} declares TokenNetwork {}, but the committed anvil state deploys it \
                 at {token_network} (packages/contracts/regen-anvil-state.sh). This node would \
                 verify peer and client claims under a contract it does not settle through, so \
                 it refuses to boot (issue #1136) -- update the config, or regenerate the state \
                 and its recorded addresses together",
                domain.site, domain.token_network
            );
            checked += 1;
        }
    }
    assert!(
        checked > 0,
        "no local config declared an EVM domain, so this gate asserted nothing -- if the local \
         topologies stopped declaring one, delete this test rather than leaving it green"
    );
}
