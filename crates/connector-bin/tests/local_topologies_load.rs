//! The committed `local/*/*.toml` files load, and say what the compose file
//! beside them assumes they say.
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
//! Multi-node topologies add a second kind of drift this file has to catch,
//! and it is the expensive one: a value that must be written IDENTICALLY into
//! two or three files. A peering's id, its channel, and the settlement
//! addresses each side names as the other's `counterparty_key` are all facts
//! held in two places at once, and every one of them fails at run time as a
//! refused claim rather than as a refused config. `local/keys.sh` checks the
//! chain-derived half (it computes each address and channel and refuses to
//! provision if a committed file disagrees); this checks the file-to-file
//! half, which needs no chain.
//!
//! What is substituted, and only this: the key files, the peering secrets
//! (real key material is never committed -- `local/keys.sh` writes them into a
//! gitignored directory at run time), `state_dir` and `client_edge_addr`
//! (container paths and fixed ports that no test host can supply). Every other
//! line -- the routes, the prices, every settlement and channel address -- is
//! the literal committed content.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

use connector_config::{Config, PeerChannelConfig, SettlementChain};
use connector_settlement_solana::test_support::LOCAL_TEST_PROGRAM_ID;

const SOLO_CONFIG: &str = include_str!("../../../local/solo/connector.toml");
const SOLO_COMPOSE: &str = include_str!("../../../local/solo/compose.yml");

const TWO_HOP_A: &str = include_str!("../../../local/two-hop/connector-a.toml");
const TWO_HOP_B: &str = include_str!("../../../local/two-hop/connector-b.toml");
const TWO_HOP_COMPOSE: &str = include_str!("../../../local/two-hop/compose.yml");

const MIXED_A: &str = include_str!("../../../local/mixed-chain/connector-a.toml");
const MIXED_B: &str = include_str!("../../../local/mixed-chain/connector-b.toml");
const MIXED_C: &str = include_str!("../../../local/mixed-chain/connector-c.toml");
const MIXED_COMPOSE: &str = include_str!("../../../local/mixed-chain/compose.yml");

/// The provisioning script, read as text for the one fact it holds that no
/// config does: which published port each Solana peering's channel is opened
/// through. That channel is opened by an operator write to a RUNNING node
/// (`POST /channels`, the only submitter of an `InitializeChannel` here), so
/// the script has to know where to reach it, and a port that drifts from the
/// compose file fails as a refused connection during bring-up rather than as
/// anything a reader could trace back.
const KEYS_SCRIPT: &str = include_str!("../../../local/keys.sh");

/// The chain compose every topology here is merged ON TOP OF, and the Makefile
/// that merges them. `local/<topology>/compose.yml` is only half of what
/// `make local-up` runs: the `anvil` and `solana-validator` services come from
/// the repository-root file, and one property of the first of those belongs to
/// this file's subject rather than to any single topology (see
/// `the_anvil_service_never_writes_the_source_tree_as_root`).
const ROOT_COMPOSE: &str = include_str!("../../../docker-compose.yml");
const MAKEFILE: &str = include_str!("../../../Makefile");

/// Every committed config under `local/`, with the path a failure should name.
/// Written out rather than globbed so a new topology that forgets its own test
/// still has to touch this list.
const EVERY_CONFIG: &[(&str, &str)] = &[
    ("local/solo/connector.toml", SOLO_CONFIG),
    ("local/two-hop/connector-a.toml", TWO_HOP_A),
    ("local/two-hop/connector-b.toml", TWO_HOP_B),
    ("local/mixed-chain/connector-a.toml", MIXED_A),
    ("local/mixed-chain/connector-b.toml", MIXED_B),
    ("local/mixed-chain/connector-c.toml", MIXED_C),
];

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

