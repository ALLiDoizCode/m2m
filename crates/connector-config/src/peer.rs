use std::collections::HashSet;
use std::net::SocketAddr;

use serde::Deserialize;

use crate::error::ConfigError;

/// A `[[peers]]` entry as written in the config file: a peering relation
/// this node dials out to. Accepting an inbound connection from a peer
/// needs no configuration of its own -- see `Config::peer_wire_addr`.
#[derive(Debug, Deserialize)]
pub(crate) struct RawPeer {
    id: String,
    addr: String,
}

/// A fully validated peer this node dials: a non-empty id, unique among
/// every other configured peer, and a socket address
/// [`connector_runtime::NetworkPeerTransport`] can connect to. Constructed
/// only by [`resolve_peers`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerConfig {
    id: String,
    addr: SocketAddr,
}

impl PeerConfig {
    /// This peering relation's id -- what a `[[routes]]` entry's `peer_id`
    /// refers to.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The address this node dials to reach the peer.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

pub(crate) fn resolve_peers(raw: Vec<RawPeer>) -> Result<Vec<PeerConfig>, ConfigError> {
    let mut seen = HashSet::with_capacity(raw.len());
    let mut peers = Vec::with_capacity(raw.len());

    for peer in raw {
        if peer.id.trim().is_empty() {
            return Err(ConfigError::PeerIdEmpty);
        }
        let addr =
            peer.addr
                .parse::<SocketAddr>()
                .map_err(|source| ConfigError::InvalidPeerAddr {
                    id: peer.id.clone(),
                    value: peer.addr.clone(),
                    source,
                })?;
        if !seen.insert(peer.id.clone()) {
            return Err(ConfigError::DuplicatePeerId { id: peer.id });
        }
        peers.push(PeerConfig { id: peer.id, addr });
    }

    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str, addr: &str) -> RawPeer {
        RawPeer {
            id: id.to_string(),
            addr: addr.to_string(),
        }
    }

    #[test]
    fn resolves_valid_peers() {
        let peers = resolve_peers(vec![raw("peer-b", "127.0.0.1:5000")]).expect("resolve");
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].id(), "peer-b");
        assert_eq!(peers[0].addr(), "127.0.0.1:5000".parse().unwrap());
    }

    #[test]
    fn rejects_an_empty_id() {
        let result = resolve_peers(vec![raw("", "127.0.0.1:5000")]);
        assert!(matches!(result, Err(ConfigError::PeerIdEmpty)));
    }

    #[test]
    fn rejects_an_unparseable_addr() {
        let result = resolve_peers(vec![raw("peer-b", "not-an-address")]);
        assert!(matches!(result, Err(ConfigError::InvalidPeerAddr { .. })));
    }

    #[test]
    fn rejects_a_duplicate_peer_id() {
        let result = resolve_peers(vec![
            raw("peer-b", "127.0.0.1:5000"),
            raw("peer-b", "127.0.0.1:5001"),
        ]);
        assert!(matches!(result, Err(ConfigError::DuplicatePeerId { .. })));
    }
}
