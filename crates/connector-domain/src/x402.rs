//! The x402 v2 `payment-required` greeting: **one** wire shape, written by
//! the client edge and read by whoever dials one.
//!
//! These types were the client edge's own private structs until issue #874.
//! They live here now for the reason ADR 0027 gives for the BTP frame
//! grammar living in one codec crate: the greeting is emitted by
//! `connector-client-edge` (`x402_terms_body`, served as an HTTP 402 body
//! and, on the BTP carriage, as `payment-required` protocolData on a REJECT)
//! and read by the peer carriages, which sit *below* the client edge in the
//! crate graph and so cannot import it. A reader that re-declared the shape
//! would be a second wire definition free to drift from the emitter, which
//! is exactly the fork `connector-btp`'s shared entry names exist to
//! prevent. `connector-domain` is the one crate both sides already depend
//! on, and a wire shape with no I/O in it is domain by ADR 0001's own test.
//!
//! [`parse_greeting`] is the reader. Its contract is the part worth being
//! careful about: a greeting that is **present but unreadable** must never
//! degrade into "no payment required" -- that would turn a refusal to pay
//! into a silent free ride. So absence is the caller's business (there is
//! simply no greeting entry), and everything else is either terms or a
//! typed [`GreetingError`].

use serde::{Deserialize, Serialize};

/// The x402 version this connector emits and reads.
pub const X402_VERSION: u32 = 2;

/// The x402 v2 payment-required greeting (client-edge-spec.md §1.4): the
/// terms of the one payment method this connector's client edge actually
/// understands -- a TOON payment channel claim, over this same `/ilp`
/// endpoint. `accepts` is a list (ADR 0022's fourth acceptance criterion)
/// so a later method can be offered alongside this one without changing
/// the answer's shape; only one entry exists today because on-chain
/// settlement addresses (the `exact` x402 scheme's `asset`/`payTo`) are not
/// yet configured anywhere in this connector (issue #526 is answering
/// terms, not adding that config).
///
/// # What is required on the way in
///
/// Deserialization is deliberately more forgiving than serialization is
/// exact. Every field this connector emits is always written, but only the
/// ones a payer must have to act -- the version, the resource, and an
/// offer's `amount`/`payTo` -- are required to read one back. The rest
/// default, so a greeting from an older or a differently-implemented edge
/// (the TypeScript fleet's, say) is read as terms rather than rejected as
/// garbage over a field a payer never consults. What a payer *cannot* do
/// without is checked in [`parse_greeting`], not silently defaulted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402PaymentRequired {
    #[serde(rename = "x402Version")]
    pub x402_version: u32,
    pub resource: X402Resource,
    pub accepts: Vec<X402PaymentOption>,
}

impl X402PaymentRequired {
    /// The offer a payer would satisfy -- the first `accepts` entry, since
    /// only one payment method exists today and the list is ordered by the
    /// emitter's own preference.
    pub fn offer(&self) -> Option<&X402PaymentOption> {
        self.accepts.first()
    }

    /// What the offer costs, in the asset's base units. `None` when there
    /// is no offer or its `amount` is not a decimal uint64 -- a greeting
    /// [`parse_greeting`] accepted always answers `Some`.
    pub fn price(&self) -> Option<u64> {
        self.offer()?.amount.parse().ok()
    }

    /// Who the payment is addressed to (the `exact` scheme's `payTo`).
    pub fn pay_to(&self) -> Option<&str> {
        self.offer().map(|offer| offer.pay_to.as_str())
    }

    /// `"http"` or `"btp"` when this greeting answers a request that
    /// arrived over a transport the route does not accept (issue #701),
    /// naming the transport the route actually requires. `None` on an
    /// ordinary unpaid-request greeting.
    pub fn required_transport(&self) -> Option<&str> {
        self.offer()?.extra.required_transport.as_deref()
    }

