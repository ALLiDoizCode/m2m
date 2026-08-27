//! CLI argument parsing and commands. See ADR 0001.
//!
//! # The subcommand boundary
//!
//! Until issue #784 this crate parsed exactly one argument -- the config path
//! -- and the binary's whole job was ADR 0001's "load configuration, construct
//! the runtime, merge routers, serve -- and nothing else". #784 added a second
//! verb, `announce`, on the argument that an announce is a paid write only the
//! announced node can make honestly, so the key should stay on the box.
//!
//! **That verb is gone (ADR 0046, issue #1074.)** The argument was sound and
//! answered the wrong question: an announce assumes a Nostr relay exists at
//! all, and a network of pure connectors has none. A connector answers when
//! asked -- `GET` on its own URL returns its self-description (ADR 0050) --
//! and does nothing else about being found. Whether those facts are then
//! copied into a discovery network is the controller's business, outside the
//! connector by definition (ADR 0006).
//!
//! `send` remains, and is a different animal: it originates a packet through
//! *another* node's operator surface and holds no config of its own.
//!
//! ADR 0001's spirit is intact: the *binary* still branches on nothing. It
//! calls [`run`] and gets back a [`Command`] telling it either to serve a
//! bound socket or that the work is already done.

mod peer_transport;
mod runtime;
mod send;

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use connector_config::{Config, ConfigError};

pub use runtime::{build, router, Runtime, RuntimeError};

