use std::collections::HashSet;
use std::fmt;
use std::path::PathBuf;

use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;

/// The default for `claim_ack_timeout_ms` and `peer_answer_timeout_ms`
/// (`peer-carriage-spec.md` §6.3): thirty seconds each.
const DEFAULT_PEER_TIMEOUT_MS: u64 = 30_000;

/// The default `max_packet_amount` (ADR 0042, "The cap"): the largest
/// amount this connector will forward to one peer in a **single packet**,
/// in the settlement asset's own base units -- 6-decimal USDC everywhere on
/// this fleet (ADR 0010, `docs/usdc-cross-chain-settlement.md`), so this is
/// **1 USDC**.
///
/// A default exists at all because ADR 0042 requires one: the cap is the
/// most a single theft by a next hop can take, and an operator who never
/// writes the field must still be bounded. Public so the runtime reads this
/// number rather than restating it, so a peer with no row of its own (one
/// added at runtime over the operator surface, issue #884) is bounded by
/// exactly the same figure a config-file peer that left the field unwritten
/// is.
///
/// # Why 1 000 000, and what was inspected to pick it
///
/// The number had to clear everything the live devnet actually carries by a
/// wide margin, so turning the cap on refuses nothing that works today:
///
/// * `infra/linode-relay/connector-rust.toml` prices `g.toon.relay` at
///   **1** µUSDC per write (buzz huddles, per audio frame at 49 fps), and
///   `infra/linode-store/connector-rust.toml` prices `g.toon.ario` at
///   **1000**. `crates/connector-bin/tests/devnet_configs_load.rs` pins both
///   as `EXPECTED_RELAY_PRICE`/`EXPECTED_STORE_PRICE`, and
///   `docs/devnet-pricing.md` is the committed table they come from.
/// * The largest *forwarded* amount this fleet ever ran was the retired
///   apex's `g.toon.ario` leg: a client paid `1002`, the apex kept a fee of
///   `2`, and **1000** went over the peering (`docs/devnet-pricing.md`, "The
///   apex forward"; `docs/protocol/money-model-pre-868.md`'s worked example).
/// * The largest single packet observed live on the fleet is **1998**
///   (`docs/operators/parallel-fleet-comparison.md`'s
///   `[write] … amount=1998`), and the retired TypeScript `announcePrice`
///   buffer -- the biggest figure any devnet config ever named -- was
///   **2000**.
///
/// So 1 000 000 sits ~500x above the largest amount this fleet has ever put
/// in one packet and 1000x above its most expensive committed route, while
/// still being a real bound: one packet to one peer can never carry more
/// than a dollar. Neither devnet box configures a peering at all today, so
/// nothing on the fleet is even reached by this check -- the margin is for
/// the next peering, and an operator who wants more writes
/// `max_packet_amount` on that peer's own `[[peers]]` row.
pub const DEFAULT_MAX_PACKET_AMOUNT: u64 = 1_000_000;

/// Which carriage a peering rides (`peer-carriage-spec.md` §0.1). There are
/// exactly two, and neither is selected by a `transport` field: a
/// connector's *expose* set says which listeners it opens, and each peer's
/// endpoint **scheme** says which carriage this connector dials that peer
/// on (§2.1). ADR 0027 deleted the raw-TCP transport, so there is no third
/// value and nothing to add one for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerCarriage {
    /// BTP over a `wss://` websocket. Symmetric once established: either
    /// side may originate on the one session (§2.3).
    Btp,
    /// ILP-over-HTTP to an `https://` endpoint. Only the dialing side can
    /// originate (§2.3, §6.4).
    Http,
}

impl PeerCarriage {
    /// The wire-visible name (`peer-carriage-spec.md` §11 is normative for
    /// these two spellings).
    pub fn name(self) -> &'static str {
        match self {
            PeerCarriage::Btp => "btp",
            PeerCarriage::Http => "http",
        }
    }

    /// The URL scheme that selects this carriage. Both are TLS-only: a
    /// peering carries signed balance proofs (ADR 0004), so `ws://` and
    /// `http://` select nothing and are refused.
    fn from_scheme(scheme: &str) -> Option<PeerCarriage> {
        match scheme {
            "wss" => Some(PeerCarriage::Btp),
            "https" => Some(PeerCarriage::Http),
            _ => None,
        }
    }

    /// [`PeerCarriage::from_scheme`], plus the two **plaintext** schemes a
    /// node that set `peer_allow_plaintext_endpoints` may also dial
    /// (issue #678, gap 3): `ws://` selects BTP and `http://` selects
    /// ILP-over-HTTP, on exactly the same terms their TLS twins do.
    ///
    /// `allow_plaintext` is `false` on every production config and on
    /// every config that does not mention the field, and then this is
    /// [`PeerCarriage::from_scheme`] byte for byte -- a plaintext endpoint
    /// is still [`ConfigError::PeerEndpointScheme`]. The switch exists so a
    /// laptop-runnable end-to-end test can point one connector at another's
    /// loopback socket without a TLS terminator in the harness; it is not
    /// a deployment shape.
    fn from_scheme_allowing_plaintext(scheme: &str, allow_plaintext: bool) -> Option<PeerCarriage> {
        match PeerCarriage::from_scheme(scheme) {
            Some(carriage) => Some(carriage),
            None if allow_plaintext => match scheme {
                "ws" => Some(PeerCarriage::Btp),
                "http" => Some(PeerCarriage::Http),
                _ => None,
            },
            None => None,
        }
    }
}

impl fmt::Display for PeerCarriage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Which peer carriages this connector opens a listener for
/// (`peer-carriage-spec.md` §2.1) -- a set over `{btp, http}`, spelled as
/// the four values that set can take because TOML cannot hold both a
/// `[peers]` table and a `[[peers]]` array of tables under one name.
///
/// [`PeerExposure::Neither`] is the empty set, and it is **legal and
/// meaningful**: it is the NAT'd operator, who exposes nothing and only
/// dials out (§2.4). It is also the default, because opening a peer
/// listener is a decision an operator makes rather than one a missing line
/// makes for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PeerExposure {
    /// The empty set: this connector opens no peer listener and can only
    /// dial out. The NAT'd case (§2.4).
    #[default]
    Neither,
    /// BTP only -- the carriage a NAT'd counterparty can dial and then be
    /// reached back over.
    Btp,
    /// ILP-over-HTTP only. Peers exclusively with dialable counterparties
    /// (§2.4).
    Http,
    /// Both listeners.
    Both,
}