/// Every `/app/data/...` path a committed config names, found by scanning the
/// text rather than by listing them here. A new topology that introduces a new
/// key file gets substituted without this test being edited -- and, more to
/// the point, cannot get *missed*: [`loadable`] refuses to return a string
/// that still contains a container path.
fn container_paths(raw: &str) -> BTreeSet<&str> {
    let mut found = BTreeSet::new();
    for (index, _) in raw.match_indices("\"/app/data/") {
        let quoted = &raw[index + 1..];
        let end = quoted.find('"').expect("a quoted path is closed");
        found.insert(&quoted[..end]);
    }
    found
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
    // Non-empty on purpose: an empty configured peering secret matches nothing
    // by construction and `resolve_peers` refuses it at load
    // (`peer-carriage-spec.md` §1.6), so a blank sandbox file would make every
    // peered config here fail for a reason that says nothing about the config.
    let secret = file_with(dir, "peer-secret", "a-sandbox-peering-secret");
    let state = dir.join("state");
    std::fs::create_dir_all(&state).expect("create sandbox state dir");

    let mut out = raw.to_string();
    for path in container_paths(raw) {
        let name = path.rsplit('/').next().expect("a path has a last segment");
        let substitute = match name {
            "operator-bearer-token" => &bearer,
            "operator-write-keys" => &allowlist,
            other if other.ends_with(".key") => &key,
            other if other.ends_with("-secret") => &secret,
            other => panic!(
                "no sandbox stand-in for the container file `{other}`. Add one here -- a config \
                 that names a file this test cannot supply cannot be checked at all."
            ),
        };
        out = out.replace(path, &substitute.display().to_string());
    }
    out = replace_expecting_a_match(
        &out,
        "state_dir = \"/app/state\"",
        &format!("state_dir = \"{}\"", state.display()),
    );
    out = replace_expecting_a_match(
        &out,
        "client_edge_addr = \"0.0.0.0:3000\"",
        "client_edge_addr = \"127.0.0.1:0\"",
    );
    // Comments in these files talk about container paths at length, and
    // should: `/app/state`'s ownership and `/app/config/connector.toml`'s
    // mount are the two things a reader most needs told. Only SETTINGS have to
    // have been substituted.
    for line in out.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        assert!(
            !line.contains("/app/"),
            "`{line}` still names a container path, so whatever loads below is not what this \
             test thinks it is checking"
        );
    }
    out
}

/// Load one committed config in a sandbox of its own. Every test here goes
/// through this, so "it loads" is asserted once per file and never by
/// accident.
fn load(name: &str, raw: &str) -> Config {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = file_with(dir.path(), "connector.toml", &loadable(raw, dir.path()));
    Config::load(&path).unwrap_or_else(|error| panic!("{name} must load: {error}"))
}

/// The one `[[peer_channels]]` row a node holds for `peer_id`. Every config
/// here has exactly one per peering, and a second would mean two answers to
/// "whose signature do we accept", so this asserts that rather than taking the
/// first.
fn peer_channel<'a>(config: &'a Config, peer_id: &str) -> &'a PeerChannelConfig {
    let rows: Vec<&PeerChannelConfig> = config
        .peer_channels()
        .iter()
        .filter(|channel| channel.peer_id() == peer_id)
        .collect();
    assert_eq!(
        rows.len(),
        1,
        "expected exactly one [[peer_channels]] row for peering '{peer_id}'"
    );
    rows[0]
}

fn evm_channel<'a>(
    config: &'a Config,
    peer_id: &str,
) -> &'a connector_config::EvmPeerChannelConfig {
    match peer_channel(config, peer_id) {
        PeerChannelConfig::Evm(evm) => evm,
        PeerChannelConfig::Solana(_) => {
            panic!("peering '{peer_id}' is declared on Solana, but this leg settles on EVM")
        }
    }
}

fn solana_channel<'a>(
    config: &'a Config,
    peer_id: &str,
) -> &'a connector_config::SolanaPeerChannelConfig {
    match peer_channel(config, peer_id) {
        PeerChannelConfig::Solana(solana) => solana,
        PeerChannelConfig::Evm(_) => {
            panic!("peering '{peer_id}' is declared on EVM, but this leg settles on Solana")
        }
    }
}

// ─── solo ────────────────────────────────────────────────────────────────────

#[test]
fn the_solo_topologys_committed_config_loads() {
    let config = load("local/solo/connector.toml", SOLO_CONFIG);

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
    assert!(
        config.peers().is_empty(),
        "solo is one node: a peering here would be a second topology wearing solo's name"
    );
}

/// The program id is committable only because `infra/solana/entrypoint.sh`
/// loads the `.so` into genesis under a bare id rather than deploying against
/// a per-machine keypair. If that constant moves, this config silently points
/// at an account that does not exist and the node refuses to start with
/// nothing naming the cause.
#[test]
fn every_config_that_settles_on_solana_names_the_program_id_the_local_validator_loads() {
    for (name, raw) in [
        ("local/solo/connector.toml", SOLO_CONFIG),
        ("local/mixed-chain/connector-b.toml", MIXED_B),
        ("local/mixed-chain/connector-c.toml", MIXED_C),
    ] {
        assert!(
            raw.contains(LOCAL_TEST_PROGRAM_ID),
            "{name} must name {LOCAL_TEST_PROGRAM_ID} as its [settlement.solana] program_id -- \
             the id infra/solana/entrypoint.sh loads payment_channel.so under"
        );
    }
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
}