    /// The EVM channel-opening facts a payer signs an EIP-712 claim under,
    /// taken from the legacy `extra.settlement` object when present and
    /// otherwise from the first EVM entry of the per-chain
    /// `extra.settlements` list (issue #632) -- the two carry the same
    /// facts on a node that has both, so either answers.
    ///
    /// This is the *receiver's* domain, and it is the only correct one: a
    /// claim signed under the payer's own idea of the `TokenNetwork`
    /// recovers to a different address and is refused.
    pub fn evm_settlement(&self) -> Option<&X402SettlementTerms> {
        let extra = &self.offer()?.extra;
        extra.settlement.as_ref().or_else(|| {
            extra.settlements.iter().find_map(|entry| match entry {
                X402ChainSettlementTerms::Evm(evm) => Some(evm),
                X402ChainSettlementTerms::Solana(_) => None,
            })
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402Resource {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402PaymentOption {
    #[serde(default)]
    pub scheme: String,
    #[serde(default)]
    pub network: String,
    /// The price, in base units, as a decimal string. Required: it is the
    /// term a payer has to satisfy.
    pub amount: String,
    /// Required, for the same reason `amount` is -- a payer cannot act on
    /// an offer that names no payee.
    #[serde(rename = "payTo")]
    pub pay_to: String,
    #[serde(rename = "maxTimeoutSeconds", default)]
    pub max_timeout_seconds: u64,
    #[serde(rename = "httpEndpoint", default)]
    pub http_endpoint: String,
    #[serde(default)]
    pub extra: X402ChannelExtra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402ChannelExtra {
    #[serde(rename = "ilpAddress", default)]
    pub ilp_address: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub price: String,
    /// The emitting node's own ILP address(es) (issue #807) -- the
    /// authoritative list from `[announce]`, never an echo of the probed
    /// `destination` the way `ilp_address` above is. Present exactly when
    /// the emitter has a bootstrap identity configured; empty (and absent
    /// on the wire) otherwise, so a parser written before this field
    /// existed is unaffected.
    #[serde(
        rename = "ilpAddresses",
        skip_serializing_if = "Vec::is_empty",
        default
    )]
    pub ilp_addresses: Vec<String>,
    /// Where clients pay the emitting node over BTP (issue #807) -- the
    /// same fact a kind:10032 announce carries as `btpEndpoint`. Present
    /// exactly when a bootstrap identity is configured; `None` (and absent
    /// on the wire) otherwise, same treatment as `settlement`/`settlements`
    /// below.
    #[serde(
        rename = "btpEndpoint",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub btp_endpoint: Option<String>,
    /// The channel-opening facts (issue #617), present exactly when the
    /// emitting node has a settlement backend. `None` (and absent on the
    /// wire) on a settlement-less node -- the terms shape is otherwise
    /// unchanged, so a parser written before this field existed is
    /// unaffected.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub settlement: Option<X402SettlementTerms>,
    /// Every configured chain's channel-opening facts (issue #632), additive
    /// beside [`settlement`](Self::settlement): a node settling on N chains
    /// (epic #627) lists all N here, including the same EVM entry
    /// `settlement` already carries verbatim. Absent -- not an empty array
    /// -- on a node with no settlement backend at all, so the pre-#632
    /// shape (and the pre-#617 shape beneath it) stays byte-identical for a
    /// settlement-less node; a parser written before either field existed
    /// is unaffected either way.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub settlements: Vec<X402ChainSettlementTerms>,
    /// Present, and self-diagnosing, exactly when this greeting answers a
    /// request that arrived over a transport its route's policy does not
    /// accept (issue #701, toon-meta#262 decision 11): `"http"` or `"btp"`,
    /// naming the transport the route actually requires. Absent -- not
    /// `null` -- on every other greeting, so the pre-#701 shape is
    /// unchanged for a route with no transport restriction.
    #[serde(
        rename = "requiredTransport",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub required_transport: Option<String>,
    /// The session lease backstop TTL the emitting node's client session
    /// registry actually enforces (issue #722, toon-meta#262 decision 12's
    /// cross-plane invariant), in milliseconds -- always emitted, unlike
    /// `settlement`/`settlements`/`requiredTransport`, since every node has
    /// a session registry regardless of settlement backend. Always the same
    /// value `connector_client_edge::session_registry`'s
    /// `SESSION_LEASE_BACKSTOP_TTL` enforces, never a second literal typed
    /// nearby: a client (buzz#84's relay-side freshness window among them)
    /// reads this instead of hardcoding a guessed millisecond count.
    #[serde(rename = "sessionLeaseTtlMs", default)]
    pub session_lease_ttl_ms: u64,
}

/// What an unaffiliated buyer needs to OPEN a channel with the emitting
/// node, carried in the x402 greeting's `extra` (issue #617). This is ADR
/// 0022's "answers when asked" applied to channel establishment: the
/// TypeScript fleet distributes these same facts in a kind:10032 announce,
/// which this fleet will never make -- the greeting is the ask that
/// replaces it.
///
/// Every field is a fact the node already proved at startup:
/// `EvmSettlementBackend::connect` resolved `token_network` through the
/// registry and refused to boot on a `decimals` disagreement, so nothing
/// here can drift from the deployment without the node failing to start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402SettlementTerms {
    /// `evm:<chainId>`, the chain the backend read at connect time.
    pub chain: String,
    /// The on-chain counterparty a buyer opens a channel WITH -- the
    /// settlement backend's own signing address.
    #[serde(rename = "settlementAddress")]
    pub settlement_address: String,
    /// The stable operator-facing factory address (issue #576).
    #[serde(rename = "tokenNetworkRegistry")]
    pub token_network_registry: String,
    /// The resolved `TokenNetwork` -- the EIP-712 `verifyingContract` a
    /// claim on any of its channels is signed under.
    #[serde(rename = "tokenNetwork")]
    pub token_network: String,
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    /// The token's own reported scale -- informational (claims are already
    /// in base units), verified against the chain at startup (issue #564).
    pub decimals: u8,
}

/// One configured chain's entry in the x402 greeting's `extra.settlements`
/// list (issue #632, epic #627's per-chain expansion of the single EVM
/// [`X402SettlementTerms`] issue #617 shipped). Untagged: serde tries each
/// variant in declaration order and keeps the first one whose required
/// fields all deserialize, so as long as every variant has at least one
/// field the others lack -- `tokenNetworkRegistry` for EVM, `programId` for
/// Solana -- that structural mismatch alone disambiguates them; no explicit
/// tag is needed on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum X402ChainSettlementTerms {
    /// Exactly the same facts, in the same shape, the legacy `extra.settlement`
    /// object carries -- a two-chain node's `settlements` entry for its EVM
    /// leg is byte-identical to its legacy `settlement` object.
    Evm(X402SettlementTerms),
    /// See [`X402SolanaSettlementTerms`] for what each field means.
    Solana(X402SolanaSettlementTerms),
}

/// The Solana twin of [`X402SettlementTerms`] (issue #632): what an
/// unaffiliated buyer needs to open a channel against the emitting node's
/// deployed `payment-channel` program instance. Every field is a fact
/// `SolanaSettlementBackend::connect` already proved at startup (issue
/// #630) -- the program is reachable, executable and proven to behave like
/// the deployed payment-channel program, and the configured `decimals`
/// agrees with the mint's own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct X402SolanaSettlementTerms {
    /// Always `"solana"` -- unlike EVM, a Solana backend has no chain id to
    /// append: the program id already names exactly one deployed instance.
    pub chain: String,
    /// The on-chain counterparty a buyer opens a channel WITH -- the
    /// settlement backend's own signing pubkey, base58-encoded.
    #[serde(rename = "settlementAddress")]
    pub settlement_address: String,
    /// The deployed `payment-channel` program instance, base58-encoded.
    #[serde(rename = "programId")]
    pub program_id: String,
    /// The SPL mint every channel this backend opens settles in,
    /// base58-encoded.
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    /// The mint's own reported scale -- informational (claims are already
    /// in base units), verified against the chain at startup (issue #630).
    pub decimals: u8,
}

/// A `payment-required` greeting that was **there and unreadable** (issue
/// #874).
///
/// Every variant means the same operationally -- this connector cannot
/// learn what it owes -- and none of them may ever be collapsed into "no
/// terms were offered". They are told apart because the reason is what a
/// human debugging a link needs: a truncated frame, a non-x402 body, and a
/// future x402 version are three different bugs with three different
/// fixes, and only one of them is the far side's.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GreetingError {
    /// The bytes are not JSON at all.
    #[error("the payment-required greeting is not JSON: {0}")]
    NotJson(String),
    /// JSON, but not the x402 v2 terms shape -- a required field is
    /// missing or has the wrong type.
    #[error("the payment-required greeting is not x402 terms: {0}")]
    NotTerms(String),
    /// A version this connector has no reader for. Deliberately not
    /// best-effort parsed: a v3 greeting may price things differently, and
    /// paying against a misread offer is worse than not paying.
    #[error("x402 version {0} is not understood (this connector reads v{X402_VERSION})")]
    UnsupportedVersion(u32),
    /// Well-formed, but it offers nothing -- `accepts` is empty. There is
    /// no payment that would satisfy it, which is not the same as there
    /// being no payment required.
    #[error("the payment-required greeting offers no payment method")]
    NoOffer,
    /// The offer's price is not a decimal uint64, so there is no amount to
    /// cover.
    #[error("the offered amount '{0}' is not a decimal uint64")]
    UnreadableAmount(String),
    /// The offer names no payee.
    #[error("the payment-required greeting names no payTo")]
    NoPayee,
}