/// Everything that can stop the connector from producing a validated,
/// running node.
#[derive(Debug)]
pub enum CliError {
    /// Argument parsing failed -- e.g. no config path was given.
    Usage(String),
    /// The config file itself failed to load or validate.
    Config(ConfigError),
    /// The config loaded but the runtime it describes could not be built
    /// (e.g. an unreadable or malformed signer key).
    Runtime(RuntimeError),
    /// The `send` subcommand ran and failed.
    Send(send::SendError),
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Usage(message) => write!(f, "{message}"),
            CliError::Config(source) => write!(f, "{source}"),
            CliError::Runtime(source) => write!(f, "{source}"),
            CliError::Send(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<ConfigError> for CliError {
    fn from(source: ConfigError) -> Self {
        CliError::Config(source)
    }
}

impl From<RuntimeError> for CliError {
    fn from(source: RuntimeError) -> Self {
        CliError::Runtime(source)
    }
}

impl From<send::SendError> for CliError {
    fn from(source: send::SendError) -> Self {
        CliError::Send(source)
    }
}

/// The verb that used to select the removed `announce` subcommand (ADR 0046,
/// issue #1074), kept only so that a script or a systemd unit still invoking
/// it is told what happened instead of being handed the file-not-found error
/// of a config path that was never a path.
///
/// The same reasoning a removed config key is refused by name under (ADR
/// 0009): the boxes are operated from scripts that lead this repo, and a
/// silent misreading is worse than a loud refusal. Nothing else selects it --
/// a file genuinely called `announce` is served as `./announce`, which is what
/// a shell user would type anyway.
const ANNOUNCE_VERB: &str = "announce";
const SEND_VERB: &str = "send";

const USAGE: &str = "usage:\n  \
     connector <config-file>\n  \
     connector send --operator <url> --operator-key <file> --to <ilp-address> \
     --seal-to <url> [--amount <n>] [--target <path>] [--method <verb>] \
     [--body <file|-> ] [--expires-in <seconds>] [--expect-fulfill] [--dry-run]\n  \
     connector send --operator-key <file> --print-keyid";

/// What the process arguments asked for, before anything has been loaded.
#[derive(Debug, PartialEq, Eq)]
enum Invocation {
    Serve {
        config_path: String,
    },
    Send {
        options: send::SendOptions,
    },
    /// `connector send --operator-key <file> --print-keyid`: derive and print
    /// the allowlist value for a key file, touching no network.
    PrintKeyid {
        key_file: String,
    },
}

/// Split process arguments into an [`Invocation`].
///
/// Two verbs and a path. The removed `announce` is still recognised, solely so
/// it can be refused by name.
fn parse_args<S: AsRef<str>>(args: &[S]) -> Result<Invocation, CliError> {
    let usage = || CliError::Usage(USAGE.to_string());
    let first = args.get(1).map(AsRef::as_ref).ok_or_else(usage)?;

    if first == SEND_VERB {
        // `send` is never ambiguous with a config path: it takes no positional
        // argument at all, so a bare `connector send` is a usage error rather
        // than two possible readings.
        let rest: Vec<&str> = args[2..].iter().map(AsRef::as_ref).collect();
        return parse_send_args(&rest);
    }

    if first == ANNOUNCE_VERB {
        return Err(CliError::Usage(format!(
            "'{ANNOUNCE_VERB}' was removed (ADR 0046, issue #1074): a connector answers when \
             asked and never announces, and an announce assumed a Nostr relay that a network of \
             pure connectors does not have. This node's own facts are served, free and \
             unauthenticated, by a GET on its client-edge URL -- `GET /ilp` (ADR 0050). \
             Publishing them into a discovery network is a controller's job, outside the \
             connector.\n\nTo serve a config file that is genuinely called \
             '{ANNOUNCE_VERB}', write './{ANNOUNCE_VERB}'.\n\n{USAGE}"
        )));
    }

    Ok(Invocation::Serve {
        config_path: first.to_string(),
    })
}

/// Load and fully validate the connector's configuration from process
/// arguments (as `std::env::args()` yields them: `args[0]` is the program
/// name, `args[1]` is the path to the one typed configuration file).
///
/// Per ADR 0009, an `Err` here means the caller must exit non-zero
/// without having started anything else. [`build`] can also fail this
/// way once the config is loaded -- see [`RuntimeError`].
pub fn load_config<S: AsRef<str>>(args: &[S]) -> Result<Config, CliError> {
    let path = match parse_args(args)? {
        Invocation::Serve { config_path } => config_path,
        Invocation::Send { .. } | Invocation::PrintKeyid { .. } => {
            return Err(CliError::Usage(format!(
                "'{SEND_VERB}' loads no configuration: it is a client of another node's operator \
                 surface, not a node.\n\n{USAGE}"
            )))
        }
    };
    Config::load(Path::new(&path)).map_err(CliError::from)
}

/// Everything a running node needs beyond a bound client-edge socket.
///
/// A node used to also bind a second, peer-only listener here. ADR 0027
/// removed it: peers ride the carriages the client edge already serves
/// (BTP over `wss://`, ILP-over-HTTP over `https://`) and are told apart
/// from clients by authentication, not by port -- so there is one listener
/// again, and nothing for the binary to hold alive.
pub struct RunningNode {
    /// The merged client-edge (and, if configured, operator) router.
    pub router: Router,
    /// The socket address the client edge binds.
    pub client_edge_addr: SocketAddr,
}

/// What [`run`] left for the binary to do.
///
/// ADR 0001 keeps the binary from making decisions, and a second verb would
/// have handed it one -- so it does not get one: the decision is made here,
/// where the arguments are parsed, and the binary is told the answer. There
/// is exactly as much branching in `main` as there are things a process can
/// do at the end of `run`: hold a socket open, or exit.
pub enum Command {
    /// Bind and serve. What every invocation that names a config file
    /// produces.
    Serve(RunningNode),
    /// The work is finished; report `summary` and exit zero.
    Finished { summary: String },
}

/// Everything between process arguments and a running node: load the
/// config, build the runtime it describes, and merge its routers -- or, for
/// `connector send`, originate one packet through another node's operator
/// surface and hand back what happened. The one function `connector-bin`
/// calls.
pub async fn run<S: AsRef<str>>(args: &[S]) -> Result<Command, CliError> {
    match parse_args(args)? {
        Invocation::Serve { config_path } => {
            let config = Config::load(Path::new(&config_path))?;
            let runtime = build(&config).await?;
            let client_edge_addr = config.client_edge_addr();
            let router = router(&runtime, &config)?;

            Ok(Command::Serve(RunningNode {
                router,
                client_edge_addr,
            }))
        }
        Invocation::Send { options } => {
            let outcome = send::send(&options).await?;
            Ok(Command::Finished {
                summary: describe_send(&outcome),
            })
        }
        Invocation::PrintKeyid { key_file } => Ok(Command::Finished {
            summary: send::print_keyid(&key_file)?,
        }),
    }
}

/// The one line an operator reads after a send. The keyid is on it because it
/// is the value they will need next, and for a refused write it is the only
/// actionable fact.
fn describe_send(outcome: &send::SendOutcome) -> String {
    let head = format!(
        "{} base units to {} (signed as keyid {})",
        outcome.amount, outcome.destination, outcome.keyid
    );
    match &outcome.outcome {
        send::Outcome::Fulfilled { status, body } => format!(
            "FULFILL -- {head}\nthe terminating app answered {status}:\n{}",
            String::from_utf8_lossy(body)
        ),
        send::Outcome::FulfilledWithWrongFulfillment => format!(
            "FULFILL WITH THE WRONG FULFILMENT -- {head}\nThe packet was fulfilled, but not by a \
             connector holding this sender's gift-wrap secret: the fulfilment does not match the \
             one this wrap derives (ADR 0019). --seal-to almost certainly names a different node \
             from the one that actually terminated the packet."
        ),
        send::Outcome::Rejected { code, message } => {
            format!("REJECT {code} -- {head}\n{message}")
        }
        send::Outcome::NotSent => {
            format!("DRY RUN -- would have sent {head}. Nothing was sent and nothing was paid.")
        }
    }
}

/// Parse everything after `connector send`.
fn parse_send_args(rest: &[&str]) -> Result<Invocation, CliError> {
    let mut operator_url: Option<String> = None;
    let mut operator_key_file: Option<String> = None;
    let mut destination: Option<String> = None;
    let mut seal_to: Option<String> = None;
    let mut target: Option<String> = None;
    let mut method: Option<String> = None;
    let mut body_arg: Option<String> = None;
    let mut amount_arg: Option<String> = None;
    let mut expires_arg: Option<String> = None;
    let mut dry_run = false;
    let mut expect_fulfill = false;
    let mut print_keyid = false;

    let mut index = 0;
    while index < rest.len() {
        let argument = rest[index];
        let slot = match argument {
            "--operator" => Some(&mut operator_url),
            "--operator-key" => Some(&mut operator_key_file),
            "--to" => Some(&mut destination),
            "--seal-to" => Some(&mut seal_to),
            "--target" => Some(&mut target),
            "--method" => Some(&mut method),
            "--body" => Some(&mut body_arg),
            "--amount" => Some(&mut amount_arg),
            "--expires-in" => Some(&mut expires_arg),
            _ => None,
        };
        if let Some(slot) = slot {
            let value = rest
                .get(index + 1)
                .ok_or_else(|| CliError::Usage(format!("{argument} needs a value\n\n{USAGE}")))?;
            *slot = Some((*value).to_string());
            index += 2;
            continue;
        }
        match argument {
            "--dry-run" => dry_run = true,
            "--expect-fulfill" => expect_fulfill = true,
            "--print-keyid" => print_keyid = true,
            other => {
                return Err(CliError::Usage(format!(
                    "unexpected argument '{other}' -- '{SEND_VERB}' takes no positional \
                     arguments\n\n{USAGE}"
                )))
            }
        }
        index += 1;
    }

    let required = |value: Option<String>, flag: &str, why: &str| {
        value.ok_or_else(|| CliError::Usage(format!("send needs {flag}: {why}\n\n{USAGE}")))
    };

    // `--print-keyid` reads one file and prints one line. It deliberately
    // requires none of the rest: the whole point is to answer "what goes in
    // write_keys" before there is a node to send to.
    if print_keyid {
        return Ok(Invocation::PrintKeyid {
            key_file: required(
                operator_key_file,
                "--operator-key <file>",
                "the key file whose allowlist value you want printed",
            )?,
        });
    }

    let amount = match amount_arg {
        None => 0,
        Some(text) => text.parse::<u64>().map_err(|_| {
            CliError::Usage(format!(
                "--amount must be a non-negative integer, not '{text}'"
            ))
        })?,
    };
    let expires_in_seconds = match expires_arg {
        None => 300,
        Some(text) => text.parse::<i64>().map_err(|_| {
            CliError::Usage(format!(
                "--expires-in must be an integer number of seconds, not '{text}'"
            ))
        })?,
    };
    let body = match body_arg.as_deref() {
        None => Vec::new(),
        Some("-") => {
            use std::io::Read;
            let mut buffer = Vec::new();
            std::io::stdin().read_to_end(&mut buffer).map_err(|error| {
                CliError::Usage(format!("could not read the body from stdin: {error}"))
            })?;
            buffer
        }
        Some(path) => std::fs::read(path).map_err(|error| {
            CliError::Usage(format!("could not read the body from '{path}': {error}"))
        })?,
    };

    Ok(Invocation::Send {
        options: send::SendOptions {
            operator_url: required(
                operator_url,
                "--operator <url>",
                "the node whose operator surface originates the packet",
            )?,
            operator_key_file: required(
                operator_key_file,
                "--operator-key <file>",
                "the ed25519 key whose public half is on that node's [operator] write_keys",
            )?,
            destination: required(
                destination,
                "--to <ilp-address>",
                "the packet's destination",
            )?,
            seal_to: required(
                seal_to,
                "--seal-to <url>",
                "the connector's URL, the one whose GET returns its self-description (ADR 0050) \
             -- a payload is sealed to the terminating node (ADR 0018), which in a multi-hop \
             topology is not the node given to --operator",
            )?,
            amount,
            target: target.unwrap_or_else(|| "/".to_string()),
            method: method.unwrap_or_else(|| "POST".to_string()),
            body,
            expires_in_seconds,
            dry_run,
            expect_fulfill,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_path_argument_is_a_usage_error() {
        let result = load_config(&["connector".to_string()]);
        assert!(matches!(result, Err(CliError::Usage(_))));
    }

    #[test]
    fn nonexistent_config_file_is_a_config_error() {
        let result = load_config(&[
            "connector".to_string(),
            "/nonexistent/path.toml".to_string(),
        ]);
        assert!(matches!(
            result,
            Err(CliError::Config(ConfigError::Io { .. }))
        ));
    }

    fn write_config(text: &str) -> tempfile::NamedTempFile {
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(config_file, "{text}").expect("write config file");
        config_file
    }

    fn write_raw_key_file() -> tempfile::NamedTempFile {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(&[7u8; 32])
            .expect("write raw 32-byte key");
        key_file
    }

    #[tokio::test]
    async fn run_produces_a_node_with_only_a_client_edge_listener() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let command = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await
        .expect("run");

        let Command::Serve(node) = command else {
            panic!("a bare config path must still mean serve, as it always has");
        };
        assert_eq!(node.client_edge_addr, "127.0.0.1:0".parse().unwrap());
    }

    /// ADR 0027 / issue #679: `peer_wire_addr` is gone, and a config that
    /// still sets it fails at boot by name -- the devnet boxes run
    /// bind-mounted configs that lead the repo copies, so a stale one must
    /// stop the node rather than quietly start it without peering.
    #[tokio::test]
    async fn run_with_a_stale_peer_wire_addr_fails_by_name() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"
peer_wire_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await;
        let Err(error) = result else {
            panic!("stale peer_wire_addr must fail config load");
        };

        assert!(matches!(
            error,
            CliError::Config(ConfigError::PeerWireAddrRemoved)
        ));
        assert!(error
            .to_string()
            .contains("docs/operators/btp-peer-transport-bringup.md"));
    }

    // -- The subcommand boundary --
    //
    // `args[1]` has been a config path since ADR 0001, and these tests are
    // about the same question they always were: can a path ever be read as a
    // verb, or a verb as a path? The answer has to be no in both directions.
    // Since ADR 0046 there is one fewer verb, and the tests below pin that the
    // removal is *loud* rather than silent -- the same rule a removed config
    // key lives under (ADR 0009).

    fn parse(args: &[&str]) -> Result<Invocation, CliError> {
        parse_args(args)
    }

    #[test]
    fn a_bare_path_still_means_serve_whatever_it_is_called() {
        for path in [
            "/etc/connector/connector.toml",
            "./announce",
            "announce.toml",
            "/app/config/announce",
        ] {
            assert_eq!(
                parse(&["connector", path]).expect(path),
                Invocation::Serve {
                    config_path: path.to_string()
                },
                "{path} is a path, not a verb"
            );
        }
    }

    /// The removed verb is refused **by name** rather than read as a config
    /// path that does not exist (ADR 0046, issue #1074). The boxes are driven
    /// from scripts and units that lead this repo, and "No such file or
    /// directory: announce" is not an answer anybody can act on.
    #[test]
    fn the_removed_announce_verb_is_refused_by_name_with_what_replaced_it() {
        for args in [
            vec!["connector", "announce"],
            vec![
                "connector",
                "announce",
                "--config",
                "/c.toml",
                "https://relay-op.example/ilp",
            ],
        ] {
            let Err(CliError::Usage(message)) = parse(&args) else {
                panic!("{args:?} must be a usage error");
            };
            assert!(
                message.contains("was removed"),
                "the message must say the verb is gone: {message}"
            );
            assert!(
                message.contains("GET /ilp"),
                "and where a node's facts are answered instead: {message}"
            );
            assert!(
                message.contains("./announce"),
                "and how to serve a file that is genuinely called that: {message}"
            );
        }
    }

    /// `send` is untouched by the removal: it is a client of *another* node's
    /// operator surface, not a node describing itself.
    #[test]
    fn send_still_parses_after_the_announce_verb_is_gone() {
        let Ok(Invocation::PrintKeyid { key_file }) = parse(&[
            "connector",
            "send",
            "--operator-key",
            "/operator.key",
            "--print-keyid",
        ]) else {
            panic!("send --print-keyid must still parse");
        };
        assert_eq!(key_file, "/operator.key");
    }

    /// `[node]` is read on the serving path (it feeds the greeting and the
    /// self-description), and a config that carries one serves exactly as one
    /// that does not.
    #[tokio::test]
    async fn a_node_section_does_not_change_what_serving_does() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[node]
addresses = ["g.example.node"]
http_endpoint = "https://node.example/ilp"
btp_endpoint = "wss://node.example/ilp/btp"
"#,
            key_file.path().display()
        ));

        let command = run(&[
            "connector".to_string(),
            config_file.path().display().to_string(),
        ])
        .await
        .expect("run");

        let Command::Serve(node) = command else {
            panic!("serve");
        };
        assert_eq!(node.client_edge_addr, "127.0.0.1:0".parse().unwrap());
    }
}