// ─── two-hop ─────────────────────────────────────────────────────────────────

/// The containerised counterpart of `two_connectors_peer.rs`: A forwards, B
/// terminates and PRICES, and the only path between them is the peering.
#[test]
fn the_two_hop_topologys_committed_configs_load() {
    let payer = load("local/two-hop/connector-a.toml", TWO_HOP_A);
    let payee = load("local/two-hop/connector-b.toml", TWO_HOP_B);

    assert!(
        payer.routes().is_empty(),
        "A must terminate NOTHING -- a locally terminated route would give a fulfilled packet a \
         second possible explanation, and the whole topology asserts there is only one"
    );
    assert_eq!(payer.peer_routes().len(), 1);
    let forward = &payer.peer_routes()[0];
    assert_eq!(forward.prefix(), "g.local.two-hop.b");
    assert_eq!(forward.peer_id(), "a-b");
    assert!(
        forward.price() > 0,
        "ADR 0028: a forwarded route with no price is the free gateway issue #620 exists for"
    );
    assert_eq!(
        forward.fee(),
        0,
        "`POST /packets` passes `minimum_delivery = amount`, so `amount_after_fee` refuses any \
         hop that retains anything -- a non-zero fee here makes the rehearsal see R01 instead of \
         a delivery"
    );

    assert_eq!(payee.peer_routes().len(), 0, "B forwards nothing onward");
    assert_eq!(payee.routes().len(), 1);
    assert_eq!(payee.routes()[0].prefix(), "g.local.two-hop.b.app");
    assert!(
        payee.routes()[0].prefix().starts_with(forward.prefix()),
        "the app's address must sit UNDER the prefix A forwards, or longest-prefix matching \
         sends the packet somewhere else entirely"
    );
    assert!(
        payee.routes()[0].price() > 0,
        "B both TERMINATES and PRICES this route, which is what this topology is for. Such a \
         route refuses a peer PREPARE that arrives without a claim covering the price (F06, \
         issue #880), and under ADR 0004's postpay ordering the first crossing carries none -- \
         so this figure is payable only because A covers each PREPARE before sending it. \
         `the_two_hop_payer_covers_every_crossing_before_it_is_sent` is the other half; dropping \
         it and leaving this priced deadlocks the peering rather than charging for it."
    );

    for (name, config) in [("A", &payer), ("B", &payee)] {
        assert_eq!(
            config.settlements().len(),
            1,
            "{name} settles on EVM alone in this topology"
        );
        assert_eq!(config.settlements()[0].chain(), SettlementChain::Evm);
    }
    assert!(
        payer.operator().is_some(),
        "the rehearsal originates its packet through A's `POST /packets`"
    );
    assert!(
        payee.operator().is_none(),
        "CF-31: B is never sent to directly, and an unused operator surface is two more \
         credentials to provision for nothing"
    );
}

/// The half of a priced peer termination that lives on the PAYER (ADR 0042
/// item 2, issue #881).
///
/// Without this row A owes B only once a crossing has fulfilled (ADR 0004), so
/// the first crossing would arrive uncovered, be refused `F06`, never fulfil,
/// and leave nothing owed for the second to carry -- the deadlock
/// `connector-b.toml` describes at length. With it, `cover_forward` mints the
/// claim before the packet is sent and every crossing arrives paid for.
///
/// Every field of the row restates a fact held somewhere else, which is
/// exactly the drift this file exists to catch: a claim signed under a domain
/// that is not the channel's recovers to a different address and is refused at
/// the far gate with the packet already handed over.
#[test]
fn the_two_hop_payer_covers_every_crossing_before_it_is_sent() {
    let payer = load("local/two-hop/connector-a.toml", TWO_HOP_A);
    let payee = load("local/two-hop/connector-b.toml", TWO_HOP_B);

    assert_eq!(
        payer.pay_channels().len(),
        1,
        "A pays exactly one hop from exactly one channel: the outbound client ledger keeps one \
         nonce line per next hop, so two rows for one hop would be two channels on one line"
    );
    let pays_from = &payer.pay_channels()[0];
    let peer_channel = evm_channel(&payer, "a-b");
    assert_eq!(pays_from.peer_id(), "a-b");
    assert_eq!(
        pays_from.channel_id(),
        peer_channel.channel_id(),
        "one on-chain channel held in BOTH roles with one hop -- the peer role for what arrives, \
         the client role for what A sends. `pay_channel.rs` calls that the deployed shape and \
         `Config::load` permits exactly it; what it refuses is the same channel also appearing \
         in `[[client_channels]]`."
    );
    assert_eq!(
        pays_from.chain_id(),
        peer_channel.chain_id(),
        "both roles sign against the very same on-chain channel, so the EIP-712 domain cannot \
         differ between them"
    );
    assert_eq!(
        pays_from.token_network(),
        peer_channel.token_network(),
        "the other half of that domain, and the half a typo hides in: a claim signed under the \
         wrong `verifyingContract` recovers to some other address and is refused as a forgery"
    );
    assert_eq!(
        Some(pays_from.client_edge_url()),
        payer.peers()[0].endpoint(),
        "the claim-state ask goes to B's own `POST /ilp`. It happens to be the URL this peering \
         dials, and is still written out rather than derived from it -- a `wss://` peering has \
         no HTTP client edge to derive one from (ADR 0030)."
    );
    assert!(
        TWO_HOP_A.contains("peer_allow_plaintext_endpoints = true"),
        "an `http://` client_edge_url is refused at load without it, for the same reason an \
         `http://` peer endpoint is: the claim-state ask carries a signed EIP-712 challenge in \
         the clear"
    );
    assert!(
        payee.pay_channels().is_empty(),
        "B pays nobody. It dials nothing, and on ILP-over-HTTP only the dialing side can \
         originate (§6.4), so packets and debt both flow one way across this peering."
    );
}