/// Read a `payment-required` greeting's terms.
///
/// The bytes are whatever carried the greeting -- an HTTP 402 body, or the
/// `payment-required` protocolData entry of a BTP REJECT; both carriages
/// carry the identical bytes by construction (`x402_terms_body` is shared),
/// which is why one reader serves both.
///
/// Everything this returns `Err` for is a greeting that *was present*. A
/// caller that found no greeting at all must not route through here: it has
/// an ordinary answer, not a malformed one. That distinction is the whole
/// point -- see [`GreetingError`].
pub fn parse_greeting(bytes: &[u8]) -> Result<X402PaymentRequired, GreetingError> {
    // Two steps rather than one `from_slice::<X402PaymentRequired>` so the
    // "not JSON" and "not terms" cases stay distinguishable: serde reports
    // both through one error type, and the operator reading the log needs
    // to know whether the far side sent rubbish or sent a shape.
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| GreetingError::NotJson(error.to_string()))?;
    let terms: X402PaymentRequired = serde_json::from_value(value)
        .map_err(|error| GreetingError::NotTerms(error.to_string()))?;

    if terms.x402_version != X402_VERSION {
        return Err(GreetingError::UnsupportedVersion(terms.x402_version));
    }
    let offer = terms.offer().ok_or(GreetingError::NoOffer)?;
    if offer.pay_to.is_empty() {
        return Err(GreetingError::NoPayee);
    }
    if offer.amount.parse::<u64>().is_err() {
        return Err(GreetingError::UnreadableAmount(offer.amount.clone()));
    }
    Ok(terms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn well_formed() -> String {
        serde_json::json!({
            "x402Version": 2,
            "resource": { "url": "g.toon.relay" },
            "accepts": [{
                "scheme": "toon-channel",
                "network": "g.toon.relay",
                "amount": "1000",
                "payTo": "g.toon.relay",
                "maxTimeoutSeconds": 60,
                "httpEndpoint": "/ilp",
                "extra": {
                    "ilpAddress": "g.toon.relay",
                    "endpoint": "/ilp",
                    "price": "1000",
                    "sessionLeaseTtlMs": 300000
                }
            }]
        })
        .to_string()
    }

    #[test]
    fn a_well_formed_greeting_yields_its_terms() {
        let terms = parse_greeting(well_formed().as_bytes()).expect("well-formed terms");
        assert_eq!(terms.price(), Some(1000));
        assert_eq!(terms.pay_to(), Some("g.toon.relay"));
        assert_eq!(terms.required_transport(), None);
        assert_eq!(terms.offer().unwrap().extra.session_lease_ttl_ms, 300_000);
    }

    #[test]
    fn bytes_that_are_not_json_are_their_own_error() {
        let error = parse_greeting(b"\xff\xfe not json").expect_err("unreadable");
        assert!(matches!(error, GreetingError::NotJson(_)), "{error:?}");
    }

    /// The case the whole reader exists for: something plausible-looking
    /// arrived and must not be mistaken for "nothing to pay".
    #[test]
    fn json_that_is_not_terms_is_a_distinct_error_from_well_formed_terms() {
        let error = parse_greeting(br#"{"error":"no route"}"#).expect_err("not terms");
        assert!(matches!(error, GreetingError::NotTerms(_)), "{error:?}");
    }

    #[test]
    fn an_offerless_greeting_is_not_a_free_ride() {
        let body = br#"{"x402Version":2,"resource":{"url":"g.toon.relay"},"accepts":[]}"#;
        assert_eq!(parse_greeting(body), Err(GreetingError::NoOffer));
    }

    #[test]
    fn an_unreadable_amount_is_refused_rather_than_rounded_to_zero() {
        let body = well_formed().replace(r#""amount":"1000""#, r#""amount":"lots""#);
        assert_ne!(
            body,
            well_formed(),
            "the fixture must actually have changed"
        );
        assert_eq!(
            parse_greeting(body.as_bytes()),
            Err(GreetingError::UnreadableAmount("lots".to_string()))
        );
    }

    #[test]
    fn a_future_x402_version_is_refused_rather_than_best_effort_parsed() {
        let body = well_formed().replace(r#""x402Version":2"#, r#""x402Version":3"#);
        assert_ne!(
            body,
            well_formed(),
            "the fixture must actually have changed"
        );
        assert_eq!(
            parse_greeting(body.as_bytes()),
            Err(GreetingError::UnsupportedVersion(3))
        );
    }

    /// A greeting from an edge that writes fewer decorative fields, or more
    /// of them, is still terms: only what a payer must act on is required.
    #[test]
    fn a_leaner_or_richer_greeting_still_reads_as_terms() {
        let lean = br#"{"x402Version":2,"resource":{"url":"g.toon.relay"},
            "accepts":[{"amount":"7","payTo":"g.toon.relay","futureField":true}]}"#;
        let terms = parse_greeting(lean).expect("the essentials are all there");
        assert_eq!(terms.price(), Some(7));
        assert_eq!(terms.offer().unwrap().extra, X402ChannelExtra::default());
    }

    #[test]
    fn the_evm_domain_is_read_from_either_settlement_shape() {
        let evm = X402SettlementTerms {
            chain: "evm:31337".to_string(),
            settlement_address: "0x1".to_string(),
            token_network_registry: "0x2".to_string(),
            token_network: "0x3".to_string(),
            token_address: "0x4".to_string(),
            decimals: 6,
        };
        let solana = X402SolanaSettlementTerms {
            chain: "solana".to_string(),
            settlement_address: "Sett".to_string(),
            program_id: "Prog".to_string(),
            token_address: "Mint".to_string(),
            decimals: 6,
        };

        let mut terms = parse_greeting(well_formed().as_bytes()).unwrap();
        assert_eq!(terms.evm_settlement(), None);

        // The per-chain list alone answers, Solana entry and all...
        terms.accepts[0].extra.settlements = vec![
            X402ChainSettlementTerms::Solana(solana),
            X402ChainSettlementTerms::Evm(evm.clone()),
        ];
        assert_eq!(terms.evm_settlement(), Some(&evm));

        // ...as does the legacy single object on a pre-#632 greeting.
        terms.accepts[0].extra.settlements.clear();
        terms.accepts[0].extra.settlement = Some(evm.clone());
        assert_eq!(terms.evm_settlement(), Some(&evm));
    }

    /// The untagged enum's disambiguation is structural, so it has to
    /// survive a round trip rather than merely compile.
    #[test]
    fn a_settlements_list_round_trips_through_json() {
        let terms: X402PaymentRequired = serde_json::from_str(&well_formed()).unwrap();
        let json = serde_json::to_vec(&terms).unwrap();
        assert_eq!(parse_greeting(&json), Ok(terms));
    }
}
