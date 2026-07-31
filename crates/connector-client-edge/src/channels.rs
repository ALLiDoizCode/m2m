//! Per-channel counterparty registry for the client edge (issues #558,
//! #556): which key this connector accepts a claim's signature from, for
//! each channel it has a record of.
//!
//! This is what turns `client-edge-spec.md` §1.3 step 4 from a
//! self-referential check into a real one. A claim carries its own
//! `signerAddress`/`signerPublicKey`, but a forger can put anything there
//! -- signing correctly with a freshly generated key and declaring
//! themself the payer costs nothing. The only party whose signature means
//! anything on a channel is that channel's counterparty, and a
//! counterparty is a property of the channel, not of the claim. So it is
//! recorded here, keyed by the channel, and a claim gets no say in it:
//! [`crate::ClientClaimGate`] reads the signer -- and, for EVM, the EIP-712
//! domain the digest is computed under (ADR 0024) -- out of this registry
//! and never out of the claim.
//!
//! Deliberately the same shape the peer wire already settled on:
//! `connector_runtime::ClaimBook` keeps a `channel_id -> Address` map plus
//! a per-channel `ChannelDomain` for exactly this reason (issue #575), and
//! refuses a claim naming a channel it has no record of as
//! `ClaimRejectReason::UnknownChannel`. This is that rule at the other
//! edge, over the client edge's own claim shapes, since a client-edge
//! claim's channel is never a peer-wire channel.
//!
//! # Where a record comes from
//!
//! Two sources, and they compose rather than replace each other:
//!
//! 1. **Declared** -- [`ClientChannelRegistry::record_evm`] /
//!    [`record_solana`](ClientChannelRegistry::record_solana), which
//!    `connector-cli` fills from the `[[client_channels]]` config section.
//!    A node with no settlement backend at all still declares its channels
//!    this way, and a declared channel is authoritative: it is answered
//!    from memory and never resolved.
//! 2. **Resolved from chain** -- a [`ClientChannelSource`] registered per
//!    chain ([`ClientChannelRegistry::with_source`] for EVM,
//!    [`ClientChannelRegistry::with_solana_source`] for Solana), asked only
//!    about a channel nothing was declared for. `connector-cli` builds one
//!    over the `[settlement.evm]` section's own `TokenNetwork` (issue
//!    #611) and one over the `[settlement.solana]` section's own deployed
//!    payment-channel program (issue #631), so a client that has opened a
//!    channel with this connector on chain can pay without the operator
//!    hand-editing config and restarting. The source is keyed by chain
//!    (issue #629), so an EVM source is never consulted for a Solana
//!    lookup or vice versa.
//!
//! The second is what makes issue #502's *"anonymity is a first-class
//! path, not a fallback: it is how an unaffiliated buyer pays for a
//! terminated route without registering with the operator first"* true
//! rather than aspirational. An unaffiliated buyer registers with the
//! *chain* -- a public fact this connector can read for itself -- instead
//! of with the operator.
//!
//! **Nothing falls back to the claim's own self-declared signer.** A
//! registry with neither a record nor a source refuses every claim
//! ([`crate::ClaimIngestRejection::UnknownChannel`]); a source that cannot
//! answer -- an unreachable RPC endpoint, say -- refuses the claim it was
//! asked about ([`crate::ClaimIngestRejection::ChannelLookupFailed`]),
//! distinguishably and never silently. "Unverifiable" is never "accepted",
//! by configuration, flag or build profile.
//!
//! # Caching, and why invalidation is a non-problem
//!
//! A resolution happens on the packet path, so it must not become an RPC
//! round trip per packet. Every resolved channel is therefore memoised for
//! the process's lifetime and **is never invalidated**, because what is
//! memoised is immutable on chain. `TokenNetwork.openChannel`
//! (`packages/contracts/src/TokenNetwork.sol:206-213`) assigns
//! `participant1`/`participant2` once, when the channel is created, and no
//! other function in that contract ever assigns either field again --
//! `setTotalDeposit`, `claimFromChannel`, `closeChannel` and
//! `settleChannel` mutate deposits, claimed amounts and `state` only. The
//! EIP-712 domain is immutable for the same reason one layer up:
//! OpenZeppelin's `EIP712("TokenNetwork", "1")` derives it from
//! `block.chainid` and `address(this)`, and a deployed `TokenNetwork`'s
//! address does not move.
//!
//! What is *not* memoised is any answer that could change: a lookup
//! failure, and a "no such channel". A buyer who opens a channel and pays
//! a second later has to be payable on their next attempt rather than
//! after a TTL, which is exactly the registration-free path #502 asks for.
//! The cost is that a sender naming channels that do not exist can make
//! this connector perform one `eth_call` each. Two things bound it: a
//! resolution is a single `TokenNetwork.channels(id)` read rather than the
//! three-call `SettlementBackend::channel_state` path, and the lookup is
//! the claim gate's *last* stage, so a claim must already be structurally
//! valid, fresh and value-covering to reach it at all (issue #544's
//! ordering). Rate-limiting it is deliberately left out of this change --
//! see the PR description.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use connector_signer::Address;

