//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

/// A route whose traffic this connector forwards to a peer's connector for
/// the next hop, rather than terminating it at an app of its own. `fee` is
/// this peering relation's flat per-packet fee (ADR 0010) -- charged once
/// per forwarded packet, agreed bilaterally, and never a share of the
/// amount being carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    prefix: String,
    peer_id: String,
    fee: u64,
}

impl PeerRoute {
    pub fn new(prefix: impl Into<String>, peer_id: impl Into<String>, fee: u64) -> PeerRoute {
        PeerRoute {
            prefix: prefix.into(),
            peer_id: peer_id.into(),
            fee,
        }
    }

    /// The destination prefix this route forwards.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The peer this route's traffic is forwarded to, by id -- resolved to
    /// an actual peer connection through the [`crate::PeerTransport`] port.
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// This peering relation's flat per-packet fee (ADR 0010).
    pub fn fee(&self) -> u64 {
        self.fee
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_prefix_peer_id_and_fee() {
        let route = PeerRoute::new("g.example.remote", "peer-b", 5);
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
        assert_eq!(route.fee(), 5);
    }
}