impl PeerExposure {
    /// The spelling an operator writes.
    pub fn name(self) -> &'static str {
        match self {
            PeerExposure::Neither => "neither",
            PeerExposure::Btp => "btp",
            PeerExposure::Http => "http",
            PeerExposure::Both => "both",
        }
    }

    /// Whether this connector opens a listener for `carriage`.
    pub fn exposes(self, carriage: PeerCarriage) -> bool {
        match carriage {
            PeerCarriage::Btp => matches!(self, PeerExposure::Btp | PeerExposure::Both),
            PeerCarriage::Http => matches!(self, PeerExposure::Http | PeerExposure::Both),
        }
    }

    /// Whether this connector opens no peer listener at all.
    pub fn is_empty(self) -> bool {
        matches!(self, PeerExposure::Neither)
    }
}

impl fmt::Display for PeerExposure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl std::str::FromStr for PeerExposure {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "neither" => Ok(PeerExposure::Neither),
            "btp" => Ok(PeerExposure::Btp),
            "http" => Ok(PeerExposure::Http),
            "both" => Ok(PeerExposure::Both),
            _ => Err(()),
        }
    }
}

/// Whether an uncovered peer PREPARE (issue #880, owner decision #868: every
/// peer PREPARE carries a covering claim, or it is refused with the client
/// edge's own x402 greeting) is actually refused, or admitted and logged.
///
/// **Temporary migration knob (issue #883, child B6).** `Enforce` is the
/// permanent behaviour and the default -- omitting the field, or writing
/// nothing, means refuse exactly as issue #880 shipped. `Observe` exists only
/// for the fleet rollout's canary step: it logs the same
/// `peer PREPARE ... no claim covers this packet's price` line but does not
/// refuse the packet, so an operator can watch a box's logs for admissions
/// before flipping it to enforce (`docs/operators/claim-policy-rollout.md`).
///
/// **Dated for removal.** Once every `[[peers]]` row across the fleet reads
/// `Enforce` (the default, so in practice once no config sets `Observe`
/// anymore) and the rollout's own runbook confirms it, this variant and the
/// field that selects it should be deleted -- the same removed-field-trap
/// convention `ceiling`/`flush_interval_ms` now use (`ConfigError::
/// PeerCeilingRemoved`, `resolve_peers`). Target: no later than the two-node
/// fleet epic (toon-meta#316) closing, or 2026-11-01, whichever is first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClaimEnforcement {
    /// Refuse an uncovered peer PREPARE (`F06_UNEXPECTED_PAYMENT` + the x402
    /// greeting). The permanent, default behaviour.
    #[default]
    Enforce,
    /// Admit an uncovered peer PREPARE, logging it the same way a refusal
    /// would be logged. Migration-only; see the type's own documentation.
    Observe,
}

impl ClaimEnforcement {
    /// The spelling an operator writes.
    pub fn name(self) -> &'static str {
        match self {
            ClaimEnforcement::Enforce => "enforce",
            ClaimEnforcement::Observe => "observe",
        }
    }
}

impl fmt::Display for ClaimEnforcement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl std::str::FromStr for ClaimEnforcement {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "enforce" => Ok(ClaimEnforcement::Enforce),
            "observe" => Ok(ClaimEnforcement::Observe),
            _ => Err(()),
        }
    }
}

/// Whether a peer PREPARE this connector would **forward** onward (ADR
/// 0042's item 3) is refused when it arrives uncovered, or admitted and
/// logged.
///
/// A separate setting from [`ClaimEnforcement`], which governs an arrival to
/// a priced **termination** (ADR 0029) and is not changed by ADR 0042 in any
/// way, because the two migrations default in opposite directions and end on
/// different days:
///
/// - Terminated arrivals have been enforced since issue #880, so `Enforce`
///   is [`ClaimEnforcement`]'s default and `Observe` is the escape hatch.
/// - Forwarded arrivals have **never** been charged: neither box on the
///   fleet covers a forward yet (`[[pay_channels]]` shipped but is opt-in
///   per peering and no committed config writes one), so a default of
///   `Enforce` would stop forwarding across the fleet the moment the binary
///   rolled. [`ForwardedClaimEnforcement::Observe`] is therefore the
///   **default**, and an operator flips a peering to
///   [`ForwardedClaimEnforcement::Enforce`] once that peering's counterparty
///   is covering its forwards.
///
/// Folding the two into one field would have made one of those defaults
/// wrong, and folding them into one *variant set* would have tied ADR 0042's
/// item 4 (resolve `ClaimEnforcement::Observe`, target 2026-11-01) to a
/// migration that has not started -- deleting the terminated escape hatch
/// would delete this field's default with it.
///
/// **Temporary, like its sibling.** Once every peering across the fleet
/// covers its forwards and reads `Enforce`, this field and its `Observe`
/// variant should be deleted so the ADR 0042 rule is simply the behaviour,
/// using the same removed-field-trap convention `ceiling`/`flush_interval_ms`
/// use (`ConfigError::PeerCeilingRemoved`, [`resolve_peers`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ForwardedClaimEnforcement {
    /// Admit an uncovered forwarded arrival, logging it exactly the way a
    /// refusal would be logged. **The default**, because enforcing by
    /// default breaks a fleet whose send halves are not live yet.
    #[default]
    Observe,
    /// Refuse an uncovered forwarded arrival (`F06_UNEXPECTED_PAYMENT` plus
    /// the x402 greeting), the same refusal a priced termination's arrival
    /// gets. ADR 0042's permanent rule, opted into per peering.
    Enforce,
}

impl ForwardedClaimEnforcement {
    /// The spelling an operator writes.
    pub fn name(self) -> &'static str {
        match self {
            ForwardedClaimEnforcement::Observe => "observe",
            ForwardedClaimEnforcement::Enforce => "enforce",
        }
    }
}

impl fmt::Display for ForwardedClaimEnforcement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl std::str::FromStr for ForwardedClaimEnforcement {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "observe" => Ok(ForwardedClaimEnforcement::Observe),
            "enforce" => Ok(ForwardedClaimEnforcement::Enforce),
            _ => Err(()),
        }
    }
}

/// Parse the top-level `peer_expose` field, defaulting to
/// [`PeerExposure::Neither`] when the operator wrote nothing -- and
/// refusing a written-but-unrecognized spelling by name, the same way
/// `[[routes]]`'s `transport` is (issue #701): `deny_unknown_fields`
/// closes the mistyped-*key* hole, and this closes the mistyped-*value*
/// one.
pub(crate) fn parse_peer_exposure(value: Option<String>) -> Result<PeerExposure, ConfigError> {
    match value {
        None => Ok(PeerExposure::default()),
        Some(value) => value
            .parse()
            .map_err(|()| ConfigError::InvalidPeerExposure { value }),
    }
}

