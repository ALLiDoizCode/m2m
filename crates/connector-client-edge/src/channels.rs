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
//! # What a resolution reports, and what a claim may spend against
//!
//! A record is not only "whose signature", it is also **how much that
//! signature can be good for** (issue #646). A resolved channel carries
//! the counterparty's on-chain deposit as a [`DepositFloor`], and the claim
//! gate refuses a claim whose cumulative amount exceeds it. That is not a
//! credit policy this connector invents: both settlement contracts already
//! refuse an over-deposit claim at redemption
//! (`TokenNetwork.sol`'s `InsufficientChannelBalance`,
//! `packages/solana-program/src/processor.rs`'s
//! `TransferredAmountExceedsDeposit`), so a claim above the deposit is not
//! value at risk -- it is work this connector could never be paid for, and
//! accepting it is giving the app away. Evaluating it here makes the
//! accept rule agree with the redeem rule.
//!
//! A **declared** channel has no deposit to report: `[[client_channels]]`
//! names a counterparty and a domain and never an amount, and a node with
//! no settlement backend has no chain to ask. Its floor is
//! [`DepositFloor::Unknown`], which covers everything -- the deliberate
//! exemption of issue #646, and the ADR 0006 split done properly: an
//! operator hand-declaring a channel *is* the policy decision, correctly
//! located in config and theirs to make. An anonymous buyer resolved from
//! chain never made any such deal, and gets the mechanism.
//!
//! # Caching, and how it is refreshed
//!
//! A resolution happens on the packet path, so it must not become an RPC
//! round trip per packet. Every resolved channel is therefore memoised.
//! What is memoised divides into three kinds of fact, and the cache treats
//! each on its own terms:
//!
//! * **Immutable.** The participants and the EIP-712 domain.
//!   `TokenNetwork.openChannel`
//!   (`packages/contracts/src/TokenNetwork.sol:206-213`) assigns
//!   `participant1`/`participant2` once, when the channel is created, and
//!   no other function in that contract ever assigns either field again --
//!   `setTotalDeposit`, `claimFromChannel`, `closeChannel` and
//!   `settleChannel` mutate deposits, claimed amounts and `state` only. The
//!   EIP-712 domain is immutable for the same reason one layer up:
//!   OpenZeppelin's `EIP712("TokenNetwork", "1")` derives it from
//!   `block.chainid` and `address(this)`, and a deployed `TokenNetwork`'s
//!   address does not move. These need no invalidation at all.
//! * **Monotone.** The deposit. Its only writer on EVM is
//!   `setTotalDeposit`, which reverts on a decrease
//!   (`TokenNetwork.sol:238`); its only writer on Solana is the `Deposit`
//!   handler's `checked_add` (`processor.rs:382-388`). Neither chain has a
//!   withdraw-while-open. A cached deposit is therefore a permanent
//!   **lower bound**: it can only ever produce a false *refusal* (the payer
//!   topped up since it was read), never a false accept. So it is not
//!   re-read on the hot path at all -- only when a claim actually breaches
//!   it, via [`ClientChannelRegistry::refresh_evm`] /
//!   [`refresh_solana`](ClientChannelRegistry::refresh_solana), which
//!   raises the floor and lets the same claim through. Steady state (a
//!   client that funded once and is spending down) costs zero refreshes.
//! * **Mutable in both directions.** That the channel is not `Settled`, and
//!   that its mint is the one this node settles in. A memoised *positive*
//!   answer encodes both, and neither is immutable -- so this memo can
//!   still answer for a channel that has settled since it was read. That is
//!   issue #649, tracked separately and fixed on top of this refresh path.
//!
//! What is *not* memoised at all is any answer that could change to a
//! *better* one: a lookup failure, and a "no such channel". A buyer who
//! opens a channel and pays a second later has to be payable on their next
//! attempt rather than after a TTL, which is exactly the registration-free
//! path #502 asks for. The cost is that a sender naming channels that do
//! not exist can make this connector perform one `eth_call` each. Two
//! things bound it: a resolution is a single `TokenNetwork.channels(id)`
//! read plus the one `participants(id, counterparty)` read the deposit
//! needs, rather than the three-call `SettlementBackend::channel_state`
//! path, and the lookup is the claim gate's *last* stage, so a claim must
//! already be structurally valid, fresh and value-covering to reach it at
//! all (issue #544's ordering). Rate-limiting it is deliberately left out
//! of this change -- see the PR description.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use connector_signer::Address;