/// A channel identifier that is not the on-chain value its chain's claims
/// are signed over -- a `channelId` that is not a 32-byte `bytes32`, or a
/// `channelAccount` that is not a 32-byte Solana account. Refused at
/// registration rather than hashed or truncated into shape, matching
/// `connector_runtime::InvalidChannelId`'s rule on the peer wire (issue
/// #575).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidChannelIdentifier(pub String);

impl std::fmt::Display for InvalidChannelIdentifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "channel identifier {:?} is not a 32-byte on-chain identifier",
            self.0
        )
    }
}

impl std::error::Error for InvalidChannelIdentifier {}

/// A [`ClientChannelSource`] could not answer whether a channel exists or
/// who its counterparty is -- an unreachable RPC endpoint, a node that
/// answered with garbage, a timeout. Deliberately distinct from "this
/// channel does not exist": the first is a failure of *this connector's*,
/// the second is a fact about the world, and conflating them would let an
/// RPC outage read as a definitive "no such channel".
///
/// Either way the claim is refused. This type exists so a refusal can say
/// which of the two happened, never so anything can recover from it by
/// believing the claim instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelLookupFailed(pub String);

impl std::fmt::Display for ChannelLookupFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ChannelLookupFailed {}

/// Where a channel nothing was declared for is looked up -- in production
/// the deployed `TokenNetwork` the `[settlement]` section already names
/// (`connector-cli`'s `SettlementChannelSource`), or the deployed Solana
/// payment-channel program `[settlement.solana]` names (issue #631). Kept a
/// port rather than a direct dependency on `connector-settlement-evm` or
/// `connector-settlement-solana` so this crate stays chain-agnostic, and so
/// a test can substitute a source without a chain.
///
/// An implementation MUST report the counterparty **as the chain itself
/// holds it**, never anything derived from a claim: this trait exists
/// precisely so that a claim has no say in what it is checked against.
///
/// Both methods default to answering `Ok(None)` -- "this source knows
/// nothing about that chain's channels" -- rather than being required,
/// since [`ClientChannelRegistry`] already keeps EVM and Solana sources in
/// separate [`ClaimChain`]-keyed slots and only ever calls a source's
/// method for the chain it was registered under: an EVM-only source (say,
/// `connector-cli`'s `SettlementChannelSource`) never has `solana_channel`
/// invoked, so it has nothing useful to say there and the default is never
/// exercised in practice, only spared from being restated by every
/// implementation.
#[async_trait]
pub trait ClientChannelSource: Send + Sync + std::fmt::Debug {
    /// The record for `channel_id`, or `Ok(None)` if that is not a channel
    /// this connector can be paid on -- it was never opened, it has
    /// already settled (a claim on a settled channel can never be
    /// redeemed, so accepting one would be giving the app's work away), or
    /// neither of its participants is this connector.
    ///
    /// `Err` means the lookup itself failed and the answer is unknown. It
    /// must never be reported for a channel that is merely absent.
    async fn evm_channel(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        let _ = channel_id;
        Ok(None)
    }

