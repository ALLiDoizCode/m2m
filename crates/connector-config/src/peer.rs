use std::collections::HashSet;
use std::fmt;
use std::path::PathBuf;

use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;

/// The default for `claim_ack_timeout_ms` and `peer_answer_timeout_ms`
/// (`peer-carriage-spec.md` §6.3): thirty seconds each.
const DEFAULT_PEER_TIMEOUT_MS: u64 = 30_000;

/// Which carriage a peering rides (`peer-carriage-spec.md` §0.1). There are
/// exactly two, and neither is selected by a `transport` field: a
/// connector's *expose* set says which listeners it opens, and each peer's
/// endpoint **scheme** says which carriage this connector dials that peer
/// on (§2.1). ADR 0027 deleted the raw-TCP peer wire, so there is no third
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
///   `infra/linode-node/connector-rust.toml` and its store twin are
///   committed to a **public** repository, so a peering written with a
///   literal cannot be committed at all, and the live apex↔store peering
///   was configured on the boxes only -- exactly the untracked-config
///   drift the Phase 0 reconciliation (#744) closed. Every other secret in
///   those same files is already a file reference (`[signer] key_file`,
///   `[settlement.*.key] key_file`); this makes the peering secret the
///   same shape.
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
/// read about it (ADR 0027, issue #679).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeer {
    id: String,
    /// Removed with the raw-TCP peer wire (ADR 0027, issue #679); a peer
    /// is reached by `endpoint` now.
    #[serde(default)]
    addr: Option<toml::Value>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    credential: Option<RawPeerCredential>,
    #[serde(default)]
    ceiling: Option<u64>,
    #[serde(default)]
    flush_interval_ms: Option<u64>,
    #[serde(default)]
    claim_ack_timeout_ms: Option<u64>,
    #[serde(default)]
    peer_answer_timeout_ms: Option<u64>,
}

/// A fully validated peering relation. Constructed only by
/// [`resolve_peers`], so a value that exists has a non-empty id unique
/// among every other configured peer, a non-empty credential, and -- if it
/// carries an endpoint at all -- one whose scheme names a real carriage.
///
/// One value per **peering relation**, never per carriage and never per
/// connection (`peer-carriage-spec.md` §2.5): the ceiling, the flush
/// interval and the claim watermarks all belong to the relation, and
/// splitting them per carriage is a double-spend surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    id: String,
    endpoint: Option<Url>,
    dial: Option<PeerCarriage>,
    credential: PeerCredential,
    can_originate: bool,
    ceiling: Option<u64>,
    flush_interval_ms: Option<u64>,
    claim_ack_timeout_ms: u64,
    peer_answer_timeout_ms: u64,
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

    /// The exposure ceiling for this peering relation, in the settlement
    /// asset's smallest unit -- the most unclaimed value this connector
    /// will carry for it before refusing. `None` means the runtime's own
    /// default, which is allowed **only** for a peering this connector can
    /// dial: for one it cannot, the ceiling is the sole real bound and an
    /// absent one is refused at load (§6.4(3)).
    pub fn ceiling(&self) -> Option<u64> {
        self.ceiling
    }

    /// How often this connector promises to flush a pending claim to this
    /// peer, in milliseconds; `None` means the runtime's own default.
    pub fn flush_interval_ms(&self) -> Option<u64> {
        self.flush_interval_ms
    }

    /// How long a flushed claim may go unacknowledged before it is
    /// retransmitted (§6.3). Defaults to 30 000 ms.
    pub fn claim_ack_timeout_ms(&self) -> u64 {
        self.claim_ack_timeout_ms
    }

    /// How long a request to this peer may go unanswered (§6.3). Defaults
    /// to 30 000 ms.
    pub fn peer_answer_timeout_ms(&self) -> u64 {
        self.peer_answer_timeout_ms
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

        // A peering with nothing to dial, on a connector with nothing to
        // dial into, can never establish -- and no amount of retrying
        // changes that (§2.2).
        if endpoint.is_none() && expose.is_empty() {
            return Err(ConfigError::PeerUndialable { id: peer.id });
        }

        // The accept-only side cannot originate, so it cannot prompt a
        // payer that has simply stopped sending, and on HTTP it has no
        // live session to read liveness from: the ceiling is its only real
        // bound, and a defaulted one there is an unowned credit decision
        // (§6.4(3)).
        if endpoint.is_none() && peer.ceiling.is_none() {
            return Err(ConfigError::AcceptOnlyPeerWithoutCeiling { id: peer.id });
        }

        let can_originate = endpoint.is_some() || expose.exposes(PeerCarriage::Btp);

        peers.push(PeerConfig {
            id: peer.id,
            endpoint,
            dial,
            credential,
            can_originate,
            ceiling: peer.ceiling,
            flush_interval_ms: peer.flush_interval_ms,
            claim_ack_timeout_ms: peer.claim_ack_timeout_ms.unwrap_or(DEFAULT_PEER_TIMEOUT_MS),
            peer_answer_timeout_ms: peer
                .peer_answer_timeout_ms
                .unwrap_or(DEFAULT_PEER_TIMEOUT_MS),
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
        entry.ceiling = Some(1_000);

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
        entry.ceiling = Some(1_000);

        let peers = resolve_peers(vec![entry], PeerExposure::Http, false).expect("resolve");

        assert!(!peers[0].can_originate());
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
