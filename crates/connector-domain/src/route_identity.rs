//! **Which key a payload to a destination must be sealed to** (issue
//! #1026): the wire shape a connector answers with, and relays, when asked
//! for the identity that terminates a route.
//!
//! ADR 0018 seals every packet's `data` to the identity of the connector
//! that *terminates* the route. On a terminated route that is the connector
//! the client is talking to, and `GET /ilp/identity` answers it. On a
//! forwarded route (ADR 0028) it is some other connector, one or more hops
//! away, and until this type existed nothing on the wire could name it: the
//! client sealed to the hop it could see, and the far end rejected `F01`.
//!
//! [`RouteIdentity`] is a **signed statement by the terminating connector**
//! over `(prefix, its own identity key)`, signed with that same key. A hop
//! that forwards `prefix` relays the statement verbatim; it cannot forge one
//! because it does not hold the key, and if it withholds or corrupts one the
//! packet fails visibly instead of being readable by the hop -- which is
//! the whole point of sealing to the terminating connector in the first
//! place. It composes past two hops for the same reason: each hop relays
//! what it was given.
//!
//! This crate holds the **shape only**. What the signature is over and how
//! it is checked is `connector_signer::route_identity`, kept in one module
//! so the encoding can change without touching any of the places the shape
//! is carried: `GET /ilp/identity?destination=`, the client-facing x402
//! greeting's `extra.routeIdentity`, and the peer greeting's.

use serde::{Deserialize, Serialize};

/// The identity a payload to any destination under `prefix` must be sealed
/// to, as the connector holding that identity states it.
///
/// `public_key` and `signature` are `0x`-prefixed lowercase hex, the same
/// encoding `GET /ilp/identity`'s `publicKey` already uses: 65 bytes of
/// uncompressed secp256k1 public key, and 65 bytes of `r || s || v`
/// recoverable signature (`connector_signer::Signature::to_bytes`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteIdentity {
    /// The ILP prefix this statement covers. A relayed statement's prefix
    /// may be longer than the relaying hop's own route prefix -- a hop that
    /// forwards `g.example` may relay a statement for `g.example.app` -- so
    /// a reader checks its destination against *this*, never against the
    /// route it asked about.
    pub prefix: String,
    /// The terminating connector's identity, uncompressed secp256k1.
    #[serde(rename = "publicKey")]
    pub public_key: String,
    /// The terminating connector's signature over `(prefix, public_key)`,
    /// made with the private half of `public_key`. Its exact preimage is
    /// `connector_signer::route_identity`'s business.
    pub signature: String,
}

impl RouteIdentity {
    /// Whether `destination` is `prefix` itself or an address beneath it
    /// -- the same "prefix or prefix." rule ILP routing uses, so a
    /// statement for `g.example.app` does not cover `g.example.apparel`.
    #[must_use]
    pub fn covers(&self, destination: &str) -> bool {
        destination == self.prefix
            || destination
                .strip_prefix(self.prefix.as_str())
                .is_some_and(|rest| rest.starts_with('.'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statement(prefix: &str) -> RouteIdentity {
        RouteIdentity {
            prefix: prefix.to_string(),
            public_key: "0x04".to_string(),
            signature: "0x00".to_string(),
        }
    }

    #[test]
    fn a_statement_covers_its_prefix_and_what_lies_beneath_it() {
        let statement = statement("g.example.app");
        assert!(statement.covers("g.example.app"));
        assert!(statement.covers("g.example.app.deeper.still"));
    }

    #[test]
    fn a_statement_does_not_cover_a_sibling_that_merely_shares_characters() {
        let statement = statement("g.example.app");
        assert!(!statement.covers("g.example.apparel"));
        assert!(!statement.covers("g.example"));
        assert!(!statement.covers("g.other.app"));
    }

    #[test]
    fn the_wire_shape_uses_the_identity_endpoints_field_names() {
        let json = serde_json::to_value(statement("g.example.app")).expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "prefix": "g.example.app",
                "publicKey": "0x04",
                "signature": "0x00",
            })
        );
        let back: RouteIdentity = serde_json::from_value(json).expect("round-trips");
        assert_eq!(back, statement("g.example.app"));
    }
}
