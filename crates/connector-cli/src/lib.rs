//! CLI argument parsing and commands. See ADR 0001.
//!
//! # The subcommand boundary, widened on purpose (issue #784)
//!
//! Until #784 this crate parsed exactly one argument -- the config path --
//! and the binary's whole job was ADR 0001's "load configuration, construct
//! the runtime, merge routers, serve -- and nothing else". `announce` is a
//! second verb, and adding it is a deliberate widening rather than an
//! oversight, for one reason: an announce is a **paid write that only the
//! announced node can make honestly**. It needs the identity key (to sign
//! the event), the settlement facts (to say how to pay this node), and a
//! channel with somebody who can carry the packet. A separate process can
//! be given at most one of the three, which is why the sidecar's only way
//! forward was to move a *key* to where a free relay is. Keeping the verb
//! in this binary keeps the key on the box.
//!
//! ADR 0001's spirit is intact: the *binary* still branches on nothing. It
//! calls [`run`] and gets back a [`Command`] telling it either to serve a
//! bound socket or that the work is already done.
//!
//! # `announce` and a config file named `announce`
//!
//! `args[1]` has always been a path, so the new verb needs a rule that can
//! never silently swallow one. The rule is:
//!
//!   * `connector <path>` serves. The config path is positional and always
//!     has been.
//!   * `connector announce --config <path> <through-url> [...]` announces.
//!     The config path here is **never** positional -- it is `--config`, as
//!     issue #784 writes it.
//!   * `connector announce` with nothing after it is **refused**, naming
//!     both readings. A file genuinely called `announce` is served by
//!     writing `./announce`, which is unambiguous and is what a shell user
//!     would type anyway.
//!
//! So the literal token `announce` is the only thing that selects the
//! subcommand, a path is never guessed to be a verb, and the one spelling
//! that could mean either is an error instead of a coin flip.

mod announce;
mod peer_transport;
mod runtime;

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use connector_config::{Config, ConfigError};

pub use announce::{
    announce as run_announce, AnnounceError, AnnounceOptions, AnnounceOutcome, IlpPeerInfo,
};
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
    /// The `announce` subcommand ran and failed (issue #784).
    Announce(AnnounceError),
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Usage(message) => write!(f, "{message}"),
            CliError::Config(source) => write!(f, "{source}"),
            CliError::Runtime(source) => write!(f, "{source}"),
            CliError::Announce(source) => write!(f, "{source}"),
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

impl From<AnnounceError> for CliError {
    fn from(source: AnnounceError) -> Self {
        CliError::Announce(source)
    }
}

/// The literal token that selects the `announce` subcommand -- and nothing
/// else does. See this module's header for why the collision with a config
/// file of the same name is refused rather than resolved.
const ANNOUNCE_VERB: &str = "announce";

const USAGE: &str = "usage:\n  \
     connector <config-file>\n  \
     connector announce --config <config-file> <relay-discovery-url> \
     [--to <ilp-address>] [--btp-url <wss-url>] [--target <path>] \
     [--via-own-routing] [--dry-run]";

/// What the process arguments asked for, before anything has been loaded.
#[derive(Debug, PartialEq, Eq)]
enum Invocation {
    Serve {
        config_path: String,
    },
    Announce {
        config_path: String,
        options: AnnounceOptions,
    },
}

/// Split process arguments into an [`Invocation`].
///
/// The whole disambiguation lives here, and it is four lines of it: the
/// first argument is the verb only when it is exactly `announce`, and an
/// `announce` with no further arguments is refused by naming both readings
/// rather than being resolved in either direction.
fn parse_args<S: AsRef<str>>(args: &[S]) -> Result<Invocation, CliError> {
    let usage = || CliError::Usage(USAGE.to_string());
    let first = args.get(1).map(AsRef::as_ref).ok_or_else(usage)?;

    if first != ANNOUNCE_VERB {
        return Ok(Invocation::Serve {
            config_path: first.to_string(),
        });
    }

    // `connector announce` and nothing else. Both readings are real -- the
    // subcommand with its arguments missing, or a config file that happens
    // to be called `announce` -- so neither is chosen.
    let rest: Vec<&str> = args[2..].iter().map(AsRef::as_ref).collect();
    if rest.is_empty() {
        return Err(CliError::Usage(format!(
            "'{ANNOUNCE_VERB}' on its own is ambiguous: it is the subcommand with its arguments \
             missing, or a config file of that name. Write './{ANNOUNCE_VERB}' to serve the \
             file, or give the subcommand its arguments.\n\n{USAGE}"
        )));
    }

    let mut config_path: Option<String> = None;
    let mut through_url: Option<String> = None;
    let mut publish_to: Option<String> = None;
    let mut target: Option<String> = None;
    let mut btp_url: Option<String> = None;
    let mut via_own_routing = false;
    let mut dry_run = false;
    let mut index = 0;
    while index < rest.len() {
        let argument = rest[index];
        let slot = match argument {
            "--config" => Some(&mut config_path),
            "--to" => Some(&mut publish_to),
            "--target" => Some(&mut target),
            "--btp-url" => Some(&mut btp_url),
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
            "--via-own-routing" => via_own_routing = true,
            other if other.starts_with('-') => {
                return Err(CliError::Usage(format!(
                    "unknown option '{other}'\n\n{USAGE}"
                )));
            }
            other if through_url.is_some() => {
                return Err(CliError::Usage(format!(
                    "'{other}' is a second through-URL; an announce publishes through exactly \
                     one edge\n\n{USAGE}"
                )));
            }
            other => through_url = Some(other.to_string()),
        }
        index += 1;
    }

    Ok(Invocation::Announce {
        config_path: config_path.ok_or_else(|| {
            CliError::Usage(format!(
                "announce needs --config <config-file>: the config path is never positional here, \
                 so that a file named '{ANNOUNCE_VERB}' can never be mistaken for the \
                 subcommand\n\n{USAGE}"
            ))
        })?,
        options: AnnounceOptions {
            through_url: through_url.ok_or_else(|| {
                CliError::Usage(format!(
                    "announce needs the relay's discovery URL -- the client-edge ILP endpoint of \
                     the connector fronting the relay you want to be discovered on\n\n{USAGE}"
                ))
            })?,
            publish_to,
            target,
            btp_url,
            via_own_routing,
            dry_run,
        },
    })
}