/// What a channel's counterparty has demonstrably put on chain, as far as
/// this connector knows: the ceiling a claim's cumulative amount may not
/// exceed (issue #646).
///
/// [`AtLeast`](DepositFloor::AtLeast) is a *lower bound*, not a reading:
/// deposits are monotonically non-decreasing while a channel is
/// `Opened`/`Closed` on both chains, so a value read at any point in the
/// past can only understate the deposit today. That is what makes it safe
/// to cache -- it can only cause a false refusal, never a false accept, and
/// a false refusal self-heals with one re-read (see
/// [`ClientChannelRegistry::refresh_evm`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepositFloor {
    /// No deposit is knowable for this channel: an operator-declared
    /// `[[client_channels]]` record names a counterparty and a domain and
    /// never an amount. Covers every claim -- the deliberate exemption
    /// described in this module's own doc.
    Unknown,
    /// The counterparty's on-chain deposit as of the last read, saturated
    /// into `u64` from whatever width the chain holds it in. Saturation is
    /// sound in the safe direction: a deposit above `u64::MAX` can never be
    /// exceeded by a `u64` cumulative amount anyway.
    AtLeast(u64),
}

impl DepositFloor {
    /// Whether a claim whose cumulative transferred amount is `amount`
    /// could be redeemed against this floor -- `amount <= deposit`, the
    /// same comparison `TokenNetwork.claimFromChannel` and
    /// `packages/solana-program`'s `Claim` handler make on redemption.
    pub fn covers(&self, amount: u64) -> bool {
        match self {
            DepositFloor::Unknown => true,
            DepositFloor::AtLeast(deposit) => amount <= *deposit,
        }
    }

    /// The floor as a number, for a refusal that has to say what the
    /// channel actually holds. `None` for [`DepositFloor::Unknown`], which
    /// never refuses anything.
    pub fn deposit(&self) -> Option<u64> {
        match self {
            DepositFloor::Unknown => None,
            DepositFloor::AtLeast(deposit) => Some(*deposit),
        }
    }
}

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
    /// `channel_account`, and their on-chain deposit, or `Ok(None)`/`Err`
    /// under exactly the same rules. There is no domain to report alongside
    /// it -- a Solana balance proof is signed over the channel account,
    /// nonce and amount alone
    /// (`connector_signer::solana_balance_proof_message`), with no
    /// EIP-712-style verifying-contract concept to carry. The mint is not
    /// in the signed bytes either: binding a channel to the mint this node
    /// settles in is the resolving backend's job (a chain-resolved channel
    /// on any other mint must come back `Ok(None)`), not the signature's.
    async fn solana_channel(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
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
    /// What that counterparty has actually deposited on chain, and
    /// therefore the most a claim on this channel can ever redeem for
    /// (issue #646). [`DepositFloor::Unknown`] for a declared channel --
    /// see this module's own doc for why that exemption is deliberate.
    pub deposit_floor: DepositFloor,
}