#[test]
fn the_two_hop_peering_is_written_identically_on_both_sides() {
    let payer = load("local/two-hop/connector-a.toml", TWO_HOP_A);
    let payee = load("local/two-hop/connector-b.toml", TWO_HOP_B);

    // §1.2's P1 holds only when the two files agree on the literal string:
    // `[[peers]].id` names the RELATION, and it is the `peerId` the dialing
    // side presents. `two_connectors_peer.rs` records what a mismatch does --
    // the dialer is admitted as an ordinary client, silently.
    assert_eq!(payer.peers().len(), 1);
    assert_eq!(payee.peers().len(), 1);
    assert_eq!(payer.peers()[0].id(), payee.peers()[0].id());
    assert!(
        payer.peers()[0].endpoint().is_some(),
        "A dials, so A's row carries the endpoint"
    );
    assert!(
        payee.peers()[0].endpoint().is_none(),
        "on ILP-over-HTTP only the dialing side can originate (§6.4), so B's row must have no \
         endpoint -- one there would claim a direction this peering does not have"
    );

    let a = evm_channel(&payer, "a-b");
    let b = evm_channel(&payee, "a-b");
    assert_eq!(
        a.channel_id(),
        b.channel_id(),
        "one channel, two files: a claim names it by this string and the payee looks its \
         verification key up under the same one"
    );
    assert_eq!(a.chain_id(), b.chain_id());
    assert_eq!(
        a.token_network(),
        b.token_network(),
        "the EIP-712 domain is half of what a balance proof is signed under -- a disagreement \
         here recovers to a different address and every claim is refused"
    );
    assert_ne!(
        a.counterparty_key(),
        b.counterparty_key(),
        "each side names the OTHER's settlement address. The same value in both files means one \
         node is configured to accept its own signature."
    );
}