    /// The Solana twin of [`evm_channel`](Self::evm_channel) (issue #631):
    /// the counterparty's raw Ed25519 public key for the channel at
    /// `channel_account`, or `Ok(None)`/`Err` under exactly the same rules.
    /// There is no domain to report alongside it -- a Solana balance proof
    /// is signed over the channel account, nonce and amount alone
    /// (`connector_signer::solana_balance_proof_message`), with no
    /// EIP-712-style verifying-contract concept to carry. The mint is not
    /// in the signed bytes either: binding a channel to the mint this node
    /// settles in is the resolving backend's job (a chain-resolved channel
    /// on any other mint must come back `Ok(None)`), not the signature's.
    async fn solana_channel(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<[u8; 32]>, ChannelLookupFailed> {
        let _ = channel_account;
        Ok(None)
    }
}

/// Everything this connector needs to verify an EVM claim on one channel
/// without believing anything the claim says about itself: whose signature
/// it accepts, and the EIP-712 domain (ADR 0024) that signature must have
/// been produced under. `chain_id` and `token_network_address` are
/// per-channel rather than node-wide for the same reason the peer wire's
/// `ChannelDomain` is (issue #566): each token gets its own `TokenNetwork`,
/// and therefore its own `verifyingContract`, so there is no single domain
/// a node could default to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvmChannel {
    /// The address whose signature this connector accepts on a claim for
    /// this channel -- recovered from the signature, never read from the
    /// claim's own `signerAddress`.
    pub counterparty: Address,
    pub chain_id: u64,
    pub token_network_address: Address,
}

/// Which chain a claim's channel lives on -- the key a
/// [`ClientChannelSource`] is registered under in
/// [`ClientChannelRegistry`], so resolving an undeclared channel dispatches
/// on the claim's own chain through a registry rather than a single
/// hardcoded slot. EVM was the first chain with a registered source (issue
/// #611); Solana composes as a second entry under `ClaimChain::Solana`
/// (issue #631), exactly as issue #629's prefactor anticipated, rather than
/// by restructuring this type again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ClaimChain {
    Evm,
    Solana,
}

/// The channels this connector has a record of, and the counterparty it
/// accepts a claim's signature from on each. EVM and Solana are separate
/// namespaces -- a `channelId` and a `channelAccount` are different kinds
/// of thing and can never satisfy each other, the same way
/// `connector_domain::ClientClaim::channel_key` namespaces the watermark
/// map.
///
/// See this module's own doc for the two sources a record comes from, and
/// for why the resolution cache is never invalidated.
#[derive(Debug, Default)]
pub struct ClientChannelRegistry {
    evm: HashMap<[u8; 32], EvmChannel>,
    solana: HashMap<[u8; 32], [u8; 32]>,
    /// Consulted only for a channel nothing was declared for, keyed by
    /// [`ClaimChain`] so each chain's source answers for that chain alone --
    /// never, say, an EVM source consulted for a Solana lookup. Empty is a
    /// node with no settlement backend: it accepts claims on exactly what
    /// its config file declares, and on nothing else.
    sources: HashMap<ClaimChain, Arc<dyn ClientChannelSource>>,
    /// Memoised answers from [`Self::sources`]. Never invalidated -- see
    /// this module's doc.
    resolved: RwLock<HashMap<[u8; 32], EvmChannel>>,
    /// The Solana twin of [`Self::resolved`] (issue #631) -- a separate map
    /// since a resolved Solana answer is a bare counterparty key, not an
    /// [`EvmChannel`].
    resolved_solana: RwLock<HashMap<[u8; 32], [u8; 32]>>,
}

impl ClientChannelRegistry {
    /// An empty registry -- one that refuses every claim, since it has a
    /// record of no channel at all and no source to resolve one from. See
    /// this module's own doc comment.
    pub fn new() -> ClientChannelRegistry {
        ClientChannelRegistry::default()
    }