/// Load and fully validate the connector's configuration from process
/// arguments (as `std::env::args()` yields them: `args[0]` is the program
/// name, `args[1]` is the path to the one typed configuration file, or the
/// `announce` verb).
///
/// Per ADR 0009, an `Err` here means the caller must exit non-zero
/// without having started anything else. [`build`] can also fail this
/// way once the config is loaded -- see [`RuntimeError`].
pub fn load_config<S: AsRef<str>>(args: &[S]) -> Result<Config, CliError> {
    let path = match parse_args(args)? {
        Invocation::Serve { config_path } => config_path,
        Invocation::Announce { config_path, .. } => config_path,
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
    /// Bind and serve. What every invocation before issue #784 produced.
    Serve(RunningNode),
    /// The work is finished; report `summary` and exit zero.
    Finished { summary: String },
}

/// Everything between process arguments and a running node: load the
/// config, build the runtime it describes, and merge its routers -- or, for
/// `connector announce` (issue #784), do the announce and hand back what
/// happened. The one function `connector-bin` calls.
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
        Invocation::Announce {
            config_path,
            options,
        } => {
            let config = Config::load(Path::new(&config_path))?;
            let outcome = announce::announce(&config, &options).await?;
            Ok(Command::Finished {
                summary: describe(&outcome),
            })
        }
    }
}