/// The `credential` subtable of a `[[peers]]` entry as written in the
/// config file: **where the peering's shared secret comes from**, spelled
/// as exactly one of two mutually exclusive fields.
///
/// * `secret_file` -- a path to a file holding it. This is the form a
///   deployed node uses, and the reason this field exists (issue #750):
///   this fleet's `connector-rust.toml` files are committed to a **public**
///   repository, so a peering written with a literal cannot be committed at
///   all, and the then-live apex↔store peering was configured on the boxes
///   only -- exactly the untracked-config drift the Phase 0 reconciliation
///   (#744) closed. (That peering, and the apex, are gone as of issue #872;
///   the reason the field takes a path is unchanged for the next one.)
///   Every other secret in those same files is already a file reference
///   (`[signer] key_file`, `[settlement.*.key] key_file`); this makes the
///   peering secret the same shape.
/// * `secret` -- the literal. Still supported, and fine for a test fixture
///   or a config that is never committed.
///
/// `deny_unknown_fields` (issue #556): both fields are optional and their
/// absence is meaningful, so a mistyped `secert` or `secret_fle` would
/// otherwise read as "neither is set" -- a peering that authenticates
/// nobody while reading as configured.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeerCredential {
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    secret_file: Option<PathBuf>,
}

/// The literal never reaches a [`fmt::Debug`] rendering, for the same
/// reason [`PeerCredential`]'s does not: a raw config is a whole-value
/// thing, and a derived `Debug` anywhere on the path from file to
/// [`PeerCredential`] is enough to put a peering secret in a log
/// aggregator.
impl fmt::Debug for RawPeerCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RawPeerCredential")
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("secret_file", &self.secret_file)
            .finish()
    }
}

impl RawPeerCredential {
    /// Resolve this credential to the secret itself, reading `secret_file`
    /// if that is the form the operator wrote.
    ///
    /// The file is read **here, at config load**, and not left as a
    /// [`crate::SecretLocation`]-style pointer: a peering secret is
    /// compared against on every arriving frame, and the alternative is a
    /// node that starts, serves, and only discovers at the first peer
    /// interaction that the file it was pointed at is not there. ADR 0009
    /// puts that failure at load instead -- so a missing, unreadable or
    /// empty file is a refuse-to-start error by name, exactly as
    /// [`ConfigError::SignerKeyFileNotFound`] is for `[signer] key_file`,
    /// and the path is resolved the same way that one is (by the OS,
    /// against the process's working directory).
    ///
    /// The file's contents are **trimmed**. Operators write these with
    /// `echo` and `openssl rand -hex 32 >`, both of which append a
    /// newline, and a secret that failed to match because of one invisible
    /// byte is the `P1` mismatch with no evidence at all
    /// (`peer-carriage-spec.md` §1.6). The literal `secret` form is
    /// deliberately **not** trimmed: it is byte-for-byte what it was
    /// before this field existed.
    fn resolve(self, id: &str) -> Result<PeerCredential, ConfigError> {
        match (self.secret, self.secret_file) {
            (Some(_), Some(_)) => Err(ConfigError::PeerCredentialAmbiguous { id: id.to_string() }),
            (Some(secret), None) if !secret.is_empty() => Ok(PeerCredential { secret }),
            (None, Some(path)) => {
                if !path.is_file() {
                    return Err(ConfigError::PeerSecretFileNotFound {
                        id: id.to_string(),
                        path,
                    });
                }
                let contents = std::fs::read_to_string(&path).map_err(|source| {
                    ConfigError::PeerSecretFileUnreadable {
                        id: id.to_string(),
                        path: path.clone(),
                        source,
                    }
                })?;
                let secret = contents.trim();
                if secret.is_empty() {
                    return Err(ConfigError::PeerSecretFileEmpty {
                        id: id.to_string(),
                        path,
                    });
                }
                Ok(PeerCredential {
                    secret: secret.to_string(),
                })
            }
            // Neither field set, or `secret = ""`. One condition, because
            // it is one outcome: a `[[peers]]` entry that names no secret
            // to authenticate against.
            (_, None) => Err(ConfigError::PeerCredentialMissing { id: id.to_string() }),
        }
    }
}

/// The shared secret a peering relation is authenticated by
/// (`peer-carriage-spec.md` §1.4). One struct, one JSON shape
/// (`{"peerId": …, "secret": …}`), two encodings -- the `auth`
/// protocolData entry raw on BTP, `Toon-Peer-Auth: base64(JSON)` on HTTP.
/// This crate carries only the secret; which bytes ride where is the
/// carriages' business (issue #676).
///
/// The secret never appears in a [`fmt::Debug`] rendering: a `Config` is
/// the kind of value that gets logged whole at startup, and a derived
/// `Debug` is how a peering secret ends up in a log aggregator.
#[derive(Clone, PartialEq, Eq)]
pub struct PeerCredential {
    secret: String,
}

impl PeerCredential {
    /// A credential over `secret`, for a caller that is not
    /// [`resolve_peers`] -- the dial side building what it will present, and
    /// tests standing up a policy whose shape config load refuses to
    /// produce (a peering with no `[[peer_channels]]` row, say, which is
    /// [`ConfigError::PeerChannelUnbound`] at load but is exactly the P2
    /// branch a role decision must still get right).
    ///
    /// It does **not** refuse an empty secret, and that is deliberate: the
    /// refusal that matters is [`PeerCredential::matches`] returning `false`
    /// for one, which holds for every credential however it was built. A
    /// constructor that refused instead would move the guarantee to the
    /// construction site, where a future caller can forget it.
    pub fn new(secret: impl Into<String>) -> Self {
        PeerCredential {
            secret: secret.into(),
        }
    }

    /// Whether `presented` is this peering's configured secret.
    ///
    /// Two properties, both load-bearing (`peer-carriage-spec.md` §1.2):
    ///
    /// * the comparison does not return early on the first differing byte,
    ///   so it does not leak the secret's prefix by timing; and
    /// * **an empty configured secret matches nothing**, including an empty
    ///   presented secret. An empty secret is also refused at load
    ///   ([`ConfigError::PeerCredentialMissing`]), so this is the second of
    ///   two locks on one door -- the one that still holds if a
    ///   [`PeerCredential`] is ever built by something other than
    ///   [`resolve_peers`]. A credential that matched everything is exactly
    ///   the `no-auth` quasi-peer regression §1.9 is named for.
    pub fn matches(&self, presented: &str) -> bool {
        if self.secret.is_empty() {
            return false;
        }
        constant_time_eq(self.secret.as_bytes(), presented.as_bytes())
    }