    /// Consult `source` for any EVM channel this registry has no declared
    /// record of. Additive: everything already recorded stays
    /// authoritative and is still answered without a lookup, so
    /// `[[client_channels]]` keeps working exactly as it did -- and keeps
    /// working when the chain is unreachable.
    ///
    /// Registers `source` under [`ClaimChain::Evm`], so it is consulted for
    /// an EVM lookup and never a Solana one -- see
    /// [`with_solana_source`](Self::with_solana_source) for that twin.
    pub fn with_source(mut self, source: Arc<dyn ClientChannelSource>) -> ClientChannelRegistry {
        self.sources.insert(ClaimChain::Evm, source);
        self
    }

    /// The Solana twin of [`with_source`](Self::with_source) (issue #631):
    /// consult `source` for any Solana channel this registry has no
    /// declared record of, registering it under [`ClaimChain::Solana`] so
    /// an EVM source never answers a Solana lookup or vice versa (issue
    /// #629). Additive in exactly the same way: everything
    /// `[[client_channels]]` already declared stays authoritative and
    /// answered from memory without a lookup.
    pub fn with_solana_source(
        mut self,
        source: Arc<dyn ClientChannelSource>,
    ) -> ClientChannelRegistry {
        self.sources.insert(ClaimChain::Solana, source);
        self
    }

    /// Record `channel_id`'s counterparty and EIP-712 domain. `channel_id`
    /// is the wire shape a claim names it by -- `0x`-prefixed (or bare)
    /// 64-character hex -- and is refused as
    /// [`InvalidChannelIdentifier`], never coerced, if it is not.
    pub fn record_evm(
        &mut self,
        channel_id: &str,
        channel: EvmChannel,
    ) -> Result<(), InvalidChannelIdentifier> {
        let key = decode_hex_bytes::<32>(channel_id)
            .ok_or_else(|| InvalidChannelIdentifier(channel_id.to_string()))?;
        self.evm.insert(key, channel);
        Ok(())
    }

    /// Record `channel_account`'s counterparty: the Ed25519 public key
    /// whose signature this connector accepts on a Solana claim for that
    /// channel, never the claim's own `signerPublicKey`. Both are base58,
    /// the shape they ride the wire in.
    pub fn record_solana(
        &mut self,
        channel_account: &str,
        counterparty: &str,
    ) -> Result<(), InvalidChannelIdentifier> {
        let key = decode_base58_bytes::<32>(channel_account)
            .ok_or_else(|| InvalidChannelIdentifier(channel_account.to_string()))?;
        let counterparty = decode_base58_bytes::<32>(counterparty)
            .ok_or_else(|| InvalidChannelIdentifier(counterparty.to_string()))?;
        self.solana.insert(key, counterparty);
        Ok(())
    }

    /// Whether this registry can vouch for no channel at all -- nothing
    /// declared and no source to resolve one from -- so that every claim
    /// presented to a gate holding it is refused as
    /// [`crate::ClaimIngestRejection::UnknownChannel`]. A registry with a
    /// source is not empty however little it was told at startup: the
    /// channels it can answer for live on a chain, not in this map.
    pub fn is_empty(&self) -> bool {
        self.evm.is_empty() && self.solana.is_empty() && self.sources.is_empty()
    }

    /// The record for an EVM channel: declared first, then already
    /// resolved, then -- once per channel -- the [`ClaimChain::Evm`] entry
    /// of [`Self::sources`], if one is registered. A claim on a chain with
    /// no registered entry resolves nothing here, the same
    /// [`ClaimIngestRejection::UnknownChannel`] outcome as a registry with
    /// no source at all (issue #629).
    ///
    /// `Ok(None)` is "no such channel this connector can be paid on";
    /// `Err` is "the lookup failed, so the answer is unknown". Both refuse
    /// the claim; they are kept apart so the refusal can say which.
    pub(crate) async fn evm(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        if let Some(channel) = self.evm.get(channel_id) {
            return Ok(Some(*channel));
        }
        // Scoped so the read guard is released before the `.await` below:
        // a `std::sync::RwLock` guard held across a suspension point is
        // both non-`Send` and a way to stall every other packet in flight.
        {
            let resolved = self
                .resolved
                .read()
                .expect("resolved client channels lock poisoned");
            if let Some(channel) = resolved.get(channel_id) {
                return Ok(Some(*channel));
            }
        }
        let Some(source) = self.sources.get(&ClaimChain::Evm) else {
            return Ok(None);
        };
        let Some(channel) = source.evm_channel(channel_id).await? else {
            // Deliberately not memoised: a channel opened a second from
            // now must be payable on that sender's next attempt.
            return Ok(None);
        };
        self.resolved
            .write()
            .expect("resolved client channels lock poisoned")
            .insert(*channel_id, channel);
        Ok(Some(channel))
    }