#[test]
fn the_two_hop_configs_and_their_compose_file_agree() {
    for service in ["stub-app:", "connector-a:", "connector-b:", "sender:"] {
        assert!(
            TWO_HOP_COMPOSE.contains(service),
            "local/two-hop/compose.yml no longer declares a `{service}` service"
        );
    }
    for mount in [
        "./local/two-hop/connector-a.toml:/app/config/connector.toml:ro",
        "./local/two-hop/connector-b.toml:/app/config/connector.toml:ro",
        "./local/.keys/two-hop/connector-a:/app/data:ro",
        "./local/.keys/two-hop/connector-b:/app/data:ro",
    ] {
        assert!(
            TWO_HOP_COMPOSE.contains(mount),
            "local/two-hop/compose.yml must mount `{mount}` -- written relative to the \
             REPOSITORY ROOT, because compose resolves relative paths against the directory of \
             the first `-f` file. A key directory is named after the service that mounts it, \
             which is also the name local/keys.sh writes."
        );
    }
    assert!(
        TWO_HOP_CONFIG_PAIR
            .iter()
            .all(|raw| raw.contains("http://anvil:8545")),
        "both nodes must name the compose `anvil` service"
    );
    assert!(
        TWO_HOP_B.contains("http://stub-app:3100/"),
        "B's handler_url must name the compose `stub-app` service and its command-line port"
    );
    assert!(
        TWO_HOP_A.contains("endpoint = \"http://connector-b:3000/ilp\""),
        "A's peer endpoint must name B's compose service and the port its client_edge_addr binds"
    );
    assert!(
        TWO_HOP_COMPOSE.contains("--expect-fulfill"),
        "the sender must run with --expect-fulfill, or the rehearsal reports a REJECT and exits \
         zero -- a green tick over an unpaid, undelivered packet"
    );

    // The money assertion, and the third copy of every figure in it. The
    // sender reads B's claim journal because `--expect-fulfill` cannot be
    // trusted with the whole question: a peer claim's verdict rides back in
    // `Toon-Claim-Ack` and never gates the packet (#1101 proved that by
    // breaking this peering's `chain_id` and watching it stay green).
    let payer = load("local/two-hop/connector-a.toml", TWO_HOP_A);
    let payee = load("local/two-hop/connector-b.toml", TWO_HOP_B);
    let channel_id = evm_channel(&payer, "a-b").channel_id().to_string();
    assert!(
        TWO_HOP_COMPOSE.contains(&format!("CHANNEL={channel_id}")),
        "the sender must read B's claim journal for the peering's own channel id ({channel_id}), \
         or the rehearsal passes over a peering that carried both packets for free"
    );
    assert!(
        TWO_HOP_COMPOSE.contains("peer-claims.log"),
        "the journal the sender reads is `peer-claims.log`, the name \
         `connector_cli::runtime`'s PEER_CLAIM_JOURNAL gives it under state_dir"
    );
    assert!(
        TWO_HOP_COMPOSE.contains("inbound_claim_accepted"),
        "the sender reads the journal line by line rather than grepping for the channel id, \
         because a claim that merely EXISTS proves nothing -- issue #1102's repeat claims were \
         all in this file. `inbound_claim_accepted` is `connector_runtime::journal`'s own \
         encoding of an accepted claim and this is where the two are held together."
    );

    let price = payee.routes()[0].price();
    assert!(
        TWO_HOP_COMPOSE.contains(&format!("PRICE={price}")),
        "the sender charges its verdict against B's committed price ({price}): every accepted \
         claim must advance by at least that much. A price dropped here without dropping it in \
         compose is a rehearsal asserting a figure nobody is charging."
    );
    assert!(
        TWO_HOP_COMPOSE.contains(&format!("AMOUNT={price}")),
        "the packet carries exactly the price ({price}). Less is an F03 before the app is \
         reached (`handle_peer_prepare`, ADR 0029); more would leave the coverage gate slack, \
         since A covers the whole forwarded amount and B only charges its price -- and a \
         rehearsal with slack cannot tell a shortfall from a discount."
    );
    assert!(
        TWO_HOP_COMPOSE.contains("CROSSINGS=2"),
        "two crossings, and the sender must expect exactly as many covered claims. The second \
         is the one issue #1102 broke: a payer told nonce 0 forever re-signs crossing 1's \
         cumulative amount, so one crossing cannot see the defect and two can."
    );
}

const TWO_HOP_CONFIG_PAIR: [&str; 2] = [TWO_HOP_A, TWO_HOP_B];

// ─── mixed-chain ─────────────────────────────────────────────────────────────

/// The shape nothing else in this repository covers: one node holding two
/// settlement backends with a peering on each, so a packet crosses a chain
/// boundary between two hops.
///
/// Not a conversion, and this test is written so it could not be mistaken for
/// one: every price and every forwarded amount on the path is the same figure.
/// ADR 0010 replaced the spread with a flat per-packet fee and value
/// conversion is the `swap` repository's job.
#[test]
fn the_mixed_chain_topology_puts_one_node_on_both_chains() {
    let a = load("local/mixed-chain/connector-a.toml", MIXED_A);
    let b = load("local/mixed-chain/connector-b.toml", MIXED_B);
    let c = load("local/mixed-chain/connector-c.toml", MIXED_C);

    assert_eq!(
        a.settlements().len(),
        1,
        "A settles on EVM alone and cannot verify a Solana claim"
    );
    assert_eq!(a.settlements()[0].chain(), SettlementChain::Evm);
    assert_eq!(
        c.settlements().len(),
        1,
        "C settles on Solana alone and cannot verify an EIP-712 balance proof -- which is what \
         makes a packet arriving there evidence of a real chain boundary rather than of one \
         chain with two config shapes"
    );
    assert_eq!(c.settlements()[0].chain(), SettlementChain::Solana);

    let mut chains: Vec<SettlementChain> = b.settlements().iter().map(|s| s.chain()).collect();
    chains.sort_by_key(|chain| format!("{chain:?}"));
    assert_eq!(
        chains,
        vec![SettlementChain::Evm, SettlementChain::Solana],
        "B is the boundary: it holds BOTH backends, and a peering can only be signed for on a \
         chain whose settlement key this node has"
    );

    assert_eq!(
        evm_channel(&b, "a-b").chain_id(),
        31_337,
        "the EVM half of the boundary is judged under anvil's own chain id"
    );
    assert_eq!(
        solana_channel(&b, "b-c").program_id(),
        LOCAL_TEST_PROGRAM_ID,
        "the Solana half names the deployed program, which ADR 0053 binds into the signed \
         message -- a claim rendered under another deployment does not verify"
    );
}