    /// The secret this connector presents when it dials this peer.
    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl fmt::Debug for PeerCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PeerCredential")
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Compare two byte strings without returning early on a mismatch.
///
/// The length difference is folded in rather than short-circuited on, so a
/// wrong-length secret costs the same as a right-length one. `subtle`'s
/// `ConstantTimeEq` is the idiomatic tool, but it wants equal-length slices
/// and this crate has no other reason to take a cryptography dependency;
/// the accumulate-then-compare shape below is the same one.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut difference: u8 = u8::from(a.len() != b.len());
    let width = a.len().max(b.len());
    for index in 0..width {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        difference |= left ^ right;
    }
    difference == 0
}

/// A `[[peers]]` entry as written in the config file: one peering
/// relation, named so a `[[routes]]` entry can target it by `peer_id`.
///
/// `deny_unknown_fields` (issue #556): a peer entry carrying a key this
/// build does not read -- a typo, or a field from a shape this connector
/// does not implement -- fails config load loudly rather than being
/// dropped and the node peering on terms nobody wrote. `addr` is kept as a
/// *parsed and rejected* field rather than left to that generic message,
/// so a stale bind-mounted box config gets told what happened and where to
/// read about it (ADR 0027, issue #679). `ceiling`/`flush_interval_ms` are
/// kept the same way (ADR 0031, ADR 0033, issue #882): the credit window
/// they bounded is retired now that every peer PREPARE carries its own
/// covering claim, and a devnet box's bind-mounted TOML still names them.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeer {
    id: String,
    /// Removed with the raw-TCP transport (ADR 0027, issue #679); a peer
    /// is reached by `endpoint` now.
    #[serde(default)]
    addr: Option<toml::Value>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    credential: Option<RawPeerCredential>,
    /// Removed with the credit window (ADR 0031, ADR 0033, issue #882);
    /// there is no trailing exposure left for a ceiling to bound.
    #[serde(default)]
    ceiling: Option<toml::Value>,
    /// Removed with the credit window (ADR 0031, ADR 0033, issue #882);
    /// a claim no longer trails the fulfilment it covers, so there is
    /// nothing left to flush on a timer.
    #[serde(default)]
    flush_interval_ms: Option<toml::Value>,
    #[serde(default)]
    claim_ack_timeout_ms: Option<u64>,
    #[serde(default)]
    peer_answer_timeout_ms: Option<u64>,
    /// The B6 migration knob (issue #883): `"observe"` admits and logs an
    /// uncovered peer PREPARE instead of refusing it. Omitted, or written
    /// `"enforce"`, is [`ClaimEnforcement::Enforce`] -- the default and the
    /// permanent behaviour. See [`ClaimEnforcement`]'s own documentation for
    /// why this field is temporary.
    #[serde(default)]
    claim_enforcement: Option<String>,
    /// ADR 0042's item 3: `"enforce"` refuses a peer PREPARE this connector
    /// would forward onward when it arrives without a claim covering the
    /// packet's own `amount`. Omitted, or written `"observe"`, is
    /// [`ForwardedClaimEnforcement::Observe`] -- admitted and logged, the
    /// **default**, because the fleet's send halves are not live yet. See
    /// [`ForwardedClaimEnforcement`] for why this defaults the opposite way
    /// to `claim_enforcement`.
    #[serde(default)]
    forwarded_claim_enforcement: Option<String>,
    /// ADR 0042's cap: the largest amount this connector will forward to
    /// this peer in one packet. Omitted is [`DEFAULT_MAX_PACKET_AMOUNT`] --
    /// there is no "unbounded" spelling, deliberately.
    #[serde(default)]
    max_packet_amount: Option<u64>,
}

/// A fully validated peering relation. Constructed only by
/// [`resolve_peers`], so a value that exists has a non-empty id unique
/// among every other configured peer, a non-empty credential, and -- if it
/// carries an endpoint at all -- one whose scheme names a real carriage.
///
/// One value per **peering relation**, never per carriage and never per
/// connection (`peer-carriage-spec.md` §2.5): the claim watermarks belong
/// to the relation, and splitting them per carriage is a double-spend
/// surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    id: String,
    endpoint: Option<Url>,
    dial: Option<PeerCarriage>,
    credential: PeerCredential,
    can_originate: bool,
    claim_ack_timeout_ms: u64,
    peer_answer_timeout_ms: u64,
    claim_enforcement: ClaimEnforcement,
    forwarded_claim_enforcement: ForwardedClaimEnforcement,
    max_packet_amount: u64,
}

impl PeerConfig {
    /// This peering relation's id -- what a `[[routes]]` entry's `peer_id`
    /// refers to, and what the credential JSON names as its `peerId`.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The URL this connector dials to reach the peer, or `None` for an
    /// **accept-only** peering: one this connector never dials and that
    /// dials in instead (§2.1).
    pub fn endpoint(&self) -> Option<&Url> {
        self.endpoint.as_ref()
    }

    /// Which carriage this connector dials this peer on, decided **solely**
    /// by the endpoint's scheme (§2.1). `None` for an accept-only peering.
    pub fn dial(&self) -> Option<PeerCarriage> {
        self.dial
    }

    /// The shared secret this peering is authenticated by (§1.4).
    pub fn credential(&self) -> &PeerCredential {
        &self.credential
    }

    /// Whether this connector can ever send a packet to this peer.
    ///
    /// True if it dials the peer (on either carriage), or if it exposes
    /// BTP -- a dialed BTP session is symmetric once established, so a peer
    /// that dials in over `wss://` can be originated to on that same
    /// session (§2.3). False for the one remaining shape: an accept-only
    /// peering on a connector that exposes only HTTP, where packets can
    /// only ever flow the other way (§6.4(1)).
    pub fn can_originate(&self) -> bool {
        self.can_originate
    }

    /// How long a sent claim may go unacknowledged before it is
    /// retransmitted (§6.3). Defaults to 30 000 ms.
    pub fn claim_ack_timeout_ms(&self) -> u64 {
        self.claim_ack_timeout_ms
    }

    /// How long a request to this peer may go unanswered (§6.3). Defaults
    /// to 30 000 ms.
    pub fn peer_answer_timeout_ms(&self) -> u64 {
        self.peer_answer_timeout_ms
    }

    /// Whether an uncovered peer PREPARE from this peering is refused or
    /// admitted-and-logged. Defaults to [`ClaimEnforcement::Enforce`]; see
    /// that type for why the [`ClaimEnforcement::Observe`] alternative
    /// exists and is temporary (issue #883).
    pub fn claim_enforcement(&self) -> ClaimEnforcement {
        self.claim_enforcement
    }

