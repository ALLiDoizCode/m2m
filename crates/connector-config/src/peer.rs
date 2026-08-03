use std::collections::HashSet;

use serde::Deserialize;

use crate::error::ConfigError;

/// A `[[peers]]` entry as written in the config file: one peering
/// relation, named so a `[[routes]]` entry can target it by `peer_id`.
///
/// **This entry cannot yet be reached.** Its `addr` -- a literal
/// `SocketAddr` the deleted raw-TCP peer wire dialed -- went with that wire
/// in ADR 0027 / issue #679, and the replacement (`endpoint` as a `wss://`
/// or `https://` URL, plus a peer credential, plus a `[[peer_channels]]`
/// table) is issue #677. Between the two, a peering relation is a name and
/// nothing else, and a packet routed to one gets `T01 peer unreachable`.
///
/// `deny_unknown_fields` (issue #556): a peer entry carrying a key this
/// build does not read -- a typo, or a field from a shape this connector
/// does not implement -- fails config load loudly rather than being
/// dropped and the node peering on terms nobody wrote. `addr` is kept as a
/// *parsed and rejected* field rather than left to that generic message,
/// so a stale bind-mounted box config gets told what happened and where to
/// read about it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPeer {
    id: String,
    #[serde(default)]
    addr: Option<toml::Value>,
}

/// A fully validated peering relation: a non-empty id, unique among every
/// other configured peer. Constructed only by [`resolve_peers`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    id: String,
}

impl PeerConfig {
    /// This peering relation's id -- what a `[[routes]]` entry's `peer_id`
    /// refers to.
    pub fn id(&self) -> &str {
        &self.id
    }
}

pub(crate) fn resolve_peers(raw: Vec<RawPeer>) -> Result<Vec<PeerConfig>, ConfigError> {
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
        peers.push(PeerConfig { id: peer.id });
    }

    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str) -> RawPeer {
        RawPeer {
            id: id.to_string(),
            addr: None,
        }
    }

    #[test]
    fn resolves_valid_peers() {
        let peers = resolve_peers(vec![raw("peer-b")]).expect("resolve");
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id(), "peer-b");
    }

    #[test]
    fn rejects_an_empty_id() {
        let result = resolve_peers(vec![raw("")]);
        assert!(matches!(result, Err(ConfigError::PeerIdEmpty)));
    }

    /// ADR 0027 / issue #679: the raw-TCP `addr` is gone, and a config
    /// still carrying one must fail at boot by name rather than be
    /// silently ignored into a node that quietly never peers.
    #[test]
    fn rejects_a_peer_that_still_names_the_removed_addr() {
        let result = resolve_peers(vec![RawPeer {
            id: "peer-b".to_string(),
            addr: Some(toml::Value::String("127.0.0.1:5000".to_string())),
        }]);
        let Err(error) = result else {
            panic!("expected a config error");
        };
        assert!(matches!(error, ConfigError::PeerAddrRemoved { .. }));
        assert!(error
            .to_string()
            .contains("docs/operators/btp-peer-transport-bringup.md"));
    }

    #[test]
    fn rejects_a_duplicate_peer_id() {
        let result = resolve_peers(vec![raw("peer-b"), raw("peer-b")]);
        assert!(matches!(result, Err(ConfigError::DuplicatePeerId { .. })));
    }
}
