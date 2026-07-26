//! A routing-table entry whose next hop is another connector rather than
//! this one's own app. Paired with `connector_config::StaticRoute` at the
//! [`crate::Connector`] level -- `connector_domain::select_route` picks the
//! most specific prefix across both kinds without caring which one it is.

/// A route whose traffic this connector forwards to a peer's connector for
/// the next hop, rather than terminating it at an app of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    prefix: String,
    peer_id: String,
}

impl PeerRoute {
    pub fn new(prefix: impl Into<String>, peer_id: impl Into<String>) -> PeerRoute {
        PeerRoute {
            prefix: prefix.into(),
            peer_id: peer_id.into(),
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_prefix_and_peer_id() {
        let route = PeerRoute::new("g.example.remote", "peer-b");
        assert_eq!(route.prefix(), "g.example.remote");
        assert_eq!(route.peer_id(), "peer-b");
    }
}