/// The one line an operator reads after an announce. The event id is on it
/// because that is what they will look up on the relay next, and the amount
/// is on it because an announce spends real value and a run that says only
/// "ok" is a run nobody can audit.
fn describe(outcome: &AnnounceOutcome) -> String {
    if outcome.sent {
        format!(
            "announced {} to {} -- event {} ({} base units)",
            outcome.event.pubkey, outcome.destination, outcome.event.id, outcome.amount
        )
    } else {
        format!(
            "DRY RUN -- would announce to {} for {} base units. Nothing was paid and nothing was \
             sent; the event below is genuinely signed, so its id and pubkey are the ones a real \
             run would publish:\n{}",
            outcome.destination,
            outcome.amount,
            serde_json::to_string_pretty(&outcome.event).expect("a signed event serializes")
        )
    }
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

    // -- The subcommand boundary (issue #784) --
    //
    // `args[1]` has been a config path since ADR 0001, and every one of
    // these tests is about the same question: can a path ever be read as a
    // verb, or a verb as a path? The answer has to be no in both
    // directions, and "refuse the one spelling that could be either" is how
    // it stays no.

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

    /// The one spelling that could genuinely mean either thing. Guessing
    /// would be wrong half the time and silent every time, so it is an
    /// error that names both readings and the one-character fix.
    #[test]
    fn a_bare_announce_is_refused_rather_than_guessed_in_either_direction() {
        let Err(CliError::Usage(message)) = parse(&["connector", "announce"]) else {
            panic!("a bare `announce` must be a usage error");
        };
        assert!(message.contains("ambiguous"), "{message}");
        assert!(
            message.contains("./announce"),
            "the message must name the way to serve a file of that name: {message}"
        );
    }

    #[test]
    fn announce_takes_its_config_path_only_through_a_flag() {
        let Ok(Invocation::Announce {
            config_path,
            options,
        }) = parse(&[
            "connector",
            "announce",
            "--config",
            "/app/config/connector.toml",
            "https://relay-op.example/ilp",
        ])
        else {
            panic!("the issue's own invocation must parse");
        };
        assert_eq!(config_path, "/app/config/connector.toml");
        assert_eq!(options.through_url, "https://relay-op.example/ilp");
        assert_eq!(options.publish_to, None);
        assert!(!options.dry_run);
    }

    /// The flag order is not load-bearing, and the through-URL is the only
    /// positional argument the subcommand has.
    #[test]
    fn announce_accepts_its_options_in_any_order() {
        let Ok(Invocation::Announce { options, .. }) = parse(&[
            "connector",
            "announce",
            "--dry-run",
            "https://relay-op.example/ilp",
            "--to",
            "g.toon.relay",
            "--config",
            "/c.toml",
            "--target",
            "/write",
        ]) else {
            panic!("parse");
        };
        assert_eq!(options.through_url, "https://relay-op.example/ilp");
        assert_eq!(options.publish_to.as_deref(), Some("g.toon.relay"));
        assert_eq!(options.target.as_deref(), Some("/write"));
        assert!(options.dry_run);
        assert!(
            !options.via_own_routing,
            "paying the through-URL directly is the default; routing it yourself is the opt-in"
        );
    }

    /// The opt-in that switches an announce from "pay the URL" to "route it
    /// myself". Off unless written, because the two make the URL argument
    /// mean different things and only one of them matches "paying like any
    /// other client".
    #[test]
    fn routing_the_announce_yourself_is_an_explicit_opt_in() {
        let Ok(Invocation::Announce { options, .. }) = parse(&[
            "connector",
            "announce",
            "--config",
            "/c.toml",
            "--via-own-routing",
            "https://relay-op.example/ilp",
        ]) else {
            panic!("parse");
        };
        assert!(options.via_own_routing);
    }

    /// The target's BTP endpoint is explicit input, never derived from the
    /// through-URL -- a target's greeting carries one only when that target
    /// configures its own `[announce]` (issue #807), so there is nothing
    /// this command can count on negotiating it from.
    #[test]
    fn the_targets_btp_endpoint_is_supplied_rather_than_derived() {
        let Ok(Invocation::Announce { options, .. }) = parse(&[
            "connector",
            "announce",
            "--config",
            "/c.toml",
            "https://relay-op.example/ilp",
            "--btp-url",
            "wss://relay-op.example/ilp/btp",
        ]) else {
            panic!("parse");
        };
        assert_eq!(
            options.btp_url.as_deref(),
            Some("wss://relay-op.example/ilp/btp")
        );

        // And absent unless written: nothing infers it from the HTTP URL
        // sitting right next to it.
        let Ok(Invocation::Announce { options, .. }) = parse(&[
            "connector",
            "announce",
            "--config",
            "/c.toml",
            "https://relay-op.example/ilp",
        ]) else {
            panic!("parse");
        };
        assert_eq!(options.btp_url, None);
    }

    /// Without `--config` there is no config path at all -- and crucially
    /// the through-URL is NOT taken as one, which is the mistake a
    /// positional config path would have made possible.
    #[test]
    fn announce_without_a_config_flag_is_a_usage_error_not_a_guess() {
        let Err(CliError::Usage(message)) =
            parse(&["connector", "announce", "https://relay-op.example/ilp"])
        else {
            panic!("announce with no --config must be a usage error");
        };
        assert!(message.contains("--config"), "{message}");
    }

    #[test]
    fn announce_without_a_through_url_is_a_usage_error() {
        let Err(CliError::Usage(message)) =
            parse(&["connector", "announce", "--config", "/c.toml"])
        else {
            panic!("announce with no through-URL must be a usage error");
        };
        assert!(message.contains("discovery URL"), "{message}");
    }

    #[test]
    fn a_second_positional_argument_is_refused_rather_than_silently_dropped() {
        let Err(CliError::Usage(message)) = parse(&[
            "connector",
            "announce",
            "--config",
            "/c.toml",
            "https://one.example/ilp",
            "https://two.example/ilp",
        ]) else {
            panic!("two through-URLs must be a usage error");
        };
        assert!(message.contains("second through-URL"), "{message}");
    }

    #[test]
    fn an_option_missing_its_value_is_refused() {
        for args in [
            vec!["connector", "announce", "--config"],
            vec!["connector", "announce", "--config", "/c.toml", "--to"],
        ] {
            let Err(CliError::Usage(message)) = parse(&args) else {
                panic!("{args:?} must be a usage error");
            };
            assert!(message.contains("needs a value"), "{message}");
        }
    }

    #[test]
    fn an_unknown_option_is_refused_rather_than_ignored() {
        let Err(CliError::Usage(message)) = parse(&[
            "connector",
            "announce",
            "--config",
            "/c.toml",
            "--relay-url",
            "wss://nope.example",
            "https://relay-op.example/ilp",
        ]) else {
            panic!("an unknown option must be a usage error");
        };
        assert!(message.contains("--relay-url"), "{message}");
    }

    /// `[announce]` is read by the subcommand and by nothing else: a config
    /// that carries one still serves exactly as it did before it did.
    #[tokio::test]
    async fn an_announce_section_does_not_change_what_serving_does() {
        let key_file = write_raw_key_file();
        let config_file = write_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[announce]
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