    /// The counterparty for a Solana channel: declared first, then already
    /// resolved, then -- once per channel -- the [`ClaimChain::Solana`]
    /// entry of [`Self::sources`], if one is registered (issue #631, the
    /// Solana twin of [`Self::evm`]). A claim on a chain with no registered
    /// entry resolves nothing here, same as [`Self::evm`].
    ///
    /// `Ok(None)` is "no such channel this connector can be paid on"; `Err`
    /// is "the lookup failed, so the answer is unknown". Both refuse the
    /// claim; they are kept apart so the refusal can say which.
    pub(crate) async fn solana(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<[u8; 32]>, ChannelLookupFailed> {
        if let Some(counterparty) = self.solana.get(channel_account) {
            return Ok(Some(*counterparty));
        }
        // Scoped so the read guard is released before the `.await` below --
        // see `Self::evm`'s own comment on the same shape.
        {
            let resolved = self
                .resolved_solana
                .read()
                .expect("resolved client channels lock poisoned");
            if let Some(counterparty) = resolved.get(channel_account) {
                return Ok(Some(*counterparty));
            }
        }
        let Some(source) = self.sources.get(&ClaimChain::Solana) else {
            return Ok(None);
        };
        let Some(counterparty) = source.solana_channel(channel_account).await? else {
            // Deliberately not memoised -- see `Self::evm`'s own comment.
            return Ok(None);
        };
        self.resolved_solana
            .write()
            .expect("resolved client channels lock poisoned")
            .insert(*channel_account, counterparty);
        Ok(Some(counterparty))
    }
}

/// Decode a `0x`-prefixed (or bare) hex string into exactly `N` bytes, or
/// `None` for anything malformed or the wrong length -- never a panic, same
/// as every other step of the claim gate (issue #506's "refused as a
/// validation failure, never as a crash").
pub(crate) fn decode_hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()?
        .try_into()
        .ok()
}

/// Decode a base58 string into exactly `N` bytes, or `None` for anything
/// malformed or the wrong length.
pub(crate) fn decode_base58_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    bs58::decode(s).into_vec().ok()?.try_into().ok()
}