/// The Solana twin of [`EvmChannel`]: who this connector accepts a claim's
/// signature from on one Solana channel, and how much that signature can be
/// good for. A separate type rather than a bare `[u8; 32]` counterparty
/// (which is all this was before issue #646) so that the deposit travels
/// with the counterparty through the same seam on both chains, instead of
/// being parsed out of the chain's own bytes and then thrown away.
///
/// There is no signing-domain field: a Solana balance proof is signed over
/// the channel account, nonce and amount alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolanaChannel {
    /// The raw Ed25519 public key whose signature this connector accepts on
    /// a claim for this channel -- never the claim's own
    /// `signerPublicKey`.
    pub counterparty: [u8; 32],
    /// See [`EvmChannel::deposit_floor`].
    pub deposit_floor: DepositFloor,
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
    solana: HashMap<[u8; 32], SolanaChannel>,
    /// Consulted only for a channel nothing was declared for, keyed by
    /// [`ClaimChain`] so each chain's source answers for that chain alone --
    /// never, say, an EVM source consulted for a Solana lookup. Empty is a
    /// node with no settlement backend: it accepts claims on exactly what
    /// its config file declares, and on nothing else.
    sources: HashMap<ClaimChain, Arc<dyn ClientChannelSource>>,
    /// Memoised answers from [`Self::sources`] -- see this module's doc for
    /// which of the facts in one of these entries can go stale.
    resolved: RwLock<HashMap<[u8; 32], EvmChannel>>,
    /// The Solana twin of [`Self::resolved`] (issue #631) -- a separate map
    /// since a resolved Solana answer is a [`SolanaChannel`], not an
    /// [`EvmChannel`].
    resolved_solana: RwLock<HashMap<[u8; 32], SolanaChannel>>,
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
        self.solana.insert(
            key,
            SolanaChannel {
                counterparty,
                // Config declares a counterparty, never an amount -- see
                // this module's doc on the declared-channel exemption.
                deposit_floor: DepositFloor::Unknown,
            },
        );
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
        self.resolve_evm(channel_id).await
    }

    /// Ask the chain about `channel_id` again, whatever is memoised for it
    /// (issues #646, #649), and answer from that fresh reading.
    ///
    /// The claim gate calls this when a claim **breaches** the memoised
    /// deposit floor: the floor is a lower bound, so a breach is not yet a
    /// refusal, it is a reason to look again -- and a counterparty who
    /// topped up gets their claim honoured on the same submission rather
    /// than after a restart.
    ///
    /// A declared channel has nothing to refresh: config, not the chain, is
    /// its authority, and it is answered from config exactly as
    /// [`Self::evm`] would.
    pub(crate) async fn refresh_evm(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        if let Some(channel) = self.evm.get(channel_id) {
            return Ok(Some(*channel));
        }
        self.resolve_evm(channel_id).await
    }

    /// The one place [`Self::sources`]'s EVM entry is consulted, and the
    /// one place [`Self::resolved`] is written.
    async fn resolve_evm(
        &self,
        channel_id: &[u8; 32],
    ) -> Result<Option<EvmChannel>, ChannelLookupFailed> {
        let Some(source) = self.sources.get(&ClaimChain::Evm) else {
            return Ok(None);
        };
        // A failed lookup says nothing about the channel, so it must not be
        // allowed to say anything about the memo either: whatever was
        // cached stays cached, and the claim that provoked this is refused
        // as a lookup failure.
        let resolved = source.evm_channel(channel_id).await?;
        let mut memo = self
            .resolved
            .write()
            .expect("resolved client channels lock poisoned");
        match resolved {
            Some(channel) => {
                memo.insert(*channel_id, channel);
                Ok(Some(channel))
            }
            None => {
                // Deliberately not memoised: a channel opened a second
                // from now must be payable on that sender's next attempt.
                Ok(None)
            }
        }
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
    ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
        if let Some(channel) = self.solana.get(channel_account) {
            return Ok(Some(*channel));
        }
        // Scoped so the read guard is released before the `.await` below --
        // see `Self::evm`'s own comment on the same shape.
        {
            let resolved = self
                .resolved_solana
                .read()
                .expect("resolved client channels lock poisoned");
            if let Some(channel) = resolved.get(channel_account) {
                return Ok(Some(*channel));
            }
        }
        self.resolve_solana(channel_account).await
    }

    /// The Solana twin of [`Self::refresh_evm`] (issues #646, #649), with
    /// the same two callers and the same rules.
    pub(crate) async fn refresh_solana(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
        if let Some(channel) = self.solana.get(channel_account) {
            return Ok(Some(*channel));
        }
        self.resolve_solana(channel_account).await
    }

    /// The Solana twin of [`Self::resolve_evm`].
    async fn resolve_solana(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
        let Some(source) = self.sources.get(&ClaimChain::Solana) else {
            return Ok(None);
        };
        let resolved = source.solana_channel(channel_account).await?;
        let mut memo = self
            .resolved_solana
            .write()
            .expect("resolved client channels lock poisoned");
        match resolved {
            Some(channel) => {
                memo.insert(*channel_account, channel);
                Ok(Some(channel))
            }
            None => Ok(None),
        }
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
    use std::sync::Mutex;

    #[derive(Debug)]
    pub(crate) struct FakeChannelSource {
        /// Behind a lock so a test can play the part of a chain that
        /// *changed* -- a counterparty topping up their deposit (issue
        /// #646) -- which is the whole subject of the refresh path and
        /// cannot be expressed by a source fixed at construction.
        channels: Mutex<HashMap<[u8; 32], EvmChannel>>,
        failure: Option<String>,
        lookups: AtomicUsize,
    }

    impl FakeChannelSource {
        pub(crate) fn knowing(channels: Vec<([u8; 32], EvmChannel)>) -> FakeChannelSource {
            FakeChannelSource {
                channels: Mutex::new(channels.into_iter().collect()),
                failure: None,
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn unreachable(reason: &str) -> FakeChannelSource {
            FakeChannelSource {
                channels: Mutex::new(HashMap::new()),
                failure: Some(reason.to_string()),
                lookups: AtomicUsize::new(0),
            }
        }

        /// What the chain says about `channel_id` from now on: `Some` for a
        /// channel that is (still) payable, `None` for one that has
        /// settled, changed mint or otherwise stopped being one this
        /// connector can be paid on.
        pub(crate) fn now_says(&self, channel_id: [u8; 32], channel: Option<EvmChannel>) {
            let mut channels = self.channels.lock().expect("fake source lock poisoned");
            match channel {
                Some(channel) => channels.insert(channel_id, channel),
                None => channels.remove(&channel_id),
            };
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
            Ok(self
                .channels
                .lock()
                .expect("fake source lock poisoned")
                .get(channel_id)
                .copied())
        }
    }

    /// The Solana twin of [`FakeChannelSource`] (issue #631): a stand-in
    /// for `connector-cli`'s adapter over `SolanaSettlementBackend`, kept a
    /// separate type rather than a second field on [`FakeChannelSource`] so
    /// an EVM-only test's `lookups()` count can never be perturbed by a
    /// Solana lookup or vice versa.
    #[derive(Debug)]
    pub(crate) struct FakeSolanaChannelSource {
        /// Behind a lock for the same reason [`FakeChannelSource`]'s is.
        channels: Mutex<HashMap<[u8; 32], SolanaChannel>>,
        failure: Option<String>,
        lookups: AtomicUsize,
    }

    impl FakeSolanaChannelSource {
        pub(crate) fn knowing(channels: Vec<([u8; 32], SolanaChannel)>) -> FakeSolanaChannelSource {
            FakeSolanaChannelSource {
                channels: Mutex::new(channels.into_iter().collect()),
                failure: None,
                lookups: AtomicUsize::new(0),
            }
        }

        pub(crate) fn unreachable(reason: &str) -> FakeSolanaChannelSource {
            FakeSolanaChannelSource {
                channels: Mutex::new(HashMap::new()),
                failure: Some(reason.to_string()),
                lookups: AtomicUsize::new(0),
            }
        }

        /// The Solana twin of [`FakeChannelSource::now_says`].
        pub(crate) fn now_says(&self, account: [u8; 32], channel: Option<SolanaChannel>) {
            let mut channels = self.channels.lock().expect("fake source lock poisoned");
            match channel {
                Some(channel) => channels.insert(account, channel),
                None => channels.remove(&account),
            };
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
        ) -> Result<Option<SolanaChannel>, ChannelLookupFailed> {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            if let Some(reason) = &self.failure {
                return Err(ChannelLookupFailed(reason.clone()));
            }
            Ok(self
                .channels
                .lock()
                .expect("fake source lock poisoned")
                .get(channel_account)
                .copied())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_source::FakeChannelSource;
    use super::*;

    fn evm_channel() -> EvmChannel {
        evm_channel_depositing(DepositFloor::AtLeast(1_000))
    }

    fn evm_channel_depositing(deposit_floor: DepositFloor) -> EvmChannel {
        EvmChannel {
            counterparty: [0x11; 20],
            chain_id: 8453,
            token_network_address: [0x42; 20],
            deposit_floor,
        }
    }

    fn solana_channel() -> SolanaChannel {
        SolanaChannel {
            counterparty: [0x09; 32],
            deposit_floor: DepositFloor::AtLeast(1_000),
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

        assert_eq!(
            registry.solana(&[3u8; 32]).await,
            Ok(Some(SolanaChannel {
                counterparty: [7u8; 32],
                deposit_floor: DepositFloor::Unknown,
            }))
        );
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
            super::test_source::FakeSolanaChannelSource::knowing(vec![(
                [0x07; 32],
                solana_channel(),
            )]),
        ));

        assert_eq!(
            registry.solana(&[0x07; 32]).await,
            Ok(Some(solana_channel()))
        );
    }

    /// The Solana twin of `a_resolved_channel_is_answered_from_memory_the_second_time`:
    /// a second claim on the same Solana channel costs no second lookup.
    #[tokio::test]
    async fn a_resolved_solana_channel_is_answered_from_memory_the_second_time() {
        let source = Arc::new(super::test_source::FakeSolanaChannelSource::knowing(vec![
            ([0x07; 32], solana_channel()),
        ]));
        let registry = ClientChannelRegistry::new().with_solana_source(source.clone());

        for _ in 0..5 {
            assert_eq!(
                registry.solana(&[0x07; 32]).await,
                Ok(Some(solana_channel()))
            );
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

        assert_eq!(
            registry.solana(&[7u8; 32]).await,
            Ok(Some(SolanaChannel {
                counterparty: [9u8; 32],
                deposit_floor: DepositFloor::Unknown,
            }))
        );
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
            ([0x09; 32], solana_channel()),
        ]));
        let registry = ClientChannelRegistry::new().with_solana_source(source);

        assert_eq!(
            registry.solana(&[0x09; 32]).await,
            Ok(Some(solana_channel()))
        );
        assert_eq!(registry.evm(&[0x09; 32]).await, Ok(None));
    }

    // -- The deposit floor and its refresh (issues #646, #649) --

    /// A declared channel reports no deposit at all: config names a
    /// counterparty and a domain and never an amount, so the collateral cap
    /// has nothing to bind against and deliberately does not (issue #646).
    #[tokio::test]
    async fn a_declared_channel_has_no_knowable_deposit() {
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(
                &"ab".repeat(32),
                evm_channel_depositing(DepositFloor::Unknown),
            )
            .expect("a 32-byte hex channel id");
        registry
            .record_solana(
                &bs58::encode([3u8; 32]).into_string(),
                &bs58::encode([7u8; 32]).into_string(),
            )
            .expect("a 32-byte base58 account");

        let evm = registry.evm(&[0xab; 32]).await.unwrap().unwrap();
        assert_eq!(evm.deposit_floor, DepositFloor::Unknown);
        assert!(evm.deposit_floor.covers(u64::MAX));

        let solana = registry.solana(&[3u8; 32]).await.unwrap().unwrap();
        assert_eq!(solana.deposit_floor, DepositFloor::Unknown);
    }

    /// The performance claim of issue #646, as a test rather than a
    /// paragraph: the deposit rides along with the resolution, so a channel
    /// whose claims all fit under the memoised floor never asks the chain
    /// again -- the steady state of a client that funded once and is
    /// spending down.
    #[tokio::test]
    async fn a_memoised_deposit_floor_costs_no_further_lookups() {
        let source = Arc::new(FakeChannelSource::knowing(vec![(
            [0x07; 32],
            evm_channel_depositing(DepositFloor::AtLeast(1_000)),
        )]));
        let registry = ClientChannelRegistry::new().with_source(source.clone());

        for _ in 0..5 {
            let channel = registry.evm(&[0x07; 32]).await.unwrap().unwrap();
            assert_eq!(channel.deposit_floor, DepositFloor::AtLeast(1_000));
        }
        assert_eq!(source.lookups(), 1);
    }

    /// The floor is a lower bound, not a reading: a counterparty who
    /// deposits more moves it, and one refresh -- exactly one -- is what
    /// finds that out.
    #[tokio::test]
    async fn a_refresh_raises_the_floor_to_what_the_chain_now_says() {
        let source = Arc::new(FakeChannelSource::knowing(vec![(
            [0x07; 32],
            evm_channel_depositing(DepositFloor::AtLeast(1_000)),
        )]));
        let registry = ClientChannelRegistry::new().with_source(source.clone());

        assert_eq!(
            registry
                .evm(&[0x07; 32])
                .await
                .unwrap()
                .unwrap()
                .deposit_floor,
            DepositFloor::AtLeast(1_000)
        );
        source.now_says(
            [0x07; 32],
            Some(evm_channel_depositing(DepositFloor::AtLeast(5_000))),
        );

        // Still the memoised floor: nothing has breached it, so nothing
        // re-reads.
        assert_eq!(
            registry
                .evm(&[0x07; 32])
                .await
                .unwrap()
                .unwrap()
                .deposit_floor,
            DepositFloor::AtLeast(1_000)
        );
        assert_eq!(source.lookups(), 1);

        assert_eq!(
            registry
                .refresh_evm(&[0x07; 32])
                .await
                .unwrap()
                .unwrap()
                .deposit_floor,
            DepositFloor::AtLeast(5_000)
        );
        assert_eq!(source.lookups(), 2, "exactly one re-read");

        // And the raised floor is what the next lookup answers from --
        // a refresh writes through the memo rather than around it.
        assert_eq!(
            registry
                .evm(&[0x07; 32])
                .await
                .unwrap()
                .unwrap()
                .deposit_floor,
            DepositFloor::AtLeast(5_000)
        );
        assert_eq!(source.lookups(), 2);
    }

    /// A declared channel has nothing to refresh: config is its authority,
    /// and a refresh must not turn into the chain lookup #556 promised
    /// declared channels would never need.
    #[tokio::test]
    async fn refreshing_a_declared_channel_consults_no_chain() {
        let source = Arc::new(FakeChannelSource::unreachable("connection refused"));
        let mut registry = ClientChannelRegistry::new();
        registry
            .record_evm(
                &"07".repeat(32),
                evm_channel_depositing(DepositFloor::Unknown),
            )
            .expect("a 32-byte hex channel id");
        let registry = registry.with_source(source.clone());

        assert_eq!(
            registry
                .refresh_evm(&[0x07; 32])
                .await
                .unwrap()
                .unwrap()
                .deposit_floor,
            DepositFloor::Unknown
        );
        assert_eq!(source.lookups(), 0);
    }

    /// A refresh whose lookup fails says nothing about the channel, so it
    /// must not evict what was memoised: the claim that provoked it is
    /// refused as a lookup failure, and a node whose RPC endpoint blips
    /// does not lose every channel it had resolved.
    #[tokio::test]
    async fn a_failed_refresh_leaves_the_memo_alone() {
        let source = Arc::new(FakeChannelSource::unreachable("connection refused"));
        let registry = ClientChannelRegistry::new().with_source(source.clone());
        // Seed the memo by hand: this fake fails every lookup, which is
        // exactly the point -- the entry must survive one.
        registry
            .resolved
            .write()
            .unwrap()
            .insert([0x07; 32], evm_channel());

        assert_eq!(
            registry.refresh_evm(&[0x07; 32]).await,
            Err(ChannelLookupFailed("connection refused".to_string()))
        );
        assert_eq!(registry.evm(&[0x07; 32]).await, Ok(Some(evm_channel())));
    }
}