#[test]
fn the_mixed_chain_path_is_one_prefix_per_hop_and_one_amount_end_to_end() {
    let a = load("local/mixed-chain/connector-a.toml", MIXED_A);
    let b = load("local/mixed-chain/connector-b.toml", MIXED_B);
    let c = load("local/mixed-chain/connector-c.toml", MIXED_C);

    assert!(a.routes().is_empty(), "A terminates nothing");
    assert!(b.routes().is_empty(), "B terminates nothing -- it is a hop");
    assert_eq!(a.peer_routes().len(), 1);
    assert_eq!(b.peer_routes().len(), 1);
    assert_eq!(c.peer_routes().len(), 0);
    assert_eq!(c.routes().len(), 1);

    let first = &a.peer_routes()[0];
    let second = &b.peer_routes()[0];
    let app = &c.routes()[0];
    assert_eq!(first.prefix(), "g.local.mixed.b");
    assert_eq!(second.prefix(), "g.local.mixed.b.c");
    assert_eq!(app.prefix(), "g.local.mixed.b.c.app");
    assert!(
        second.prefix().starts_with(first.prefix()) && app.prefix().starts_with(second.prefix()),
        "each hop's route must be a prefix of the next, or longest-prefix matching sends the \
         packet off the path this topology describes"
    );

    assert_eq!(first.fee(), 0);
    assert_eq!(second.fee(), 0);
    assert_eq!(
        first.price(),
        second.price(),
        "no hop retains anything and there is no rate anywhere (ADR 0010), so the amount that \
         leaves A is the amount that leaves B. A different figure would be the beginning of a \
         conversion, which is the `swap` repository's job and not this connector's -- and the \
         chain boundary in the middle is exactly where somebody would be tempted to put one."
    );
    assert_eq!(
        app.price(),
        0,
        "C terminates under a POSTPAY peering: a priced peer termination refuses an uncovered \
         arrival (F06, issue #880) and a postpay peering's first crossing is uncovered by \
         construction (ADR 0004), so a price here deadlocks the b-c leg rather than charging \
         for it. two-hop's payee IS priced, and the difference is a `[[pay_channels]]` row on \
         its payer -- covering before the send instead of owing after the fulfil. Nothing \
         forbids the same here; it is simply not what this topology is about."
    );
}

#[test]
fn the_mixed_chain_peerings_are_written_identically_on_both_sides() {
    let a = load("local/mixed-chain/connector-a.toml", MIXED_A);
    let b = load("local/mixed-chain/connector-b.toml", MIXED_B);
    let c = load("local/mixed-chain/connector-c.toml", MIXED_C);

    let a_side = evm_channel(&a, "a-b");
    let b_evm = evm_channel(&b, "a-b");
    assert_eq!(a_side.channel_id(), b_evm.channel_id());
    assert_eq!(a_side.chain_id(), b_evm.chain_id());
    assert_eq!(a_side.token_network(), b_evm.token_network());
    assert_ne!(
        a_side.counterparty_key(),
        b_evm.counterparty_key(),
        "each side names the OTHER's settlement address"
    );

    let b_solana = solana_channel(&b, "b-c");
    let c_side = solana_channel(&c, "b-c");
    assert_eq!(b_solana.channel_account(), c_side.channel_account());
    assert_eq!(b_solana.program_id(), c_side.program_id());
    assert_ne!(
        b_solana.counterparty_key(),
        c_side.counterparty_key(),
        "each side names the OTHER's Solana settlement key"
    );

    assert_eq!(
        b.peers().len(),
        2,
        "B is on both ends of a peering: it accepts from A and dials C"
    );
    assert!(
        b.peers().iter().any(|peer| peer.endpoint().is_some())
            && b.peers().iter().any(|peer| peer.endpoint().is_none()),
        "exactly the asymmetry the boundary is made of -- one peering B dials and one it accepts"
    );
}