#[cfg(test)]
pub(crate) mod test_source {
    //! A stand-in for a chain, shared with [`crate::claim_gate`]'s own
    //! tests: answers for exactly the channels it was handed, counts how
    //! often it was asked, and can be made to fail the way an unreachable
    //! RPC endpoint does.

    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Debug)]
    pub(crate) struct FakeChannelSource {
        channels: HashMap<[u8; 32], EvmChannel>,
        failure: Option<String>,
        lookups: AtomicUsize,
    }

    impl FakeChannelSource {
        pub(crate) fn knowing(channels: Vec<([u8; 32], EvmChannel)>) -> FakeChannelSource {
            FakeChannelSource {
                channels: channels.into_iter().collect(),
                failure: None,
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn unreachable(reason: &str) -> FakeChannelSource {
            FakeChannelSource {
                channels: HashMap::new(),
                failure: Some(reason.to_string()),
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn lookups(&self) -> usize {
            self.lookups.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ClientChannelSource for FakeChannelSource {
        async fn evm_channel(
            &self,
            channel_id: &[u8; 32],
        ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            if let Some(reason) = &self.failure {
                return Err(ChannelLookupFailed(reason.clone()));
            }
            Ok(self.channels.get(channel_id).copied())
        }
    }

    /// The Solana twin of [`FakeChannelSource`] (issue #631): a stand-in
    /// for `connector-cli`'s adapter over `SolanaSettlementBackend`, kept a
    /// separate type rather than a second field on [`FakeChannelSource`] so
    /// an EVM-only test's `lookups()` count can never be perturbed by a
    /// Solana lookup or vice versa.
    #[derive(Debug)]
    pub(crate) struct FakeSolanaChannelSource {
        channels: HashMap<[u8; 32], [u8; 32]>,
        failure: Option<String>,
        lookups: AtomicUsize,
    }

    impl FakeSolanaChannelSource {
        pub(crate) fn knowing(channels: Vec<([u8; 32], [u8; 32])>) -> FakeSolanaChannelSource {
            FakeSolanaChannelSource {
                channels: channels.into_iter().collect(),
                failure: None,
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn unreachable(reason: &str) -> FakeSolanaChannelSource {
            FakeSolanaChannelSource {
                channels: HashMap::new(),
                failure: Some(reason.to_string()),
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn lookups(&self) -> usize {
            self.lookups.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ClientChannelSource for FakeSolanaChannelSource {
        async fn solana_channel(
            &self,
            channel_account: &[u8; 32],
        ) -> Result<Option<[u8; 32]>, ChannelLookupFailed> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            if let Some(reason) = &self.failure {
                return Err(ChannelLookupFailed(reason.clone()));
            }
            Ok(self.channels.get(channel_account).copied())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_source::FakeChannelSource;
    use super::*;

    fn evm_channel() -> EvmChannel {
        EvmChannel {
            counterparty: [0x11; 20],
            chain_id: 8453,
            token_network_address: [0x42; 20],
        }
    }

    #[tokio::test]
    async fn a_recorded_evm_channel_is_found_under_the_id_it_was_recorded_by() {
        let mut registry = ClientChannelRegistry::new();
        let channel_id = format!("0x{}", "ab".repeat(32));
        registry
            .record_evm(&channel_id, evm_channel())
            .expect("a 32-byte hex channel id");

        let key = decode_hex_bytes::<32>(&channel_id).unwrap();
        assert_eq!(registry.evm(&key).await, Ok(Some(evm_channel())));
    }

    #[tokio::test]
    async fn the_0x_prefix_is_not_part_of_a_channels_identity() {
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(&"ab".repeat(32), evm_channel())
            .expect("a bare 32-byte hex channel id");

        // A claim naming the same channel with the `0x` prefix names the
        // same channel -- the prefix is notation, not identity.
        let key = decode_hex_bytes::<32>(&format!("0x{}", "ab".repeat(32))).unwrap();
        assert_eq!(registry.evm(&key).await, Ok(Some(evm_channel())));
    }

    #[test]
    fn an_id_that_is_not_a_32_byte_channel_is_refused_never_coerced() {
        let mut registry = ClientChannelRegistry::new();
        assert_eq!(
            registry.record_evm("0xdeadbeef", evm_channel()),
            Err(InvalidChannelIdentifier("0xdeadbeef".to_string()))
        );
        assert!(
            registry.is_empty(),
            "nothing was recorded under a coerced id"
        );
    }

    /// Issue #629: the source is stored under the claim's chain
    /// ([`ClaimChain::Evm`]) rather than as a single untyped slot a lookup
    /// for any chain could fall into. An EVM source registered via
    /// `with_source` must never answer a Solana lookup for the very same 32
    /// bytes -- the regression a chain-agnostic "one source" field would
    /// silently permit once a Solana entry is added alongside it.
    #[tokio::test]
    async fn an_evm_source_never_answers_a_solana_lookup_for_the_same_bytes() {
        let source = Arc::new(FakeChannelSource::knowing(vec![(
            [0x09; 32],
            evm_channel(),
        )]));
        let registry = ClientChannelRegistry::new().with_source(source);

        assert_eq!(registry.evm(&[0x09; 32]).await, Ok(Some(evm_channel())));
        assert_eq!(registry.solana(&[0x09; 32]).await, Ok(None));
    }

    #[tokio::test]
    async fn a_recorded_solana_channel_is_found_under_the_account_it_was_recorded_by() {
        let mut registry = ClientChannelRegistry::new();
        let account = bs58::encode([3u8; 32]).into_string();
        let counterparty = bs58::encode([7u8; 32]).into_string();
        registry
            .record_solana(&account, &counterparty)
            .expect("a 32-byte base58 account");

        assert_eq!(registry.solana(&[3u8; 32]).await, Ok(Some([7u8; 32])));
    }

    #[tokio::test]
    async fn evm_and_solana_channels_are_separate_namespaces() {
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(&"03".repeat(32), evm_channel())
            .expect("a 32-byte hex channel id");

        // The same 32 bytes, presented as a Solana account, is not that
        // channel: an EVM record can never answer for a Solana claim.
        assert_eq!(registry.solana(&[3u8; 32]).await, Ok(None));
    }

    #[test]
    fn a_fresh_registry_has_a_record_of_no_channel() {
        assert!(ClientChannelRegistry::new().is_empty());
    }

    /// Issues #556/#502: a channel nothing declared, that the chain knows
    /// about, is answered for. This is the whole point of the source --
    /// without it an unaffiliated buyer cannot pay until an operator edits
    /// a config file and restarts the node.
    #[tokio::test]
    async fn a_channel_only_the_source_knows_about_is_resolved() {
        let registry = ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::knowing(vec![([0x07; 32], evm_channel())]),
        ));

        assert_eq!(registry.evm(&[0x07; 32]).await, Ok(Some(evm_channel())));
    }

    /// The cache: a second claim on the same channel costs no second
    /// lookup, which is what keeps the packet path off the RPC endpoint.
    #[tokio::test]
    async fn a_resolved_channel_is_answered_from_memory_the_second_time() {
        let source = Arc::new(FakeChannelSource::knowing(vec![(
            [0x07; 32],
            evm_channel(),
        )]));
        let registry = ClientChannelRegistry::new().with_source(source.clone());

        for _ in 0..5 {
            assert_eq!(registry.evm(&[0x07; 32]).await, Ok(Some(evm_channel())));
        }
        assert_eq!(
            source.lookups(),
            1,
            "the chain is asked once per channel, not once per packet"
        );
    }

    /// A declared channel is authoritative: the source is never consulted
    /// for it, so a node whose config names its channels keeps accepting
    /// their claims while the RPC endpoint is down.
    #[tokio::test]
    async fn a_declared_channel_is_never_looked_up() {
        let source = Arc::new(FakeChannelSource::unreachable("connection refused"));
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(&"07".repeat(32), evm_channel())
            .expect("a 32-byte hex channel id");
        let registry = registry.with_source(source.clone());

        assert_eq!(registry.evm(&[0x07; 32]).await, Ok(Some(evm_channel())));
        assert_eq!(source.lookups(), 0);
    }

    /// A channel the source does not know about is absent, not a failure
    /// -- and "absent" is not memoised, so a buyer who opens their channel
    /// a moment later is not locked out by a stale negative.
    #[tokio::test]
    async fn an_unknown_channel_is_absent_rather_than_a_failure_and_is_not_cached() {
        let source = Arc::new(FakeChannelSource::knowing(vec![]));
        let registry = ClientChannelRegistry::new().with_source(source.clone());

        assert_eq!(registry.evm(&[0x07; 32]).await, Ok(None));
        assert_eq!(registry.evm(&[0x07; 32]).await, Ok(None));
        assert_eq!(
            source.lookups(),
            2,
            "a channel that did not exist yet is asked about again"
        );
    }

    /// A lookup this connector could not complete is a failure of its own,
    /// never silently "no such channel" and never a reason to believe what
    /// the claim says about itself.
    #[tokio::test]
    async fn a_lookup_failure_is_reported_as_a_failure() {
        let registry = ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::unreachable("connection refused"),
        ));

        assert_eq!(
            registry.evm(&[0x07; 32]).await,
            Err(ChannelLookupFailed("connection refused".to_string()))
        );
    }

    /// A registry with a source can vouch for channels it was never told
    /// about, so it is not "empty" in the sense the gate cares about.
    #[test]
    fn a_registry_with_a_source_is_not_empty() {
        let registry =
            ClientChannelRegistry::new().with_source(Arc::new(FakeChannelSource::knowing(vec![])));
        assert!(!registry.is_empty());
    }

    /// Issue #631: the Solana twin of
    /// `a_channel_only_the_source_knows_about_is_resolved` above -- a
    /// Solana channel nothing declared, that the chain knows about, is
    /// answered for through a registered [`ClaimChain::Solana`] source.
    #[tokio::test]
    async fn a_solana_channel_only_the_source_knows_about_is_resolved() {
        let registry = ClientChannelRegistry::new().with_solana_source(Arc::new(
            super::test_source::FakeSolanaChannelSource::knowing(vec![([0x07; 32], [0x09; 32])]),
        ));

        assert_eq!(registry.solana(&[0x07; 32]).await, Ok(Some([0x09; 32])));
    }

    /// The Solana twin of `a_resolved_channel_is_answered_from_memory_the_second_time`:
    /// a second claim on the same Solana channel costs no second lookup.
    #[tokio::test]
    async fn a_resolved_solana_channel_is_answered_from_memory_the_second_time() {
        let source = Arc::new(super::test_source::FakeSolanaChannelSource::knowing(vec![
            ([0x07; 32], [0x09; 32]),
        ]));
        let registry = ClientChannelRegistry::new().with_solana_source(source.clone());

        for _ in 0..5 {
            assert_eq!(registry.solana(&[0x07; 32]).await, Ok(Some([0x09; 32])));
        }
        assert_eq!(
            source.lookups(),
            1,
            "the chain is asked once per channel, not once per packet"
        );
    }

    /// A declared Solana channel is authoritative: the source is never
    /// consulted for it, so a node whose config names its channels keeps
    /// accepting their claims while the RPC endpoint is down (the Solana
    /// twin of `a_declared_channel_is_never_looked_up`).
    #[tokio::test]
    async fn a_declared_solana_channel_is_never_looked_up() {
        let source = Arc::new(super::test_source::FakeSolanaChannelSource::unreachable(
            "connection refused",
        ));
        let account = bs58::encode([7u8; 32]).into_string();
        let counterparty = bs58::encode([9u8; 32]).into_string();
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_solana(&account, &counterparty)
            .expect("a 32-byte base58 account");
        let registry = registry.with_solana_source(source.clone());

        assert_eq!(registry.solana(&[7u8; 32]).await, Ok(Some([9u8; 32])));
        assert_eq!(source.lookups(), 0);
    }

    /// A lookup failure on the Solana source is reported as a failure, not
    /// silently absorbed into "no such channel" (the Solana twin of
    /// `a_lookup_failure_is_reported_as_a_failure`).
    #[tokio::test]
    async fn a_solana_lookup_failure_is_reported_as_a_failure() {
        let registry = ClientChannelRegistry::new().with_solana_source(Arc::new(
            super::test_source::FakeSolanaChannelSource::unreachable("connection refused"),
        ));

        assert_eq!(
            registry.solana(&[0x07; 32]).await,
            Err(ChannelLookupFailed("connection refused".to_string()))
        );
    }

    /// A Solana source registered under `ClaimChain::Solana` must never
    /// answer an EVM lookup for the same bytes -- the Solana-first twin of
    /// `an_evm_source_never_answers_a_solana_lookup_for_the_same_bytes`.
    #[tokio::test]
    async fn a_solana_source_never_answers_an_evm_lookup_for_the_same_bytes() {
        let source = Arc::new(super::test_source::FakeSolanaChannelSource::knowing(vec![
            ([0x09; 32], [0x11; 32]),
        ]));
        let registry = ClientChannelRegistry::new().with_solana_source(source);

        assert_eq!(registry.solana(&[0x09; 32]).await, Ok(Some([0x11; 32])));
        assert_eq!(registry.evm(&[0x09; 32]).await, Ok(None));
    }
}