    /// Whether an uncovered **forwarded** arrival from this peering is
    /// refused or admitted-and-logged (ADR 0042's item 3). Defaults to
    /// [`ForwardedClaimEnforcement::Observe`] -- the opposite way to
    /// [`Self::claim_enforcement`], for the reason that type documents.
    pub fn forwarded_claim_enforcement(&self) -> ForwardedClaimEnforcement {
        self.forwarded_claim_enforcement
    }

    /// This peering's **cap** (ADR 0042): the largest amount this connector
    /// will forward to it in a single packet. A packet needing more is
    /// refused with `T04`, never carried and never split.
    ///
    /// Bounds one packet, not an accumulation -- ADR 0033 retired the
    /// exposure ceiling and it is not coming back (see `CONTEXT.md`'s
    /// glossary, which keeps "ceiling" and "cap" apart for exactly this
    /// reason). Defaults to [`DEFAULT_MAX_PACKET_AMOUNT`], so a peering that
    /// wrote nothing is still bounded.
    pub fn max_packet_amount(&self) -> u64 {
        self.max_packet_amount
    }
}

/// Validate every `[[peers]]` entry against `expose`, the carriages this
/// connector opens listeners for.
///
/// `expose` is an argument rather than a field on each peer because it is a
/// property of *this connector*, not of any one peering: the whole point of
/// §2.1 is that the two axes are independent, and the load-time checks that
/// matter -- [`ConfigError::PeerUndialable`] and, via
/// [`PeerConfig::can_originate`], [`ConfigError::PeerRouteUndeliverable`]
/// -- are exactly the ones that need both axes at once.
///
/// `allow_plaintext` is issue #678's loopback opt-in
/// (`peer_allow_plaintext_endpoints`): `false` -- the default and every
/// production config -- keeps `ws://` and `http://` a hard
/// [`ConfigError::PeerEndpointScheme`], exactly as before the switch
/// existed.
pub(crate) fn resolve_peers(
    raw: Vec<RawPeer>,
    expose: PeerExposure,
    allow_plaintext: bool,
) -> Result<Vec<PeerConfig>, ConfigError> {
    let mut seen = HashSet::with_capacity(raw.len());
    let mut peers = Vec::with_capacity(raw.len());

    for peer in raw {
        if peer.id.trim().is_empty() {
            return Err(ConfigError::PeerIdEmpty);
        }
        if peer.addr.is_some() {
            return Err(ConfigError::PeerAddrRemoved { id: peer.id });
        }
        if peer.ceiling.is_some() {
            return Err(ConfigError::PeerCeilingRemoved { id: peer.id });
        }
        if peer.flush_interval_ms.is_some() {
            return Err(ConfigError::PeerFlushIntervalRemoved { id: peer.id });
        }
        if !seen.insert(peer.id.clone()) {
            return Err(ConfigError::DuplicatePeerId { id: peer.id });
        }

        let (endpoint, dial) = match peer.endpoint {
            None => (None, None),
            Some(value) => {
                let url =
                    Url::parse(&value).map_err(|source| ConfigError::InvalidPeerEndpoint {
                        id: peer.id.clone(),
                        value: value.clone(),
                        source,
                    })?;
                let carriage =
                    PeerCarriage::from_scheme_allowing_plaintext(url.scheme(), allow_plaintext)
                        .ok_or_else(|| ConfigError::PeerEndpointScheme {
                            id: peer.id.clone(),
                            value: value.clone(),
                            scheme: url.scheme().to_string(),
                        })?;
                // No host check is needed: `wss` and `https` are both
                // *special* schemes in the URL standard, so a URL without
                // a host never parses in the first place and comes back
                // as `InvalidPeerEndpoint` above.
                (Some(url), Some(carriage))
            }
        };

        // P1 can never be satisfied without a secret to compare against,
        // and an empty one matches nothing by construction
        // ([`PeerCredential::matches`]) -- so a peering configured with
        // either is one that can only ever admit its counterparty as an
        // ordinary client. Refused here rather than at the first frame,
        // because the symptom otherwise is "peering configured, nothing
        // peers, no error anywhere" (§1.6). A `secret_file` that cannot be
        // read is the same refusal for the same reason
        // ([`RawPeerCredential::resolve`]).
        let credential = match peer.credential {
            Some(written) => written.resolve(&peer.id)?,
            None => return Err(ConfigError::PeerCredentialMissing { id: peer.id }),
        };

        // Issue #883 (B6): a mistyped `claim_enforcement` is refused by
        // name, the same convention `peer_expose` uses -- a value this
        // build does not recognize is not the same as the field being
        // absent, and treating it as "enforce" by falling through would
        // hide a typo that meant "observe" behind the strictest behaviour
        // ever going unnoticed on a receiver that never actually observed.
        let claim_enforcement = match peer.claim_enforcement {
            None => ClaimEnforcement::default(),
            Some(value) => value
                .parse()
                .map_err(|()| ConfigError::InvalidClaimEnforcement {
                    id: peer.id.clone(),
                    value,
                })?,
        };

        // ADR 0042 (item 3): a mistyped `forwarded_claim_enforcement` is
        // refused by name for the same reason its sibling above is, and the
        // stakes run the other way -- a typo meant as "enforce" that fell
        // through to the default would leave this peering carrying forwards
        // for free, silently, which is precisely the gap ADR 0042 closes.
        let forwarded_claim_enforcement = match peer.forwarded_claim_enforcement {
            None => ForwardedClaimEnforcement::default(),
            Some(value) => {
                value
                    .parse()
                    .map_err(|()| ConfigError::InvalidForwardedClaimEnforcement {
                        id: peer.id.clone(),
                        value,
                    })?
            }
        };

        // ADR 0042's cap. `0` is refused by name rather than taken
        // literally: a cap of zero refuses every packet this peering could
        // ever carry, which is a peering that silently does nothing, and
        // "I meant to disable the cap" is the likeliest thing a `0` was
        // written for. There is no disabling spelling -- the cap's whole
        // point is that a bound always exists.
        let max_packet_amount = match peer.max_packet_amount {
            None => DEFAULT_MAX_PACKET_AMOUNT,
            Some(0) => return Err(ConfigError::PeerMaxPacketAmountZero { id: peer.id }),
            Some(written) => written,
        };

        // A peering with nothing to dial, on a connector with nothing to
        // dial into, can never establish -- and no amount of retrying
        // changes that (§2.2).
        if endpoint.is_none() && expose.is_empty() {
            return Err(ConfigError::PeerUndialable { id: peer.id });
        }

        let can_originate = endpoint.is_some() || expose.exposes(PeerCarriage::Btp);

        peers.push(PeerConfig {
            id: peer.id,
            endpoint,
            dial,
            credential,
            can_originate,
            claim_ack_timeout_ms: peer.claim_ack_timeout_ms.unwrap_or(DEFAULT_PEER_TIMEOUT_MS),
            peer_answer_timeout_ms: peer
                .peer_answer_timeout_ms
                .unwrap_or(DEFAULT_PEER_TIMEOUT_MS),
            claim_enforcement,
            forwarded_claim_enforcement,
            max_packet_amount,
        });
    }

    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A `credential` written as a literal -- the pre-#750 form, still the
    /// shape most of these tests want.
    fn literal(secret: &str) -> RawPeerCredential {
        RawPeerCredential {
            secret: Some(secret.to_string()),
            secret_file: None,
        }
    }

    /// A `credential` written as a `secret_file`, over a temp file holding
    /// `contents` verbatim. The handle is returned so the caller keeps the
    /// file alive across the resolve.
    fn secret_file(contents: &str) -> (RawPeerCredential, tempfile::NamedTempFile) {
        let mut file = tempfile::NamedTempFile::new().expect("temp secret file");
        file.write_all(contents.as_bytes()).expect("write secret");
        file.flush().expect("flush secret");
        let credential = RawPeerCredential {
            secret: None,
            secret_file: Some(file.path().to_path_buf()),
        };
        (credential, file)
    }

    fn raw(id: &str) -> RawPeer {
        RawPeer {
            id: id.to_string(),
            addr: None,
            endpoint: Some("wss://peer.example:443/btp".to_string()),
            credential: Some(literal("shared-secret")),
            ceiling: None,
            flush_interval_ms: None,
            claim_ack_timeout_ms: None,
            peer_answer_timeout_ms: None,
            claim_enforcement: None,
            forwarded_claim_enforcement: None,
            max_packet_amount: None,
        }
    }

    #[test]
    fn resolves_a_wss_peer_onto_the_btp_carriage() {
        let peers =
            resolve_peers(vec![raw("peer-b")], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id(), "peer-b");
        assert_eq!(peers[0].dial(), Some(PeerCarriage::Btp));
        assert_eq!(
            peers[0].endpoint().map(Url::as_str),
            Some("wss://peer.example/btp")
        );
        assert!(peers[0].can_originate());
        assert_eq!(peers[0].claim_ack_timeout_ms(), 30_000);
        assert_eq!(peers[0].peer_answer_timeout_ms(), 30_000);
        assert_eq!(peers[0].claim_enforcement(), ClaimEnforcement::Enforce);
    }

    /// Issue #883 (B6): a peer that writes nothing gets the permanent
    /// behaviour, not the migration-only one -- the same "omit for the
    /// default" convention `peer_expose` uses.
    #[test]
    fn claim_enforcement_defaults_to_enforce() {
        let peers =
            resolve_peers(vec![raw("peer-b")], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].claim_enforcement(), ClaimEnforcement::Enforce);
    }

    /// The migration's whole point: a peer explicitly opted into the canary
    /// step resolves to `Observe`.
    #[test]
    fn claim_enforcement_observe_is_parsed_by_name() {
        let mut entry = raw("peer-b");
        entry.claim_enforcement = Some("observe".to_string());

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].claim_enforcement(), ClaimEnforcement::Observe);
    }

    /// Writing the default out explicitly is the same as omitting it.
    #[test]
    fn claim_enforcement_enforce_is_parsed_by_name() {
        let mut entry = raw("peer-b");
        entry.claim_enforcement = Some("enforce".to_string());

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].claim_enforcement(), ClaimEnforcement::Enforce);
    }

    /// A mistyped value is refused by name, not silently read as the
    /// default -- the same reasoning `exposure_refuses_an_unrecognized_spelling_by_name`
    /// documents for `peer_expose`: a typo that meant "observe" must not
    /// silently become the strictest behaviour there is.
    #[test]
    fn claim_enforcement_refuses_an_unrecognized_spelling_by_name() {
        let mut entry = raw("peer-b");
        entry.claim_enforcement = Some("log-only".to_string());

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::InvalidClaimEnforcement { ref id, ref value })
                if id == "peer-b" && value == "log-only"
        ));
    }

    /// ADR 0042 (item 3), the fleet-safety property: a peer that writes
    /// nothing forwards exactly as it did before this knob existed --
    /// uncovered forwarded arrivals admitted and logged, never refused.
    /// Defaulting this the way `claim_enforcement` defaults would have
    /// stopped forwarding across a fleet whose send halves are not live.
    #[test]
    fn forwarded_claim_enforcement_defaults_to_observe() {
        let peers =
            resolve_peers(vec![raw("peer-b")], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(
            peers[0].forwarded_claim_enforcement(),
            ForwardedClaimEnforcement::Observe
        );
    }

    /// The two knobs are independent settings, not one: the terminated
    /// rule's default (`Enforce`, ADR 0029) and the forwarded rule's
    /// default (`Observe`, ADR 0042) hold simultaneously on a peering that
    /// wrote neither field.
    #[test]
    fn the_two_enforcement_knobs_default_in_opposite_directions() {
        let peers =
            resolve_peers(vec![raw("peer-b")], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].claim_enforcement(), ClaimEnforcement::Enforce);
        assert_eq!(
            peers[0].forwarded_claim_enforcement(),
            ForwardedClaimEnforcement::Observe
        );
    }

    /// The flip an operator makes once this peering's counterparty covers
    /// its forwards.
    #[test]
    fn forwarded_claim_enforcement_enforce_is_parsed_by_name() {
        let mut entry = raw("peer-b");
        entry.forwarded_claim_enforcement = Some("enforce".to_string());

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(
            peers[0].forwarded_claim_enforcement(),
            ForwardedClaimEnforcement::Enforce
        );
    }

    /// Writing the default out explicitly is the same as omitting it.
    #[test]
    fn forwarded_claim_enforcement_observe_is_parsed_by_name() {
        let mut entry = raw("peer-b");
        entry.forwarded_claim_enforcement = Some("observe".to_string());

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(
            peers[0].forwarded_claim_enforcement(),
            ForwardedClaimEnforcement::Observe
        );
    }

    /// A mistyped value is refused by name. The stakes are the mirror image
    /// of `claim_enforcement`'s: here a typo meant as "enforce" would fall
    /// through to the permissive default and carry forwards for free.
    #[test]
    fn forwarded_claim_enforcement_refuses_an_unrecognized_spelling_by_name() {
        let mut entry = raw("peer-b");
        entry.forwarded_claim_enforcement = Some("enfroce".to_string());

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::InvalidForwardedClaimEnforcement { ref id, ref value })
                if id == "peer-b" && value == "enfroce"
        ));
    }

    /// ADR 0042: an operator who never writes a cap still gets one. This is
    /// the property the whole default exists for -- there is no spelling
    /// that leaves a peering unbounded.
    #[test]
    fn a_peer_that_configures_no_cap_still_gets_the_default_one() {
        let peers =
            resolve_peers(vec![raw("peer-b")], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].max_packet_amount(), DEFAULT_MAX_PACKET_AMOUNT);
        assert_eq!(peers[0].max_packet_amount(), 1_000_000);
    }

    /// The cap is per peering, so two rows in one file hold two different
    /// caps -- how far this connector trusts each peer, separately.
    #[test]
    fn each_peering_carries_its_own_cap() {
        let mut tight = raw("peer-tight");
        tight.max_packet_amount = Some(50);
        let mut generous = raw("peer-generous");
        generous.max_packet_amount = Some(5_000_000);

        let peers =
            resolve_peers(vec![tight, generous], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].max_packet_amount(), 50);
        assert_eq!(peers[1].max_packet_amount(), 5_000_000);
    }

    /// `0` is refused by name: it would refuse every packet the peering
    /// could carry, and it is what someone reaching for a non-existent
    /// "disable the cap" spelling would write.
    #[test]
    fn a_cap_of_zero_is_refused_by_name() {
        let mut entry = raw("peer-b");
        entry.max_packet_amount = Some(0);

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerMaxPacketAmountZero { ref id }) if id == "peer-b"
        ));
    }

    #[test]
    fn resolves_an_https_peer_onto_the_http_carriage() {
        let mut entry = raw("peer-b");
        entry.endpoint = Some("https://peer.example/ilp".to_string());

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert_eq!(peers[0].dial(), Some(PeerCarriage::Http));
    }

    #[test]
    fn rejects_an_empty_id() {
        let mut entry = raw("peer-b");
        entry.id = "  ".to_string();

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Both, false),
            Err(ConfigError::PeerIdEmpty)
        ));
    }

    /// An accept-only peering on a connector that exposes BTP can still be
    /// originated to: the peer dials in and the session is symmetric.
    #[test]
    fn an_accept_only_peer_can_be_originated_to_when_btp_is_exposed() {
        let mut entry = raw("peer-b");
        entry.endpoint = None;

        let peers = resolve_peers(vec![entry], PeerExposure::Btp, false).expect("resolve");

        assert_eq!(peers[0].dial(), None);
        assert!(peers[0].can_originate());
    }

    /// The one shape that cannot: accept-only, and this connector exposes
    /// only HTTP, so the peer's own requests are the only direction there
    /// is.
    #[test]
    fn an_accept_only_peer_cannot_be_originated_to_over_http_only() {
        let mut entry = raw("peer-b");
        entry.endpoint = None;

        let peers = resolve_peers(vec![entry], PeerExposure::Http, false).expect("resolve");

        assert!(!peers[0].can_originate());
    }

    /// §11's removed-field row, `ceiling`/`flush_interval_ms` half (ADR
    /// 0031, ADR 0033, issue #882): a stale bind-mounted box config gets a
    /// named error, not a silent drop.
    #[test]
    fn setting_ceiling_is_refused_by_name() {
        let mut entry = raw("peer-b");
        entry.ceiling = Some(toml::Value::Integer(1_000));

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerCeilingRemoved { ref id }) if id == "peer-b"
        ));
    }

    #[test]
    fn setting_flush_interval_ms_is_refused_by_name() {
        let mut entry = raw("peer-b");
        entry.flush_interval_ms = Some(toml::Value::Integer(5_000));

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerFlushIntervalRemoved { ref id }) if id == "peer-b"
        ));
    }

    #[test]
    fn an_empty_configured_secret_matches_nothing() {
        let credential = PeerCredential {
            secret: String::new(),
        };

        assert!(!credential.matches(""));
        assert!(!credential.matches("anything"));
    }

    #[test]
    fn a_configured_secret_matches_only_itself() {
        let credential = PeerCredential {
            secret: "shared-secret".to_string(),
        };

        assert!(credential.matches("shared-secret"));
        assert!(!credential.matches("shared-secre"));
        assert!(!credential.matches("shared-secret "));
        assert!(!credential.matches(""));
    }

    #[test]
    fn a_credential_never_debug_prints_its_secret() {
        let credential = PeerCredential {
            secret: "shared-secret".to_string(),
        };

        let rendered = format!("{credential:?}");

        assert!(!rendered.contains("shared-secret"), "got: {rendered}");
        assert!(rendered.contains("redacted"), "got: {rendered}");
    }

    // -- `secret_file` (issue #750). The peering secret is the one secret
    // in these config files that could only ever be a literal, and these
    // files are committed to a public repository.

    /// The whole point: a peering whose secret came out of a file is the
    /// same peering as one whose secret was a literal, and authenticates
    /// identically -- same match, same non-matches.
    #[test]
    fn a_file_loaded_credential_authenticates_exactly_as_a_literal_one_does() {
        let (credential, _file) = secret_file("shared-secret");
        let mut entry = raw("peer-b");
        entry.credential = Some(credential);

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        let from_file = peers[0].credential();
        let from_literal = PeerCredential::new("shared-secret");
        assert_eq!(from_file, &from_literal);
        assert_eq!(from_file.secret(), "shared-secret");
        assert!(from_file.matches("shared-secret"));
        assert!(!from_file.matches("wrong"));
        assert!(!from_file.matches(""));
    }

    /// `openssl rand -hex 32 > peer.secret` and `echo … > peer.secret`
    /// both append a newline, and a peering that failed to establish over
    /// one invisible byte is a `P1` mismatch with no evidence at all.
    #[test]
    fn a_secret_file_is_trimmed_of_its_trailing_newline_and_whitespace() {
        let (credential, _file) = secret_file("  shared-secret \t\r\n\n");
        let mut entry = raw("peer-b");
        entry.credential = Some(credential);

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert!(peers[0].credential().matches("shared-secret"));
    }

    /// The literal form is *not* trimmed: it is byte-for-byte what it was
    /// before `secret_file` existed.
    #[test]
    fn a_literal_secret_is_left_untrimmed() {
        let mut entry = raw("peer-b");
        entry.credential = Some(literal("shared-secret\n"));

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");

        assert!(peers[0].credential().matches("shared-secret\n"));
        assert!(!peers[0].credential().matches("shared-secret"));
    }

    #[test]
    fn setting_both_secret_and_secret_file_is_refused_by_name() {
        let (mut credential, _file) = secret_file("from-the-file");
        credential.secret = Some("from-the-literal".to_string());
        let mut entry = raw("peer-b");
        entry.credential = Some(credential);

        let result = resolve_peers(vec![entry], PeerExposure::Neither, false);

        assert!(matches!(
            result,
            Err(ConfigError::PeerCredentialAmbiguous { ref id }) if id == "peer-b"
        ));
    }

    /// A `credential = {}` that names neither field is the same outcome as
    /// no `credential` table at all: nothing to authenticate against.
    #[test]
    fn setting_neither_secret_nor_secret_file_is_refused_by_name() {
        let mut entry = raw("peer-b");
        entry.credential = Some(RawPeerCredential {
            secret: None,
            secret_file: None,
        });

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerCredentialMissing { ref id }) if id == "peer-b"
        ));

        let mut entry = raw("peer-b");
        entry.credential = None;

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerCredentialMissing { ref id }) if id == "peer-b"
        ));
    }

    #[test]
    fn a_missing_secret_file_is_refused_by_name() {
        let mut entry = raw("peer-b");
        entry.credential = Some(RawPeerCredential {
            secret: None,
            secret_file: Some(PathBuf::from("/nonexistent/peer.secret")),
        });

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerSecretFileNotFound { ref id, .. }) if id == "peer-b"
        ));
    }

    /// A *directory* at the path is the unreadable case this test can
    /// produce portably and without root: it exists, so it is not
    /// `PeerSecretFileNotFound` for the "does not exist" reason, and
    /// `is_file()` is what separates the two.
    #[test]
    fn a_secret_file_that_is_a_directory_is_refused_by_name() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut entry = raw("peer-b");
        entry.credential = Some(RawPeerCredential {
            secret: None,
            secret_file: Some(dir.path().to_path_buf()),
        });

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerSecretFileNotFound { ref id, .. }) if id == "peer-b"
        ));
    }

    /// A file that exists and passes `is_file()` but whose bytes are not
    /// text: `read_to_string` fails, and that is the unreadable branch.
    #[test]
    fn a_secret_file_that_is_not_text_is_refused_by_name() {
        let mut file = tempfile::NamedTempFile::new().expect("temp secret file");
        file.write_all(&[0xff, 0xfe, 0xfd]).expect("write bytes");
        file.flush().expect("flush");
        let mut entry = raw("peer-b");
        entry.credential = Some(RawPeerCredential {
            secret: None,
            secret_file: Some(file.path().to_path_buf()),
        });

        assert!(matches!(
            resolve_peers(vec![entry], PeerExposure::Neither, false),
            Err(ConfigError::PeerSecretFileUnreadable { ref id, .. }) if id == "peer-b"
        ));
    }

    /// A truncated file is the silent non-peering `secret = ""` would be,
    /// so it gets the same treatment: refused at load, by name.
    #[test]
    fn an_empty_or_whitespace_only_secret_file_is_refused_by_name() {
        for contents in ["", "\n", "   \t\r\n"] {
            let (credential, _file) = secret_file(contents);
            let mut entry = raw("peer-b");
            entry.credential = Some(credential);

            assert!(
                matches!(
                    resolve_peers(vec![entry], PeerExposure::Neither, false),
                    Err(ConfigError::PeerSecretFileEmpty { ref id, .. }) if id == "peer-b"
                ),
                "contents {contents:?} should be PeerSecretFileEmpty"
            );
        }
    }

    /// The redaction property has to hold for the file-loaded path too --
    /// and for the raw config value the secret passes through on its way
    /// there, which is the other whole-value thing that gets logged.
    #[test]
    fn a_file_loaded_credential_never_debug_prints_its_secret() {
        let (credential, _file) = secret_file("shared-secret");
        let rendered_raw = format!("{credential:?}");
        assert!(
            !rendered_raw.contains("shared-secret"),
            "got: {rendered_raw}"
        );

        let mut entry = raw("peer-b");
        entry.credential = Some(credential);
        let rendered_peer = format!("{entry:?}");
        assert!(
            !rendered_peer.contains("shared-secret"),
            "got: {rendered_peer}"
        );

        let peers = resolve_peers(vec![entry], PeerExposure::Neither, false).expect("resolve");
        let rendered = format!("{:?}", peers[0]);

        assert!(!rendered.contains("shared-secret"), "got: {rendered}");
        assert!(rendered.contains("redacted"), "got: {rendered}");
    }

    /// And the literal form's raw value is redacted the same way -- the
    /// leak this closes predates `secret_file`.
    #[test]
    fn a_raw_literal_credential_never_debug_prints_its_secret() {
        let rendered = format!("{:?}", literal("shared-secret"));

        assert!(!rendered.contains("shared-secret"), "got: {rendered}");
        assert!(rendered.contains("redacted"), "got: {rendered}");
    }

    #[test]
    fn exposure_parses_all_four_spellings_and_defaults_to_neither() {
        assert_eq!(
            parse_peer_exposure(None).expect("default"),
            PeerExposure::Neither
        );
        for (written, expected) in [
            ("neither", PeerExposure::Neither),
            ("btp", PeerExposure::Btp),
            ("http", PeerExposure::Http),
            ("both", PeerExposure::Both),
        ] {
            assert_eq!(
                parse_peer_exposure(Some(written.to_string())).expect("parse"),
                expected
            );
        }
    }

    #[test]
    fn exposure_refuses_an_unrecognized_spelling_by_name() {
        let result = parse_peer_exposure(Some("carrier-pigeon".to_string()));

        assert!(matches!(
            result,
            Err(ConfigError::InvalidPeerExposure { ref value }) if value == "carrier-pigeon"
        ));
    }

    #[test]
    fn exposure_answers_the_intersection_questions() {
        assert!(PeerExposure::Both.exposes(PeerCarriage::Btp));
        assert!(PeerExposure::Both.exposes(PeerCarriage::Http));
        assert!(PeerExposure::Btp.exposes(PeerCarriage::Btp));
        assert!(!PeerExposure::Btp.exposes(PeerCarriage::Http));
        assert!(!PeerExposure::Neither.exposes(PeerCarriage::Btp));
        assert!(PeerExposure::Neither.is_empty());
        assert!(!PeerExposure::Http.is_empty());
    }
}