/// B holds an operator surface and C does not, and the asymmetry is load-
/// bearing rather than incidental.
///
/// The Solana peering's `channel_account` is a real program-derived address,
/// and something has to submit the `InitializeChannel` that puts an account
/// there. No chain tool in this repository can: it is a positional account
/// list under an 8-byte discriminator, `spl-token` knows only SPL Token, and
/// the Solana CLI cannot build an arbitrary program instruction. The only
/// submitter is `POST /channels` (ADR 0008's third write, issue #459), which
/// reaches `SolanaSettlementBackend::open` and signs with the node's own
/// `[settlement.solana]` key -- the identity the PDA is derived from. B is the
/// peering's payer, so B is that node, so B has the surface. C never opens
/// anything and keeps CF-31's absent table.
#[test]
fn the_mixed_chain_solana_payer_can_be_told_to_open_its_channel() {
    let a = load("local/mixed-chain/connector-a.toml", MIXED_A);
    let b = load("local/mixed-chain/connector-b.toml", MIXED_B);
    let c = load("local/mixed-chain/connector-c.toml", MIXED_C);

    assert!(
        a.operator().is_some(),
        "the rehearsal originates its packet through A's `POST /packets`"
    );
    assert!(
        b.operator().is_some(),
        "B is the Solana peering's payer, and `POST /channels` on this surface is the only way \
         anything in this repository can open the channel `[[peer_channels]]` names. Without it \
         the topology settles against an address nobody ever created."
    );
    assert!(
        c.operator().is_none(),
        "CF-31: C originates nothing and opens nothing, and an unused operator surface is two \
         more credentials to provision"
    );

    // The port `local/keys.sh` posts that write to, and the port compose
    // publishes B's client edge on. Two files, one number.
    assert!(
        KEYS_SCRIPT.contains("b-c:solana:connector-b:connector-c:3004"),
        "local/keys.sh's topology table must name the host port B's operator surface is \
         published on -- that is where its `solana-channels` stage sends `POST /channels`"
    );
    assert!(
        MIXED_COMPOSE.contains("'127.0.0.1:3004:3000'"),
        "local/mixed-chain/compose.yml must publish B's client edge on 3004, the port \
         local/keys.sh opens the Solana channel through"
    );
}

#[test]
fn the_mixed_chain_configs_and_their_compose_file_agree() {
    for service in [
        "stub-app:",
        "connector-a:",
        "connector-b:",
        "connector-c:",
        "sender:",
    ] {
        assert!(
            MIXED_COMPOSE.contains(service),
            "local/mixed-chain/compose.yml no longer declares a `{service}` service"
        );
    }
    for node in ["connector-a", "connector-b", "connector-c"] {
        for mount in [
            format!("./local/mixed-chain/{node}.toml:/app/config/connector.toml:ro"),
            format!("./local/.keys/mixed-chain/{node}:/app/data:ro"),
        ] {
            assert!(
                MIXED_COMPOSE.contains(&mount),
                "local/mixed-chain/compose.yml must mount `{mount}` -- repository-root-relative, \
                 and the key directory named after the service that mounts it"
            );
        }
    }
    assert!(
        MIXED_A.contains("endpoint = \"http://connector-b:3000/ilp\"")
            && MIXED_B.contains("endpoint = \"http://connector-c:3000/ilp\""),
        "each dialing side's peer endpoint must name the next node's compose service"
    );
    assert!(
        MIXED_C.contains("http://stub-app:3100/"),
        "C's handler_url must name the compose `stub-app` service and its command-line port"
    );
    assert!(
        MIXED_COMPOSE.contains("--expect-fulfill"),
        "the sender must run with --expect-fulfill"
    );

    // Both journals, both identifiers -- the whole topology in two greps. An
    // EVM `channel_id` accepted at B and a base58 Solana `channel_account`
    // accepted at C, neither of which `--expect-fulfill` can see.
    let b = load("local/mixed-chain/connector-b.toml", MIXED_B);
    let evm = evm_channel(&b, "a-b").channel_id().to_string();
    let solana = solana_channel(&b, "b-c").channel_account().to_string();
    assert!(
        MIXED_COMPOSE.contains(&format!("/app/b-state {evm} ")),
        "the sender must read B's claim journal for the EVM peering's channel id ({evm})"
    );
    assert!(
        MIXED_COMPOSE.contains(&format!("/app/c-state {solana} ")),
        "the sender must read C's claim journal for the Solana peering's channel account \
         ({solana}) -- without it a packet can reach the app having crossed the chain boundary \
         for free"
    );

    // And the one thing neither journal can say. A journal records that a
    // claim's SIGNATURE checked out against a configured key (CF-23) -- it
    // reads no chain, so it stays green against a channel account nobody ever
    // opened, which is exactly what this topology shipped with. The sender
    // therefore asks the validator itself, before it sends anything.
    let program = solana_channel(&b, "b-c").program_id().to_string();
    assert!(
        MIXED_COMPOSE.contains(&format!("channel_open {solana} {program}")),
        "the sender must check on chain that {solana} is an account of the payment-channel \
         program {program} -- a claim journal cannot tell an open channel from a derived \
         address nobody created"
    );
}

// ─── the chains every topology runs on ───────────────────────────────────────

/// The `anvil` service bind-mounts `./packages/contracts` READ-WRITE, and
/// `forge` writes four things into it: `out/`, `cache/`, `broadcast/` and — on
/// a checkout whose git submodules are not initialized — `lib/`. So the uid
/// that container runs as decides who owns the developer's source tree once a
/// topology has been brought up, and running it as root cost two failures that
/// each looked like something else entirely:
///
///   * The artefacts came back root-owned, so the next `cargo test` could not
///     rebuild them (`abi_provenance` runs a real `forge build` of
///     `packages/contracts`) and the developer could not `rm -rf` them to
///     recover without sudo. Running `local/` broke the unit-test gate, with
///     nothing linking the two.
///   * On a git worktree — or any checkout where `git submodule update --init`
///     has not run — `lib/forge-std` and `lib/openzeppelin-contracts` exist
///     and are EMPTY, owned by the developer. `forge install` clones into them
///     and git refuses as root ("detected dubious ownership in repository at
///     '/contracts/lib/forge-std'"), so the deploy compiled against absent
///     OpenZeppelin sources and every topology failed bring-up with
///     `container ... is unhealthy` and nothing else.
///
/// Both are the same root cause and have the same fix: run as the owner of the
/// mount. That takes BOTH halves — the compose default is only reached by a
/// hand-run `docker compose`, and everything under `local/` comes through the
/// Makefile — so both are asserted here.
#[test]
fn the_anvil_service_never_writes_the_source_tree_as_root() {
    for line in ROOT_COMPOSE.lines() {
        let line = line.trim();
        assert_ne!(
            line, "user: root",
            "docker-compose.yml runs a service as root. The `anvil` service bind-mounts \
             ./packages/contracts read-write, so root there leaves the developer artefacts \
             they cannot rebuild and cannot delete."
        );
    }
    assert!(
        ROOT_COMPOSE.contains("user: '${HOST_UID:-1000}:${HOST_GID:-1000}'"),
        "docker-compose.yml's anvil service must run as the invoking user, so that what \
         `forge` writes into the bind-mounted ./packages/contracts belongs to whoever ran it"
    );
    for export in [
        "export HOST_UID := $(shell id -u)",
        "export HOST_GID := $(shell id -g)",
    ] {
        assert!(
            MAKEFILE.contains(export),
            "the Makefile must `{export}` -- without it every `make local-*`, `make anvil-up` \
             and `make infra-up` falls back to the compose default, which is right only for a \
             uid-1000 developer and wrong for a CI runner"
        );
    }
}

// ─── every config ────────────────────────────────────────────────────────────

/// No credential may be written literally into a committed config, local or
/// not: `bearer_token`/`write_keys` inline is a secret in a public repository,
/// and so is a peering's shared `secret`. Line-anchored on the key left of the
/// `=`, because each of those names is a prefix of its own `_file` form and
/// these files' prose names both at length.
#[test]
fn no_local_config_carries_a_literal_credential() {
    for (name, raw) in EVERY_CONFIG {
        for field in ["bearer_token", "write_keys", "secret"] {
            for line in raw.lines() {
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
                    "{name} sets `{field}` literally. Credentials are named by path \
                     (`{field}_file`) and written by local/keys.sh -- never committed."
                );
            }
        }
    }
}

/// Every peering a config declares is bound to a channel, and every channel
/// row names a peering that exists. `Config::load` already refuses both
/// (`PeerUnbound`, `PeerChannelOrphaned`), so this is not a second
/// implementation of that rule -- it is the assertion that these particular
/// files reach load at all with their peerings intact, which is the thing a
/// hand-edited multi-node config gets wrong.
#[test]
fn every_local_peering_is_bound_to_a_channel() {
    for (name, raw) in EVERY_CONFIG {
        let config = load(name, raw);
        for peer in config.peers() {
            assert!(
                config
                    .peer_channels()
                    .iter()
                    .any(|channel| channel.peer_id() == peer.id()),
                "{name} declares peering '{}' with no [[peer_channels]] row",
                peer.id()
            );
        }
    }
}
