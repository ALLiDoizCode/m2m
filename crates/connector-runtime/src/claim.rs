//! Per-peering-relation claim exchange (ADR 0004, ADR 0005, ADR 0024,
//! `docs/protocol/peer-wire-spec.md` §3, issue #423): signing and tracking
//! the claim this connector owes a peer on fulfilment, and verifying and
//! watermarking a claim a peer sends back. The nonce/watermark rule itself
//! lives in `connector_domain::validate_claim`; this module is the
//! in-memory bookkeeping and wire shape around it, plus the chain-specific
//! digest a claim's signature actually covers (issue #575:
//! `connector_signer::evm_balance_proof_digest`, the same EIP-712
//! `BalanceProof` digest `packages/contracts/src/TokenNetwork.sol` verifies
//! on redemption -- not a connector-internal SHA-256 tuple nothing on chain
//! ever checks). Durable persistence of this state (ADR 0005's journal) is
//! issue #424's job -- [`ClaimBook`] holds it only for the lifetime of the
//! process, exactly like `Connector`'s `leased_routes`.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Duration, Utc};

use connector_domain::{
    advance_watermark, validate_claim, ClaimError, JournalEntry, Projection, ProjectionDivergence,
    Watermark,
};
use connector_signer::{
    evm_balance_proof_digest, verify_evm_balance_proof, verify_solana_balance_proof, Address,
    EvmBalanceProof, Signature, Signer,
};
use thiserror::Error;

use crate::journal::{InMemoryJournal, Journal, JournalError};
use crate::operator_view::{ClaimView, ExposureView};

/// A claim as it travels the wire (peer-wire-spec.md §3.5): a channel
/// identifier, a nonce, a cumulative amount, and a signature. `channel_id`
/// is expected to already name the channel's on-chain `bytes32` (see
/// [`ClaimBook::set_channel_domain`]) -- this type itself carries it as an
/// opaque `String` (as it always has) so the wire encoding below is
/// unchanged; it is [`ClaimBook`] that refuses to sign or accept a claim
/// whose `channel_id` was never registered as one. Distinct from
/// `connector_settlement::Claim` -- that is the on-chain redemption claim
/// (issue #425); this is the per-peering-relation claim exchanged before
/// any redemption happens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireClaim {
    pub channel_id: String,
    pub nonce: u64,
    pub cumulative_amount: u64,
    pub signature: ClaimSignature,
}

const EVM_SIGNATURE_LEN: usize = 65; // r(32) + s(32) + recovery_id(1)
const SOLANA_SIGNATURE_LEN: usize = 64; // ed25519 R(32) + S(32)

/// The scheme discriminator [`WireClaim::encode`] writes ahead of a
/// signature. Present so the in-process binary form stays decodable now
/// that a signature has two lengths (issue #732); neither carriage puts
/// these bytes on a wire (`connector_peer_btp::claim_json`'s own module
/// doc), so no deployed peer ever parses them.
const EVM_SCHEME: u8 = 0;
const SOLANA_SCHEME: u8 = 1;

impl WireClaim {
    /// Length-prefixed `channel_id` (so no two distinct tuples can ever
    /// collide on the same byte string) followed by `nonce`,
    /// `cumulative_amount`, a signature-scheme byte and the raw signature
    /// -- the ad hoc encoding for fields RFC-0027 has no concept of. ADR
    /// 0027 re-hosts this same byte string as a `payment-channel-claim`
    /// BTP protocolData entry or a `Payment-Channel-Claim` HTTP header;
    /// only the carriage moves.
    pub fn encode(&self) -> Vec<u8> {
        let channel_id_bytes = self.channel_id.as_bytes();
        let mut out =
            Vec::with_capacity(2 + channel_id_bytes.len() + 8 + 8 + 1 + EVM_SIGNATURE_LEN);
        out.extend_from_slice(&(channel_id_bytes.len() as u16).to_be_bytes());
        out.extend_from_slice(channel_id_bytes);
        out.extend_from_slice(&self.nonce.to_be_bytes());
        out.extend_from_slice(&self.cumulative_amount.to_be_bytes());
        match &self.signature {
            ClaimSignature::Evm(signature) => {
                out.push(EVM_SCHEME);
                out.extend_from_slice(&signature.r);
                out.extend_from_slice(&signature.s);
                out.push(signature.recovery_id);
            }
            ClaimSignature::Solana(signature) => {
                out.push(SOLANA_SCHEME);
                out.extend_from_slice(signature);
            }
        }
        out
    }

    /// Decode one [`WireClaim`] from the front of `bytes`, returning it
    /// alongside how many bytes it consumed so a caller can decode
    /// whatever follows (a `WireClaim` never appears alone on the wire --
    /// it always rides a PREPARE or stands as the whole of a FLUSH).
    pub fn decode(bytes: &[u8]) -> Option<(WireClaim, usize)> {
        let channel_id_len = u16::from_be_bytes(bytes.get(0..2)?.try_into().ok()?) as usize;
        let mut offset = 2;
        let channel_id =
            String::from_utf8(bytes.get(offset..offset + channel_id_len)?.to_vec()).ok()?;
        offset += channel_id_len;
        let nonce = u64::from_be_bytes(bytes.get(offset..offset + 8)?.try_into().ok()?);
        offset += 8;
        let cumulative_amount = u64::from_be_bytes(bytes.get(offset..offset + 8)?.try_into().ok()?);
        offset += 8;
        let scheme = *bytes.get(offset)?;
        offset += 1;
        let signature = match scheme {
            EVM_SCHEME => {
                let raw: [u8; EVM_SIGNATURE_LEN] = bytes
                    .get(offset..offset + EVM_SIGNATURE_LEN)?
                    .try_into()
                    .ok()?;
                offset += EVM_SIGNATURE_LEN;
                ClaimSignature::Evm(Signature::from_bytes(&raw)?)
            }
            SOLANA_SCHEME => {
                let raw: [u8; SOLANA_SIGNATURE_LEN] = bytes
                    .get(offset..offset + SOLANA_SIGNATURE_LEN)?
                    .try_into()
                    .ok()?;
                offset += SOLANA_SIGNATURE_LEN;
                ClaimSignature::Solana(raw)
            }
            _ => return None,
        };
        Some((
            WireClaim {
                channel_id,
                nonce,
                cumulative_amount,
                signature,
            },
            offset,
        ))
    }
}

/// Why a claim was rejected (peer-wire-spec.md §3.4's CLAIM_ACK reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimRejectReason {
    SignatureInvalid,
    NonceNotAdvancing,
    AmountNotAdvancing,
    UnknownChannel,
}

impl ClaimRejectReason {
    fn to_wire(self) -> u8 {
        match self {
            ClaimRejectReason::SignatureInvalid => 0,
            ClaimRejectReason::NonceNotAdvancing => 1,
            ClaimRejectReason::AmountNotAdvancing => 2,
            ClaimRejectReason::UnknownChannel => 3,
        }
    }

    fn from_wire(byte: u8) -> Option<ClaimRejectReason> {
        match byte {
            0 => Some(ClaimRejectReason::SignatureInvalid),
            1 => Some(ClaimRejectReason::NonceNotAdvancing),
            2 => Some(ClaimRejectReason::AmountNotAdvancing),
            3 => Some(ClaimRejectReason::UnknownChannel),
            _ => None,
        }
    }
}

/// The outcome of sending a claim (peer-wire-spec.md §3.4): [`ClaimAckOutcome::NotSent`]
/// when no claim rode this frame at all, distinct from a claim that rode it
/// and was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimAckOutcome {
    NotSent,
    Accepted,
    Rejected(ClaimRejectReason),
}

impl ClaimAckOutcome {
    /// Encode the CLAIM_ACK answering a claim that was sent. Never called
    /// for [`ClaimAckOutcome::NotSent`] -- there is nothing to acknowledge,
    /// so no CLAIM_ACK frame is sent at all (the caller checks this first).
    pub fn encode(&self) -> Vec<u8> {
        match self {
            ClaimAckOutcome::Accepted => vec![0],
            ClaimAckOutcome::Rejected(reason) => vec![1, reason.to_wire()],
            ClaimAckOutcome::NotSent => vec![],
        }
    }

    pub fn decode(bytes: &[u8]) -> Option<ClaimAckOutcome> {
        match bytes.first()? {
            0 => Some(ClaimAckOutcome::Accepted),
            1 => Some(ClaimAckOutcome::Rejected(ClaimRejectReason::from_wire(
                *bytes.get(1)?,
            )?)),
            _ => None,
        }
    }
}

/// The on-chain `bytes32` identifying a channel -- what a claim's digest is
/// actually computed over, distinct from the `String` this book (and the
/// wire) otherwise knows a channel by. Parsed once, at
/// [`ClaimBook::set_channel_domain`] time (issue #575's AC4), never
/// re-derived from the `String` on every sign/verify.
pub(crate) type OnChainChannelId = [u8; 32];

/// The EIP-712 domain a channel's claims are signed and verified under
/// (`docs/protocol/peer-wire-spec.md` §3.5, ADR 0024, issue #575/#566): the
/// chain a channel is deployed on and the `TokenNetwork` contract that
/// verifies a claim's signature on redemption. Configured per channel
/// rather than assumed node-wide -- each token gets its own `TokenNetwork`
/// and therefore its own `verifyingContract` (issue #566), so there is no
/// single domain a node could default to, and deliberately not read from a
/// settlement backend (issue #575: "keeping the signing domain a
/// configured input is exactly what lets this child land ... without the
/// backend retarget").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelDomain {
    pub chain_id: u64,
    pub token_network_address: Address,
}

/// A Solana peer channel's binding (issue #732): the 32-byte channel
/// account whose raw bytes open the ed25519 balance-proof message
/// (`connector_signer::solana_balance_proof_message`), and the ed25519
/// public key whose signature this connector accepts on a claim naming it.
///
/// Deliberately **not** folded into [`ChannelDomain`]. A Solana claim's
/// signature covers a 48-byte little-endian message with no domain
/// separator, no `verifyingContract` and no chain id -- there is nothing an
/// EIP-712 domain and this have in common to abstract over, and merging
/// them would mean one of the two carrying fields the other's verifier
/// silently ignores. `connector_domain::client_claim::ClientClaim`
/// discriminates the same two chains the same way, and this is the peer
/// wire's counterpart to that decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolanaChannel {
    /// The raw 32 bytes the channel account's base58 id decodes to --
    /// parsed once, at [`ClaimBook::set_solana_channel`] time, exactly as
    /// [`ChannelDomain`]'s `OnChainChannelId` is.
    pub channel_account: [u8; 32],
    /// The counterparty's ed25519 public key, raw. Never a claim's own
    /// self-declared `signerPublicKey` -- see
    /// [`ClaimBook::set_verification_key`] for why the peer wire reads
    /// this from its own record.
    pub counterparty_public_key: [u8; 32],
}

/// A Solana channel account or counterparty key supplied to
/// [`ClaimBook::set_solana_channel`] that is not base58 of exactly 32
/// bytes. Refused where channels are configured rather than padded,
/// truncated or hashed into shape -- the same rule [`InvalidChannelId`]
/// enforces for the EVM side, and for the same reason: a channel account
/// that is not the account is a signature check against the wrong message.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{field} {value:?} is not base58 of exactly 32 bytes")]
pub struct InvalidSolanaChannel {
    pub field: &'static str,
    pub value: String,
}

/// Decode a base58 Solana account/key into its exact 32 bytes, or refuse.
pub(crate) fn parse_base58_32(
    field: &'static str,
    value: &str,
) -> Result<[u8; 32], InvalidSolanaChannel> {
    let refuse = || InvalidSolanaChannel {
        field,
        value: value.to_string(),
    };
    let decoded = bs58::decode(value).into_vec().map_err(|_| refuse())?;
    let bytes: [u8; 32] = decoded.try_into().map_err(|_| refuse())?;
    Ok(bytes)
}

/// A peer claim's signature, discriminated by the scheme its chain
/// actually uses (issue #732). The two are different lengths over
/// different messages verified by different primitives, and the peer wire
/// keeps them apart for the whole of their travel rather than flattening
/// both into one opaque byte string -- a 64-byte ed25519 signature stuffed
/// into a 65-byte `r ‖ s ‖ v` slot is a claim this connector could no
/// longer tell you how to check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimSignature {
    /// secp256k1 `r ‖ s ‖ v` over ADR 0024's EIP-712 `BalanceProof`
    /// digest.
    Evm(Signature),
    /// ed25519 over
    /// `connector_signer::solana_balance_proof_message`'s 48 bytes.
    Solana([u8; 64]),
}

impl ClaimSignature {
    /// The signature's own bytes, in the length its scheme defines -- 65
    /// for EVM, 64 for Solana. This is what a journal entry records and
    /// what a settlement backend is later handed; nothing pads one to the
    /// other's width.
    pub fn to_bytes(&self) -> Vec<u8> {
        match self {
            ClaimSignature::Evm(signature) => signature.to_bytes().to_vec(),
            ClaimSignature::Solana(signature) => signature.to_vec(),
        }
    }

    /// The EVM signature this carries, or `None` for a Solana one. Used by
    /// the paths that are EVM-only by construction (on-chain redemption
    /// through `connector_settlement::Claim`, whose `signature` field is
    /// `connector_signer::Signature`).
    pub fn as_evm(&self) -> Option<Signature> {
        match self {
            ClaimSignature::Evm(signature) => Some(*signature),
            ClaimSignature::Solana(_) => None,
        }
    }
}

impl From<Signature> for ClaimSignature {
    fn from(signature: Signature) -> ClaimSignature {
        ClaimSignature::Evm(signature)
    }
}

/// A channel id supplied to [`ClaimBook::set_channel_domain`] that is not
/// the on-chain `bytes32` a claim's EIP-712 digest must be computed over
/// (issue #575's AC: "an id that is not one is refused where channels are
/// configured, never hashed or truncated into one"). Accepted shapes are
/// `0x`-prefixed (or bare) 64-character hex -- `TokenNetwork.sol`'s own
/// `channelId`, and the shape `EvmSettlementBackend::open` itself returns
/// since issue #576's retarget -- and a plain decimal numeral, embedded as
/// the big-endian bytes of that same integer -- the shape this workspace's
/// own `InMemorySettlementBackend` still uses. Both are exact, lossless
/// encodings of the on-chain value the string already names -- neither
/// hashes nor truncates it; anything else is refused here rather than
/// defaulted.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error(
    "channel id {0:?} is not a 32-byte on-chain identifier (expected 0x-prefixed 64 hex characters or a decimal uint256)"
)]
pub struct InvalidChannelId(pub String);

pub(crate) fn parse_channel_id(channel_id: &str) -> Result<OnChainChannelId, InvalidChannelId> {
    let hex_digits = channel_id.strip_prefix("0x").unwrap_or(channel_id);
    if hex_digits.len() == 64 && hex_digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
                .expect("already validated as hex digits");
        }
        return Ok(out);
    }
    if !channel_id.is_empty() && channel_id.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(value) = channel_id.parse::<u128>() {
            let mut out = [0u8; 32];
            out[16..].copy_from_slice(&value.to_be_bytes());
            return Ok(out);
        }
    }
    Err(InvalidChannelId(channel_id.to_string()))
}

/// Build the [`EvmBalanceProof`] a peer-wire claim's digest is computed
/// over. `locked_amount`/`locks_root` are always zero (peer-wire-spec.md
/// §3.5, ADR 0004) but still hashed -- omitting them would compute a
/// different digest than `TokenNetwork.sol`'s own typehash produces
/// (`connector_signer::claim_signature`'s own doc comment). `nonce` and
/// `cumulative_amount` are `u64` on the wire but hashed at the full
/// `uint256` word width `evm_balance_proof_digest` expects, so a claim
/// signed here recovers under exactly the same digest a verifier -- on the
/// peer wire or on chain -- computes.
pub(crate) fn evm_proof(
    on_chain_id: OnChainChannelId,
    domain: ChannelDomain,
    nonce: u64,
    cumulative_amount: u64,
) -> EvmBalanceProof {
    EvmBalanceProof {
        channel_id: on_chain_id,
        nonce,
        transferred_amount: u128::from(cumulative_amount),
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: domain.chain_id,
        token_network_address: domain.token_network_address,
    }
}

/// One peer's outbound claim ledger: what this connector owes it, signed
/// here and piggybacked on the next frame out.
#[derive(Default)]
struct OutboundLedger {
    channel_id: String,
    pending: Option<WireClaim>,
    pending_since: Option<DateTime<Utc>>,
    nonce: u64,
    cumulative_amount: u64,
}

/// This connector's claim state across every peering relation (ADR 0004,
/// ADR 0005). Signing requires a [`Signer`]; a node with none configured
/// simply never emits a claim, matching how a node with no settlement
/// backend never gets a working channel surface (`Connector::settlement`).
///
/// Outbound state (what this connector owes a peer) is keyed by `peer_id`,
/// since that is what routing decides. Inbound state (a peer's watermark
/// on a channel) is keyed by the claim's own `channel_id` instead of by
/// peer id: there is no peer identity handshake yet. ADR 0027 makes peer
/// role a matter of authentication -- a configured credential plus a
/// `[[peer_channels]]` entry -- but that config surface is issue #677 and
/// the carriages that would present it are #676, so today's accepting side
/// does not know which configured peer reached it. A
/// claim already carries its own `channel_id`, so verification and the
/// watermark it advances need nothing else to identify which channel it is
/// -- only which address is trusted to sign for that channel, configured
/// via [`ClaimBook::set_verification_key`], and that channel's EIP-712
/// domain, configured via [`ClaimBook::set_channel_domain`].
pub struct ClaimBook {
    signer: Option<Arc<dyn Signer>>,
    /// `peer_id` -> the channel this connector claims against when it owes
    /// that peer.
    outbound_channels: HashMap<String, String>,
    /// `channel_id` -> its parsed on-chain `bytes32` and the EIP-712 domain
    /// its claims are signed and verified under (issue #575/#566). Shared
    /// by both directions -- outbound signing (`record_fulfillment`) and
    /// inbound verification (`accept_inbound`) build the same
    /// [`EvmBalanceProof`] shape from the same channel, differing only in
    /// which nonce/amount they carry and, for inbound, which address the
    /// recovered signer must match.
    channel_domains: HashMap<String, (OnChainChannelId, ChannelDomain)>,
    /// `channel_id` -> the EVM address whose signature this connector
    /// accepts on a claim for that channel -- recovered from the signature
    /// via `connector_signer::verify_evm_balance_proof`, never the claim's
    /// own self-declared field.
    counterparties: HashMap<String, Address>,
    /// `channel_id` -> its Solana binding (issue #732): the channel account
    /// bytes a claim's ed25519 message is built over and the counterparty
    /// key its signature must verify against. Deliberately a **second**
    /// map rather than a chain field on the first: a channel is registered
    /// on exactly one chain, and a lookup that misses here after hitting
    /// `channel_domains` (or vice versa) is the honest
    /// [`ClaimRejectReason::UnknownChannel`] a claim presenting the wrong
    /// chain's signature for a channel deserves. See
    /// [`ClaimBook::set_solana_channel`].
    solana_channels: HashMap<String, SolanaChannel>,
    /// `channel_id` -> the exposure ceiling this connector tolerates before
    /// it stops forwarding for that channel's counterparty (ADR 0005,
    /// peer-wire-spec.md §5.3, issue #424). A channel with none configured
    /// is never over ceiling -- matching how a node with no signer never
    /// emits a claim rather than panicking.
    ceilings: HashMap<String, u64>,
    outbound: RwLock<HashMap<String, OutboundLedger>>,
    /// `channel_id` -> the highest nonce/amount accepted on it so far.
    inbound_watermarks: RwLock<HashMap<String, Watermark>>,
    /// Durable record of every claim signed, every claim accepted, and
    /// every inbound fulfilment not yet covered by one (ADR 0005, issue
    /// #424). Defaults to [`InMemoryJournal`] -- a node that never
    /// configures a real one keeps working exactly as it did before this
    /// issue, just without surviving a restart, matching how `settlement`
    /// degrades to `None`.
    journal: Arc<dyn Journal>,
    /// Balances and exposure, derived from `journal`'s own entries rather
    /// than stored independently (ADR 0005). Updated alongside every
    /// journal append so a live read never has to replay the journal.
    projection: RwLock<Projection>,
}

impl ClaimBook {
    pub fn new(
        signer: Option<Arc<dyn Signer>>,
        outbound_channels: HashMap<String, String>,
        counterparties: HashMap<String, Address>,
    ) -> ClaimBook {
        ClaimBook {
            signer,
            outbound_channels,
            channel_domains: HashMap::new(),
            counterparties,
            solana_channels: HashMap::new(),
            ceilings: HashMap::new(),
            outbound: RwLock::new(HashMap::new()),
            inbound_watermarks: RwLock::new(HashMap::new()),
            journal: Arc::new(InMemoryJournal::new()),
            projection: RwLock::new(Projection::default()),
        }
    }

    fn outbound_mut(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, OutboundLedger>> {
        self.outbound
            .write()
            .expect("outbound claims lock poisoned")
    }

    /// Configure this connector's own signer, used to sign every outbound
    /// claim. Takes `&mut self` -- called only while a `Connector` is still
    /// being built (`mut self` builder chain), before it is shared, exactly
    /// like `Connector::with_settlement`.
    pub fn set_signer(&mut self, signer: Arc<dyn Signer>) {
        self.signer = Some(signer);
    }

    /// Configure the channel this connector claims against when it owes
    /// `peer_id`.
    pub fn set_outbound_channel(
        &mut self,
        peer_id: impl Into<String>,
        channel_id: impl Into<String>,
    ) {
        self.outbound_channels
            .insert(peer_id.into(), channel_id.into());
    }

    /// Configure the EVM address whose signature this connector accepts on
    /// an inbound claim for `channel_id` -- the channel's counterparty,
    /// never a claim's own self-declared signer (issue #575, matching
    /// `client-edge-spec.md` §1.3 step 4's rule that a forger can declare
    /// anything). Also call [`ClaimBook::set_channel_domain`] for the same
    /// `channel_id` -- without a domain configured, a claim naming it is
    /// refused as [`ClaimRejectReason::UnknownChannel`] regardless of this.
    pub fn set_verification_key(&mut self, channel_id: impl Into<String>, counterparty: Address) {
        self.counterparties.insert(channel_id.into(), counterparty);
    }

    /// Whether `channel_id` is one this connector recognizes -- a
    /// counterparty address has been configured for it, this connector's
    /// own record of an established payment channel absent a full
    /// peer identity handshake (ADR 0027, #676). Used by probe gating (issue
    /// #426, ADR 0011): a sender with no recognized channel gets no free
    /// traversal of this connector's network.
    pub fn has_verification_key(&self, channel_id: &str) -> bool {
        self.counterparties.contains_key(channel_id)
    }

    /// Configure `channel_id`'s EIP-712 signing domain (issue #575/#566):
    /// the chain it is deployed on and the `TokenNetwork` contract that
    /// verifies a claim's signature on redemption. Required before this
    /// channel can sign an outbound claim or accept an inbound one -- a
    /// channel with no domain configured simply never produces or accepts
    /// a claim (AC3: "produces no claim at all rather than a claim signed
    /// under a defaulted or wrong domain"), matching how a node with no
    /// signer never emits one. `channel_id` must already be the channel's
    /// on-chain `bytes32` -- see [`InvalidChannelId`] for the accepted
    /// shapes -- and is refused here, never hashed or truncated into
    /// shape, if it is not (AC4).
    pub fn set_channel_domain(
        &mut self,
        channel_id: impl Into<String>,
        domain: ChannelDomain,
    ) -> Result<(), InvalidChannelId> {
        let channel_id = channel_id.into();
        let on_chain_id = parse_channel_id(&channel_id)?;
        self.channel_domains
            .insert(channel_id, (on_chain_id, domain));
        Ok(())
    }

    /// Register `channel_account` as a Solana peer channel whose claims
    /// this connector accepts from `counterparty_public_key` (issue #732)
    /// -- the Solana counterpart to [`ClaimBook::set_channel_domain`] plus
    /// [`ClaimBook::set_verification_key`] in one call, because on Solana
    /// the two are inseparable: the account *is* the whole of the signed
    /// message's domain, and there is no separate `verifyingContract` for
    /// a second call to carry.
    ///
    /// `channel_account` is the base58 account id, and doubles as the
    /// `channel_id` a claim names and a watermark is filed under -- the
    /// same string the wire's `channelAccount` field carries. Base58 of an
    /// exact 32-byte decode has one spelling, so unlike the EVM side there
    /// is nothing to canonicalise (see
    /// `connector_domain::client_claim::canonical_channel_key`'s own
    /// reasoning), and an id that does not decode to exactly 32 bytes is
    /// refused here rather than padded into shape.
    ///
    /// A channel registered here can never be confused with one registered
    /// by `set_channel_domain`: a claim's chain is decided by which
    /// signature scheme it carries, and each scheme reads only its own map
    /// (see [`ClaimBook::accept_inbound`]). Registering the same string in
    /// both maps therefore still yields two independent channels, not one
    /// ambiguous one -- and in practice cannot happen, since a 32-byte
    /// base58 id is never `0x` + 64 hex nor a decimal numeral.
    pub fn set_solana_channel(
        &mut self,
        channel_account: impl Into<String>,
        counterparty_public_key: &str,
    ) -> Result<(), InvalidSolanaChannel> {
        let channel_account = channel_account.into();
        let account_bytes = parse_base58_32("channel account", &channel_account)?;
        let counterparty_public_key = parse_base58_32("counterparty key", counterparty_public_key)?;
        self.solana_channels.insert(
            channel_account,
            SolanaChannel {
                channel_account: account_bytes,
                counterparty_public_key,
            },
        );
        Ok(())
    }

    /// Configure `channel_id`'s exposure ceiling (issue #424,
    /// peer-wire-spec.md §5.3).
    pub fn set_ceiling(&mut self, channel_id: impl Into<String>, ceiling: u64) {
        self.ceilings.insert(channel_id.into(), ceiling);
    }

    /// Configure the durable journal claim and exposure state is persisted
    /// to, replaying every entry already in it to rebuild this book's
    /// in-memory state (ADR 0005, issue #424: "rebuilt from the journal on
    /// start"). Call this *after* [`ClaimBook::set_signer`] and every
    /// [`ClaimBook::set_channel_domain`] call -- rebuild re-signs a fresh
    /// claim for any peer left with unacknowledged exposure (see
    /// [`ClaimBook::rebuild_from`]'s own doc), which needs both a signer
    /// and that channel's domain already in place to do; without either,
    /// that peer's cumulative state still recovers correctly, it just
    /// cannot re-arm a claim to send until a fulfilment next changes it.
    /// Takes `&mut self` for the same reason `set_signer` does -- called
    /// only while a `Connector` is still being built.
    pub fn set_journal(
        &mut self,
        journal: Arc<dyn Journal>,
    ) -> Result<Vec<ProjectionDivergence>, JournalError> {
        let entries = journal.read_all()?;
        let (outbound, inbound_watermarks, projection) =
            Self::rebuild_from(&entries, self.signer.as_ref(), &self.channel_domains);
        let divergences = projection.divergences();
        for divergence in &divergences {
            tracing::error!(%divergence, "journal rebuild found a projection divergence");
        }
        self.journal = journal;
        self.outbound = RwLock::new(outbound);
        self.inbound_watermarks = RwLock::new(inbound_watermarks);
        self.projection = RwLock::new(projection);
        Ok(divergences)
    }

    /// Fold `entries` into fresh outbound/inbound state and a
    /// [`Projection`] -- the pure replay [`ClaimBook::set_journal`] drives.
    /// A peer left with `pending` unacknowledged is *always* re-armed with
    /// a freshly signed claim of the same nonce/cumulative amount when both
    /// `signer` and that channel's domain (in `channel_domains`) are
    /// available: resending an already-acknowledged claim costs nothing
    /// (the peer's own `accept_inbound` simply rejects a nonce that does
    /// not advance its watermark), so recovery needs no separate "was this
    /// acknowledged" record -- treating every rebuilt claim as pending is
    /// always safe, matching the acceptance criteria's "no manual repair".
    /// A ledger whose channel has no domain configured is left with no
    /// pending claim, exactly as [`ClaimBook::record_fulfillment`] would
    /// have refused to sign one for it live.
    fn rebuild_from(
        entries: &[JournalEntry],
        signer: Option<&Arc<dyn Signer>>,
        channel_domains: &HashMap<String, (OnChainChannelId, ChannelDomain)>,
    ) -> (
        HashMap<String, OutboundLedger>,
        HashMap<String, Watermark>,
        Projection,
    ) {
        let mut outbound: HashMap<String, OutboundLedger> = HashMap::new();
        let mut inbound_watermarks: HashMap<String, Watermark> = HashMap::new();
        let mut projection = Projection::default();
        for entry in entries {
            projection.apply(entry);
            match entry {
                JournalEntry::OutboundClaimSigned {
                    peer_id,
                    channel_id,
                    nonce,
                    cumulative_amount,
                } => {
                    outbound.insert(
                        peer_id.clone(),
                        OutboundLedger {
                            channel_id: channel_id.clone(),
                            pending: None,
                            pending_since: None,
                            nonce: *nonce,
                            cumulative_amount: *cumulative_amount,
                        },
                    );
                }
                JournalEntry::InboundClaimAccepted {
                    channel_id,
                    nonce,
                    cumulative_amount,
                    ..
                } => {
                    inbound_watermarks.insert(
                        channel_id.clone(),
                        advance_watermark(*nonce, *cumulative_amount),
                    );
                }
                JournalEntry::InboundFulfillmentRecorded { .. } => {}
            }
        }
        if let Some(signer) = signer {
            for ledger in outbound.values_mut() {
                let Some(&(on_chain_id, domain)) = channel_domains.get(&ledger.channel_id) else {
                    continue;
                };
                let proof = evm_proof(on_chain_id, domain, ledger.nonce, ledger.cumulative_amount);
                if let Ok(signature) = signer.sign(&evm_balance_proof_digest(&proof)) {
                    ledger.pending = Some(WireClaim {
                        channel_id: ledger.channel_id.clone(),
                        nonce: ledger.nonce,
                        cumulative_amount: ledger.cumulative_amount,
                        signature: ClaimSignature::Evm(signature),
                    });
                }
            }
        }
        (outbound, inbound_watermarks, projection)
    }

    /// Append `entry` to the durable journal and fold it into the live
    /// projection. A failed durable write is logged rather than losing the
    /// in-memory update entirely -- this connector's own session-lifetime
    /// bookkeeping (and, in particular, ceiling enforcement) stays correct
    /// even in that case; only surviving a restart is at risk, exactly the
    /// same degradation a node with no journal configured lives with for
    /// its entire lifetime.
    fn append_and_project(&self, entry: JournalEntry) {
        if let Err(err) = self.journal.append(&entry) {
            tracing::error!(%err, "failed to durably append a journal entry");
        }
        self.projection
            .write()
            .expect("projection lock poisoned")
            .apply(&entry);
    }

    /// The channel this connector claims against when it owes `peer_id`,
    /// if one is configured (issue #424: identifies which channel an
    /// outgoing frame to `peer_id` is claimed against, independent of
    /// whether a claim happens to be pending right now).
    pub fn outbound_channel_id(&self, peer_id: &str) -> Option<String> {
        self.outbound_channels.get(peer_id).cloned()
    }

    /// `channel_id`'s current exposure: value this connector has delivered
    /// on that channel's counterparty's behalf but does not yet hold a
    /// covering claim for (peer-wire-spec.md §5.3).
    pub fn exposure(&self, channel_id: &str) -> u64 {
        self.projection
            .read()
            .expect("projection lock poisoned")
            .exposure(channel_id)
    }

    /// The latest claim this connector has ever accepted on `channel_id`
    /// (issue #425), ready to submit to a `SettlementBackend::redeem` --
    /// never a superseded one, since the projection this reads from only
    /// ever retains the highest-nonce claim (peer-wire-spec.md §3.4).
    /// `None` if no claim has ever been accepted on this channel.
    pub fn latest_inbound_claim(&self, channel_id: &str) -> Option<connector_settlement::Claim> {
        let (nonce, cumulative_amount, signature) = self
            .projection
            .read()
            .expect("projection lock poisoned")
            .latest_inbound_claim(channel_id)?;
        Some(connector_settlement::Claim {
            nonce,
            cumulative_amount: cumulative_amount as u128,
            signature,
        })
    }

    /// Whether `channel_id`'s exposure exceeds its configured ceiling. A
    /// channel with no ceiling configured is never over one -- matching how
    /// a peer with no configured channel never gets a claim emitted.
    pub fn is_over_ceiling(&self, channel_id: &str) -> bool {
        match self.ceilings.get(channel_id) {
            Some(&ceiling) => self
                .projection
                .read()
                .expect("projection lock poisoned")
                .is_over_ceiling(channel_id, ceiling),
            None => false,
        }
    }

    /// Record that a packet arriving on `channel_id` fulfilled for `amount`,
    /// extending this connector's exposure to that channel's counterparty
    /// until a covering claim is accepted (peer-wire-spec.md §5.3, issue
    /// #424). Durable: journaled before the in-memory projection reflects
    /// it, matching [`ClaimBook::record_fulfillment`]'s own ordering.
    pub fn record_inbound_delivery(&self, channel_id: &str, amount: u64) {
        self.append_and_project(JournalEntry::InboundFulfillmentRecorded {
            channel_id: channel_id.to_string(),
            amount,
        });
    }

    /// Record that a packet forwarded to `peer_id` fulfilled, owing it
    /// `amount` more (ADR 0004 -- value moves on fulfilment). Signs a fresh
    /// claim for the new cumulative total, over that channel's EIP-712
    /// domain (issue #575), and arms it pending. Exactly one claim is
    /// produced per call -- never batched: a second fulfilment before the
    /// first claim has gone out simply supersedes it with a fresher nonce
    /// and a higher cumulative amount (peer-wire-spec.md §3.2). Does
    /// nothing -- and leaves this peer's ledger untouched -- for a peer
    /// with no configured channel, a node with no signer configured, or a
    /// channel with no domain configured (AC3): every one of those is a
    /// reason a claim cannot be produced at all, not a reason to produce
    /// one under a defaulted or wrong domain.
    pub fn record_fulfillment(
        &self,
        peer_id: &str,
        amount: u64,
        now: DateTime<Utc>,
    ) -> Option<WireClaim> {
        let channel_id = self.outbound_channels.get(peer_id)?.clone();
        let signer = self.signer.as_ref()?;
        let &(on_chain_id, domain) = self.channel_domains.get(&channel_id)?;
        let mut outbound = self.outbound_mut();
        let ledger = outbound
            .entry(peer_id.to_string())
            .or_insert_with(|| OutboundLedger {
                channel_id: channel_id.clone(),
                ..Default::default()
            });
        ledger.cumulative_amount += amount;
        ledger.nonce += 1;
        let proof = evm_proof(on_chain_id, domain, ledger.nonce, ledger.cumulative_amount);
        let signature = signer.sign(&evm_balance_proof_digest(&proof)).ok()?;
        let claim = WireClaim {
            channel_id: ledger.channel_id.clone(),
            nonce: ledger.nonce,
            cumulative_amount: ledger.cumulative_amount,
            signature: ClaimSignature::Evm(signature),
        };
        ledger.pending = Some(claim.clone());
        ledger.pending_since = Some(now);
        self.append_and_project(JournalEntry::OutboundClaimSigned {
            peer_id: peer_id.to_string(),
            channel_id: claim.channel_id.clone(),
            nonce: claim.nonce,
            cumulative_amount: claim.cumulative_amount,
        });
        Some(claim)
    }

    /// The claim owed to `peer_id`, if one is pending -- what the next
    /// frame out to that peer should carry (peer-wire-spec.md §3.2).
    pub fn pending_claim(&self, peer_id: &str) -> Option<WireClaim> {
        self.outbound
            .read()
            .expect("outbound claims lock poisoned")
            .get(peer_id)
            .and_then(|ledger| ledger.pending.clone())
    }

    /// The total this connector has ever signed an outbound claim for on
    /// `peer_id` -- unlike [`ClaimBook::pending_claim`], which answers
    /// `None` once the most recent claim has been acknowledged, this never
    /// resets: [`ClaimBook::acknowledge_outbound`] only ever clears
    /// `pending`, never `cumulative_amount` (issue #700's netting --
    /// `client-edge-spec.md`'s "credited" term is what this connector has
    /// *committed* to pay, not what is still in flight, since an
    /// acknowledgement confirms delivery of a claim rather than undoing the
    /// commitment it represents). `0` for a peer this book has never signed
    /// a claim for.
    pub fn outbound_cumulative_amount(&self, peer_id: &str) -> u64 {
        self.outbound
            .read()
            .expect("outbound claims lock poisoned")
            .get(peer_id)
            .map(|ledger| ledger.cumulative_amount)
            .unwrap_or(0)
    }

    /// Every peer whose pending claim has waited at least `flush_interval`
    /// since it armed, as of `now` -- what a flush sweep should send
    /// (peer-wire-spec.md §3.3). Checked fresh against the injected clock,
    /// like `Connector`'s leased-route expiry, rather than driven by a
    /// stored deadline.
    pub fn due_for_flush(
        &self,
        now: DateTime<Utc>,
        flush_interval: Duration,
    ) -> Vec<(String, WireClaim)> {
        self.outbound
            .read()
            .expect("outbound claims lock poisoned")
            .iter()
            .filter_map(|(peer_id, ledger)| {
                let since = ledger.pending_since?;
                let claim = ledger.pending.clone()?;
                if now - since >= flush_interval {
                    Some((peer_id.clone(), claim))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Record the outcome of a claim of `nonce` sent to `peer_id`. On
    /// acceptance the pending mark clears -- but only if `nonce` still
    /// names the claim actually pending: a fresher fulfilment may already
    /// have superseded it while the acknowledgement was in flight, and
    /// acknowledging the stale nonce must not clear that newer claim
    /// (peer-wire-spec.md §3.2).
    pub fn acknowledge_outbound(&self, peer_id: &str, nonce: u64, outcome: ClaimAckOutcome) {
        if outcome != ClaimAckOutcome::Accepted {
            return;
        }
        let mut outbound = self.outbound_mut();
        if let Some(ledger) = outbound.get_mut(peer_id) {
            if ledger.pending.as_ref().map(|c| c.nonce) == Some(nonce) {
                ledger.pending = None;
                ledger.pending_since = None;
            }
        }
    }

    /// Whether `claim`'s signature is genuine, for the chain the signature
    /// itself is in and against this connector's **own** record of that
    /// channel (issue #732, `client-edge-spec.md` §1.3 step 4's rule that
    /// a forger can declare anything).
    ///
    /// The claim's scheme selects which record is consulted, and each
    /// scheme reads only its own map. An ed25519 signature naming a
    /// channel registered as EVM therefore finds nothing and is
    /// [`ClaimRejectReason::UnknownChannel`], and so is the mirror case --
    /// neither is ever checked against the other chain's record, and
    /// neither can be made to pass by relabelling. Both chains verify
    /// through `connector_signer::claim_signature`, the same module the
    /// client edge's own gate uses (`ClientClaimGate`), so there is one
    /// EIP-712 digest and one ed25519 message definition in this
    /// workspace, not two per edge.
    ///
    /// ADR 0002 keeps Mina out entirely: [`ClaimSignature`] has no Mina
    /// variant, so a Mina claim is refused before it can reach here, at
    /// the carriage's own `parse`.
    fn verify_signature(&self, claim: &WireClaim) -> Result<(), ClaimRejectReason> {
        match &claim.signature {
            ClaimSignature::Evm(signature) => {
                let Some(&(on_chain_id, domain)) = self.channel_domains.get(&claim.channel_id)
                else {
                    return Err(ClaimRejectReason::UnknownChannel);
                };
                let Some(counterparty) = self.counterparties.get(&claim.channel_id) else {
                    return Err(ClaimRejectReason::UnknownChannel);
                };
                let proof = evm_proof(on_chain_id, domain, claim.nonce, claim.cumulative_amount);
                if verify_evm_balance_proof(&proof, &signature.to_bytes(), counterparty) {
                    Ok(())
                } else {
                    Err(ClaimRejectReason::SignatureInvalid)
                }
            }
            ClaimSignature::Solana(signature) => {
                let Some(channel) = self.solana_channels.get(&claim.channel_id) else {
                    return Err(ClaimRejectReason::UnknownChannel);
                };
                if verify_solana_balance_proof(
                    &channel.channel_account,
                    claim.nonce,
                    claim.cumulative_amount,
                    signature,
                    &channel.counterparty_public_key,
                ) {
                    Ok(())
                } else {
                    Err(ClaimRejectReason::SignatureInvalid)
                }
            }
        }
    }

    /// Verify and, if valid, accept an inbound `claim`, advancing the
    /// watermark on its `channel_id` (peer-wire-spec.md §3.4). Independent
    /// of whatever PREPARE the claim rode in on -- a rejected claim does
    /// not reject that PREPARE, and this method never looks at one. Both
    /// an unregistered channel and one with no domain configured are
    /// [`ClaimRejectReason::UnknownChannel`] -- neither leaves anything
    /// this connector could verify a signature against.
    pub fn accept_inbound(&self, claim: &WireClaim) -> ClaimAckOutcome {
        match self.verify_signature(claim) {
            Ok(()) => {}
            Err(reason) => return ClaimAckOutcome::Rejected(reason),
        }

        let mut watermarks = self
            .inbound_watermarks
            .write()
            .expect("inbound watermarks lock poisoned");
        let watermark = watermarks.get(&claim.channel_id).copied();
        match validate_claim(watermark, claim.nonce, claim.cumulative_amount) {
            Ok(()) => {
                watermarks.insert(
                    claim.channel_id.clone(),
                    advance_watermark(claim.nonce, claim.cumulative_amount),
                );
                drop(watermarks);
                self.append_and_project(JournalEntry::InboundClaimAccepted {
                    channel_id: claim.channel_id.clone(),
                    nonce: claim.nonce,
                    cumulative_amount: claim.cumulative_amount,
                    signature: claim.signature.to_bytes(),
                });
                ClaimAckOutcome::Accepted
            }
            Err(ClaimError::NonceNotAdvancing { .. }) => {
                ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing)
            }
            Err(ClaimError::AmountNotAdvancing { .. }) => {
                ClaimAckOutcome::Rejected(ClaimRejectReason::AmountNotAdvancing)
            }
            // The peer wire never calls `validate_price` -- a route's price
            // is charged at the client edge (issue #522), not against a
            // peer's own claim -- so this arm is unreachable in practice;
            // it exists only so this match stays exhaustive as
            // `ClaimError` grows new variants.
            Err(ClaimError::Underpayment { .. }) => unreachable!(
                "accept_inbound never calls validate_price, so a peer claim cannot fail with Underpayment"
            ),
        }
    }

    /// Every peer's claim state, for the operator surface's read-only
    /// inspection interface (issue #420). `peer_id` is `None` on an inbound
    /// entry for the same reason `accept_inbound` needs none: the peer wire
    /// has no identity handshake yet, so only the channel is known.
    pub fn views(&self) -> Vec<ClaimView> {
        let mut views: Vec<ClaimView> = self
            .outbound
            .read()
            .expect("outbound claims lock poisoned")
            .iter()
            .filter(|(_, ledger)| ledger.nonce > 0)
            .map(|(peer_id, ledger)| ClaimView {
                peer_id: Some(peer_id.clone()),
                channel_id: ledger.channel_id.clone(),
                direction: crate::operator_view::ClaimDirection::Outbound,
                nonce: ledger.nonce,
                cumulative_amount: ledger.cumulative_amount,
                pending: ledger.pending.is_some(),
            })
            .collect();
        views.extend(
            self.inbound_watermarks
                .read()
                .expect("inbound watermarks lock poisoned")
                .iter()
                .map(|(channel_id, watermark)| ClaimView {
                    peer_id: None,
                    channel_id: channel_id.clone(),
                    direction: crate::operator_view::ClaimDirection::Inbound,
                    nonce: watermark.nonce,
                    cumulative_amount: watermark.cumulative_amount,
                    pending: false,
                }),
        );
        views
    }

    /// Every channel with known exposure, for the operator surface's
    /// read-only inspection interface (issue #424): every channel a
    /// ceiling is configured for, union every channel the projection has
    /// ever recorded a fulfilment or an accepted claim on -- so a channel
    /// shows up here even before its first claim, and a configured ceiling
    /// is visible even on a channel with zero exposure so far.
    pub fn exposure_views(&self) -> Vec<ExposureView> {
        let projection = self.projection.read().expect("projection lock poisoned");
        let mut channel_ids: Vec<String> = self.ceilings.keys().cloned().collect();
        for channel_id in projection.known_channels() {
            if !channel_ids.contains(&channel_id) {
                channel_ids.push(channel_id);
            }
        }
        channel_ids.sort();
        channel_ids
            .into_iter()
            .map(|channel_id| {
                let ceiling = self.ceilings.get(&channel_id).copied();
                let exposure = projection.exposure(&channel_id);
                ExposureView {
                    channel_id,
                    exposure,
                    ceiling,
                    over_ceiling: ceiling.is_some_and(|ceiling| exposure > ceiling),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_signer::{derive_evm_address, LocalSigner};

    fn now() -> DateTime<Utc> {
        "2030-01-01T00:00:00Z".parse().unwrap()
    }

    /// A fixed EIP-712 domain every test channel shares -- Base Sepolia's
    /// chain id and an arbitrary `TokenNetwork` address; nothing in this
    /// module's tests depends on their real-world provenance, only that
    /// signing and verifying a claim use the same domain unless a test
    /// deliberately varies it.
    fn test_domain() -> ChannelDomain {
        ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x1E; 20],
        }
    }

    /// A valid on-chain `bytes32` channel id for tests -- `0x` followed by
    /// `n` left-padded to 64 hex characters (issue #575's AC4: a peer-wire
    /// claim's channel id must already be a real bytes32, never an
    /// arbitrary label like the old `"channel-a"` placeholders this module
    /// used before this issue).
    fn channel_id(n: u8) -> String {
        format!("0x{n:064x}")
    }

    /// Sign a claim for `channel`/`nonce`/`amount` under [`test_domain`],
    /// exactly as [`ClaimBook::record_fulfillment`] would.
    fn sign_claim(signer: &LocalSigner, channel: &str, nonce: u64, amount: u64) -> WireClaim {
        let on_chain_id = parse_channel_id(channel).expect("test channel id is valid");
        let proof = evm_proof(on_chain_id, test_domain(), nonce, amount);
        WireClaim {
            channel_id: channel.to_string(),
            nonce,
            cumulative_amount: amount,
            signature: ClaimSignature::Evm(
                signer
                    .sign(&evm_balance_proof_digest(&proof))
                    .expect("sign"),
            ),
        }
    }

    /// A book that can both sign outbound claims to `peer_id` on
    /// `channel`, and verify inbound claims on `channel` against
    /// `counterparty` -- with `channel`'s domain already registered as
    /// [`test_domain`].
    fn book_with_peer(peer_id: &str, channel: &str, counterparty: Address) -> ClaimBook {
        let signer = Arc::new(LocalSigner::generate("claim-key"));
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert(peer_id.to_string(), channel.to_string());
        let mut counterparties = HashMap::new();
        counterparties.insert(channel.to_string(), counterparty);
        let mut book = ClaimBook::new(Some(signer), outbound_channels, counterparties);
        book.set_channel_domain(channel, test_domain())
            .expect("test channel id is valid");
        book
    }

    #[test]
    fn a_wire_claim_round_trips_through_encode_and_decode() {
        let claim = WireClaim {
            channel_id: channel_id(1),
            nonce: 7,
            cumulative_amount: 900,
            signature: ClaimSignature::Evm(Signature {
                r: [1u8; 32],
                s: [2u8; 32],
                recovery_id: 1,
            }),
        };
        let mut bytes = claim.encode();
        bytes.extend_from_slice(b"trailing");

        let (decoded, consumed) = WireClaim::decode(&bytes).unwrap();
        assert_eq!(decoded, claim);
        assert_eq!(&bytes[consumed..], b"trailing");
    }

    #[test]
    fn a_claim_ack_round_trips_through_encode_and_decode() {
        for outcome in [
            ClaimAckOutcome::Accepted,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::AmountNotAdvancing),
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel),
        ] {
            let bytes = outcome.encode();
            assert_eq!(ClaimAckOutcome::decode(&bytes), Some(outcome));
        }
    }

    mod channel_id_parsing {
        use super::*;

        #[test]
        fn a_0x_prefixed_64_hex_char_id_parses_exactly() {
            let mut expected = [0u8; 32];
            expected[31] = 0xab;
            assert_eq!(parse_channel_id(&format!("0x{:064x}", 0xab)), Ok(expected));
        }

        #[test]
        fn a_bare_64_hex_char_id_parses_the_same_as_0x_prefixed() {
            assert_eq!(
                parse_channel_id(&"ab".repeat(32)),
                parse_channel_id(&format!("0x{}", "ab".repeat(32)))
            );
        }

        #[test]
        fn a_decimal_numeral_embeds_as_big_endian_bytes_of_that_integer() {
            let mut expected = [0u8; 32];
            expected[31] = 42;
            assert_eq!(parse_channel_id("42"), Ok(expected));
            assert_eq!(parse_channel_id("0"), Ok([0u8; 32]));
        }

        #[test]
        fn an_arbitrary_label_is_refused_rather_than_hashed_or_truncated() {
            assert_eq!(
                parse_channel_id("channel-a"),
                Err(InvalidChannelId("channel-a".to_string()))
            );
            assert_eq!(parse_channel_id(""), Err(InvalidChannelId(String::new())));
            // One hex character short of 32 bytes -- not silently padded.
            assert_eq!(
                parse_channel_id(&"a".repeat(63)),
                Err(InvalidChannelId("a".repeat(63)))
            );
        }

        #[test]
        fn set_channel_domain_refuses_an_invalid_channel_id_and_registers_nothing() {
            let mut book = ClaimBook::new(None, HashMap::new(), HashMap::new());

            let result = book.set_channel_domain("channel-a", test_domain());

            assert_eq!(result, Err(InvalidChannelId("channel-a".to_string())));
        }
    }

    #[test]
    fn no_claim_is_recorded_without_a_signer() {
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert("peer-b".to_string(), channel_id(1));
        let mut book = ClaimBook::new(None, outbound_channels, HashMap::new());
        book.set_channel_domain(channel_id(1), test_domain())
            .unwrap();

        assert!(book.record_fulfillment("peer-b", 100, now()).is_none());
    }

    #[test]
    fn no_claim_is_recorded_for_an_unregistered_peer() {
        let book = ClaimBook::new(
            Some(Arc::new(LocalSigner::generate("k"))),
            HashMap::new(),
            HashMap::new(),
        );

        assert!(book.record_fulfillment("peer-b", 100, now()).is_none());
    }

    #[test]
    fn no_claim_is_recorded_for_a_channel_with_no_domain_configured() {
        let signer = Arc::new(LocalSigner::generate("k"));
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert("peer-b".to_string(), channel_id(1));
        // Deliberately never calling `set_channel_domain`.
        let book = ClaimBook::new(Some(signer), outbound_channels, HashMap::new());

        assert!(book.record_fulfillment("peer-b", 100, now()).is_none());
        assert_eq!(book.pending_claim("peer-b"), None);
    }

    #[test]
    fn recording_a_fulfillment_arms_exactly_one_pending_claim_with_nonce_one() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);

        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        assert_eq!(claim.nonce, 1);
        assert_eq!(claim.cumulative_amount, 100);
        assert_eq!(book.pending_claim("peer-b"), Some(claim));
    }

    #[test]
    fn a_second_fulfillment_before_the_first_drains_supersedes_it_rather_than_batching() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);

        book.record_fulfillment("peer-b", 100, now()).unwrap();
        let second = book.record_fulfillment("peer-b", 50, now()).unwrap();

        // Exactly one pending claim, holding the latest cumulative state --
        // not two, and not the first one.
        assert_eq!(second.nonce, 2);
        assert_eq!(second.cumulative_amount, 150);
        assert_eq!(book.pending_claim("peer-b"), Some(second));
    }

    #[test]
    fn acknowledging_the_pending_nonce_clears_it() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        book.acknowledge_outbound("peer-b", claim.nonce, ClaimAckOutcome::Accepted);

        assert_eq!(book.pending_claim("peer-b"), None);
    }

    #[test]
    fn acknowledging_a_stale_nonce_does_not_clear_a_fresher_pending_claim() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let first = book.record_fulfillment("peer-b", 100, now()).unwrap();
        let second = book.record_fulfillment("peer-b", 50, now()).unwrap();

        book.acknowledge_outbound("peer-b", first.nonce, ClaimAckOutcome::Accepted);

        assert_eq!(book.pending_claim("peer-b"), Some(second));
    }

    #[test]
    fn a_rejected_ack_leaves_the_claim_pending() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        book.acknowledge_outbound(
            "peer-b",
            claim.nonce,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
        );

        assert_eq!(book.pending_claim("peer-b"), Some(claim));
    }

    #[test]
    fn outbound_cumulative_amount_is_zero_for_a_peer_never_signed_for() {
        let book = ClaimBook::new(None, HashMap::new(), HashMap::new());

        assert_eq!(book.outbound_cumulative_amount("peer-b"), 0);
    }

    #[test]
    fn outbound_cumulative_amount_tracks_the_running_total_across_fulfillments() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);

        book.record_fulfillment("peer-b", 100, now()).unwrap();
        book.record_fulfillment("peer-b", 50, now()).unwrap();

        assert_eq!(book.outbound_cumulative_amount("peer-b"), 150);
    }

    #[test]
    fn outbound_cumulative_amount_survives_acknowledgement() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        book.acknowledge_outbound("peer-b", claim.nonce, ClaimAckOutcome::Accepted);

        // Acknowledgement clears `pending`, not the running total this
        // connector committed to -- the whole point of issue #700's
        // "credited" being distinct from "pending".
        assert_eq!(book.pending_claim("peer-b"), None);
        assert_eq!(book.outbound_cumulative_amount("peer-b"), 100);
    }

    #[test]
    fn a_claim_not_yet_waiting_the_full_flush_interval_is_not_due() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        book.record_fulfillment("peer-b", 100, now()).unwrap();

        let due = book.due_for_flush(now() + Duration::seconds(5), Duration::seconds(10));

        assert!(due.is_empty());
    }

    #[test]
    fn a_claim_waiting_the_full_flush_interval_is_due() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();

        let due = book.due_for_flush(now() + Duration::seconds(10), Duration::seconds(10));

        assert_eq!(due, vec![("peer-b".to_string(), claim)]);
    }

    #[test]
    fn an_acknowledged_claim_is_never_due_for_flush() {
        let key = derive_evm_address(&LocalSigner::generate("k").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();
        book.acknowledge_outbound("peer-b", claim.nonce, ClaimAckOutcome::Accepted);

        let due = book.due_for_flush(now() + Duration::days(1), Duration::seconds(10));

        assert!(due.is_empty());
    }

    #[test]
    fn a_genuinely_signed_claim_from_the_registered_counterparty_is_accepted() {
        let peer_signer = LocalSigner::generate("peer-key");
        let key = derive_evm_address(&peer_signer.public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let claim = sign_claim(&peer_signer, &channel_id(1), 1, 100);

        let outcome = book.accept_inbound(&claim);

        assert_eq!(outcome, ClaimAckOutcome::Accepted);
    }

    #[test]
    fn a_claim_signed_by_the_wrong_key_is_rejected() {
        let key = derive_evm_address(&LocalSigner::generate("peer-key").public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let impostor = LocalSigner::generate("impostor-key");
        let claim = sign_claim(&impostor, &channel_id(1), 1, 100);

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid)
        );
    }

    #[test]
    fn a_claim_signed_under_a_different_chain_id_is_rejected() {
        let peer_signer = LocalSigner::generate("peer-key");
        let key = derive_evm_address(&peer_signer.public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        // Signed under a genuine digest, but for a different chain id than
        // the channel is registered against -- must not recover to the
        // same signature the registered domain would accept.
        let on_chain_id = parse_channel_id(&channel_id(1)).unwrap();
        let wrong_domain = ChannelDomain {
            chain_id: test_domain().chain_id + 1,
            ..test_domain()
        };
        let proof = evm_proof(on_chain_id, wrong_domain, 1, 100);
        let claim = WireClaim {
            channel_id: channel_id(1),
            nonce: 1,
            cumulative_amount: 100,
            signature: ClaimSignature::Evm(
                peer_signer.sign(&evm_balance_proof_digest(&proof)).unwrap(),
            ),
        };

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid)
        );
    }

    #[test]
    fn a_claim_from_an_unregistered_channel_is_rejected_as_unknown_channel() {
        let signer = LocalSigner::generate("k");
        let claim = sign_claim(&signer, &channel_id(1), 1, 100);
        let book = ClaimBook::new(Some(Arc::new(signer)), HashMap::new(), HashMap::new());

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel)
        );
    }

    #[test]
    fn a_claim_on_a_channel_with_a_counterparty_but_no_domain_is_rejected_as_unknown_channel() {
        let signer = LocalSigner::generate("k");
        let counterparty = derive_evm_address(&signer.public_key().unwrap());
        let claim = sign_claim(&signer, &channel_id(1), 1, 100);
        let mut counterparties = HashMap::new();
        counterparties.insert(channel_id(1), counterparty);
        // Deliberately never calling `set_channel_domain`.
        let book = ClaimBook::new(Some(Arc::new(signer)), HashMap::new(), counterparties);

        let outcome = book.accept_inbound(&claim);

        assert_eq!(
            outcome,
            ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel)
        );
    }

    #[test]
    fn a_second_claim_that_does_not_advance_the_nonce_is_rejected_and_the_watermark_holds() {
        let peer_signer = LocalSigner::generate("peer-key");
        let key = derive_evm_address(&peer_signer.public_key().unwrap());
        let book = book_with_peer("peer-b", &channel_id(1), key);
        let sign =
            |nonce: u64, amount: u64| sign_claim(&peer_signer, &channel_id(1), nonce, amount);

        assert_eq!(
            book.accept_inbound(&sign(5, 500)),
            ClaimAckOutcome::Accepted
        );
        let replay = book.accept_inbound(&sign(5, 999));

        assert_eq!(
            replay,
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing)
        );
        // A rejected claim never moves the watermark: the next genuinely
        // advancing claim is still judged against nonce 5 / amount 500.
        assert_eq!(
            book.accept_inbound(&sign(6, 500)),
            ClaimAckOutcome::Accepted
        );
    }

    /// Issue #575's AC5: a claim this connector signs recovers, through
    /// `connector_signer::verify_evm_balance_proof`, to this connector's
    /// own address -- and does not recover under a different domain.
    #[test]
    fn an_outbound_claim_recovers_to_the_signers_own_address_and_not_under_a_different_domain() {
        let signer = LocalSigner::generate("claim-key");
        let own_address = derive_evm_address(&signer.public_key().unwrap());
        let mut outbound_channels = HashMap::new();
        outbound_channels.insert("peer-b".to_string(), channel_id(1));
        let mut book = ClaimBook::new(Some(Arc::new(signer)), outbound_channels, HashMap::new());
        book.set_channel_domain(channel_id(1), test_domain())
            .unwrap();

        let claim = book.record_fulfillment("peer-b", 100, now()).unwrap();
        let on_chain_id = parse_channel_id(&channel_id(1)).unwrap();
        let proof = evm_proof(
            on_chain_id,
            test_domain(),
            claim.nonce,
            claim.cumulative_amount,
        );

        assert!(verify_evm_balance_proof(
            &proof,
            &claim.signature.to_bytes(),
            &own_address
        ));

        let wrong_domain = ChannelDomain {
            token_network_address: [0xAA; 20],
            ..test_domain()
        };
        let proof_under_wrong_domain = evm_proof(
            on_chain_id,
            wrong_domain,
            claim.nonce,
            claim.cumulative_amount,
        );
        assert!(!verify_evm_balance_proof(
            &proof_under_wrong_domain,
            &claim.signature.to_bytes(),
            &own_address
        ));
    }

    mod redemption {
        use super::*;

        #[test]
        fn no_claim_is_redeemable_before_one_is_accepted() {
            let book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            assert_eq!(book.latest_inbound_claim(&channel_id(1)), None);
        }

        #[test]
        fn the_latest_accepted_claim_is_redeemable_and_carries_its_signature() {
            let peer_signer = LocalSigner::generate("peer-key");
            let key = derive_evm_address(&peer_signer.public_key().unwrap());
            let book = book_with_peer("peer-b", &channel_id(1), key);
            let first = sign_claim(&peer_signer, &channel_id(1), 1, 100);
            assert_eq!(book.accept_inbound(&first), ClaimAckOutcome::Accepted);
            let second = sign_claim(&peer_signer, &channel_id(1), 2, 150);
            assert_eq!(book.accept_inbound(&second), ClaimAckOutcome::Accepted);

            // Only the higher-nonce claim is redeemable -- the superseded
            // first claim is never returned (peer-wire-spec.md §3.4: claims
            // supersede rather than accumulate).
            let redeemable = book.latest_inbound_claim(&channel_id(1)).unwrap();
            assert_eq!(redeemable.nonce, 2);
            assert_eq!(redeemable.cumulative_amount, 150);
            assert_eq!(redeemable.signature, second.signature.to_bytes().to_vec());
        }

        /// Issue #573's own regression: `connector_settlement::Claim` must
        /// carry the nonce its signature covers, or nothing it produces is
        /// redeemable on any real chain -- a chain-side check this test
        /// cannot exercise directly, so it pins the one thing that would
        /// silently regress that guarantee: `latest_inbound_claim` reporting
        /// the accepted claim's own nonce, not a default or dropped one.
        #[test]
        fn the_redeemable_claims_nonce_is_the_one_the_peer_actually_signed() {
            let peer_signer = LocalSigner::generate("peer-key");
            let key = derive_evm_address(&peer_signer.public_key().unwrap());
            let book = book_with_peer("peer-b", &channel_id(1), key);
            let claim = sign_claim(&peer_signer, &channel_id(1), 7, 300);
            assert_eq!(book.accept_inbound(&claim), ClaimAckOutcome::Accepted);

            let redeemable = book.latest_inbound_claim(&channel_id(1)).unwrap();
            assert_eq!(redeemable.nonce, 7);
        }
    }

    mod exposure_and_ceiling {
        use super::*;

        #[test]
        fn a_channel_with_no_ceiling_configured_is_never_over_one() {
            let book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            book.record_inbound_delivery(&channel_id(1), u64::MAX);

            assert!(!book.is_over_ceiling(&channel_id(1)));
        }

        #[test]
        fn recorded_deliveries_below_the_ceiling_do_not_trip_it() {
            let mut book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            book.set_ceiling(channel_id(1), 100);
            book.record_inbound_delivery(&channel_id(1), 60);

            assert_eq!(book.exposure(&channel_id(1)), 60);
            assert!(!book.is_over_ceiling(&channel_id(1)));
        }

        #[test]
        fn recorded_deliveries_exceeding_the_ceiling_trip_it() {
            let mut book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            book.set_ceiling(channel_id(1), 100);
            book.record_inbound_delivery(&channel_id(1), 60);
            book.record_inbound_delivery(&channel_id(1), 50);

            assert_eq!(book.exposure(&channel_id(1)), 110);
            assert!(book.is_over_ceiling(&channel_id(1)));
        }

        #[test]
        fn an_accepted_inbound_claim_covers_exposure_and_clears_the_ceiling() {
            let peer_signer = LocalSigner::generate("peer-key");
            let key = derive_evm_address(&peer_signer.public_key().unwrap());
            let mut book = book_with_peer("peer-b", &channel_id(1), key);
            book.set_ceiling(channel_id(1), 100);
            book.record_inbound_delivery(&channel_id(1), 60);
            book.record_inbound_delivery(&channel_id(1), 50);
            assert!(book.is_over_ceiling(&channel_id(1)));

            let claim = sign_claim(&peer_signer, &channel_id(1), 1, 110);
            assert_eq!(book.accept_inbound(&claim), ClaimAckOutcome::Accepted);

            assert_eq!(book.exposure(&channel_id(1)), 0);
            assert!(!book.is_over_ceiling(&channel_id(1)));
        }

        #[test]
        fn outbound_channel_id_reports_the_configured_channel_for_a_peer() {
            let mut book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            book.set_outbound_channel("peer-b", channel_id(1));

            assert_eq!(book.outbound_channel_id("peer-b"), Some(channel_id(1)));
            assert_eq!(book.outbound_channel_id("peer-nowhere"), None);
        }
    }

    mod journal_recovery {
        use super::*;
        use crate::journal::{FileJournal, InMemoryJournal};

        #[test]
        fn a_freshly_configured_journal_has_nothing_to_replay() {
            let mut book = ClaimBook::new(None, HashMap::new(), HashMap::new());
            let divergences = book.set_journal(Arc::new(InMemoryJournal::new())).unwrap();

            assert!(divergences.is_empty());
            assert_eq!(book.exposure(&channel_id(1)), 0);
        }

        /// The acceptance criteria's own scenario: a node killed mid-traffic
        /// recovers its money state by replay, with no manual repair. This
        /// rebuilds a *fresh* `ClaimBook` from the same durable journal a
        /// prior instance wrote to, standing in for a restart, and asserts
        /// every side of its money state -- what it owes downstream, what a
        /// channel has claimed, and what remains exposed -- comes back
        /// exactly as it was.
        #[test]
        fn a_node_restarted_against_the_same_journal_recovers_its_money_state() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("journal.log");
            let signer = Arc::new(LocalSigner::generate("claim-key"));
            let peer_key = LocalSigner::generate("peer-key");
            let out_channel = channel_id(1);
            let in_channel = channel_id(2);

            {
                let mut book = ClaimBook::new(
                    Some(signer.clone() as Arc<dyn Signer>),
                    HashMap::new(),
                    HashMap::new(),
                );
                book.set_outbound_channel("peer-b", out_channel.clone());
                book.set_verification_key(
                    in_channel.clone(),
                    derive_evm_address(&peer_key.public_key().unwrap()),
                );
                book.set_channel_domain(out_channel.clone(), test_domain())
                    .unwrap();
                book.set_channel_domain(in_channel.clone(), test_domain())
                    .unwrap();
                book.set_ceiling(in_channel.clone(), 1_000);
                book.set_journal(Arc::new(FileJournal::open(&path).unwrap()))
                    .unwrap();

                // What we owe peer-b: two fulfilments, superseding into one
                // pending claim.
                book.record_fulfillment("peer-b", 100, now());
                book.record_fulfillment("peer-b", 50, now());

                // What channel-in owes us: delivered but uncovered so far.
                book.record_inbound_delivery(&in_channel, 40);
                book.record_inbound_delivery(&in_channel, 30);

                // A claim channel-in did send us, partially covering it.
                let claim = sign_claim(&peer_key, &in_channel, 1, 40);
                assert_eq!(book.accept_inbound(&claim), ClaimAckOutcome::Accepted);
            }

            // A fresh book, backed by the same journal file, standing in for
            // a restarted process -- nothing here was told about the prior
            // instance's in-memory state directly. Channel domains are
            // reconfigured before the journal, exactly like a real restart
            // reloading its static config before replaying its journal.
            let mut restarted = ClaimBook::new(
                Some(signer as Arc<dyn Signer>),
                HashMap::new(),
                HashMap::new(),
            );
            restarted.set_outbound_channel("peer-b", out_channel.clone());
            restarted
                .set_channel_domain(out_channel.clone(), test_domain())
                .unwrap();
            restarted
                .set_channel_domain(in_channel.clone(), test_domain())
                .unwrap();
            let divergences = restarted
                .set_journal(Arc::new(FileJournal::open(&path).unwrap()))
                .unwrap();

            assert!(divergences.is_empty());
            // The outbound debt to peer-b survived, re-armed with a fresh
            // signature over the same nonce/cumulative amount -- resendable
            // with no manual repair.
            let pending = restarted.pending_claim("peer-b").expect("still pending");
            assert_eq!(pending.nonce, 2);
            assert_eq!(pending.cumulative_amount, 150);
            // The inbound watermark and remaining exposure on channel-in
            // survived too: 70 delivered, 40 claimed, 30 still exposed.
            assert_eq!(restarted.exposure(&in_channel), 30);
        }

        #[test]
        fn a_claim_accepted_beyond_what_was_ever_recorded_delivered_is_a_reported_divergence() {
            let peer_signer = LocalSigner::generate("peer-key");
            let mut book = ClaimBook::new(
                None,
                HashMap::new(),
                HashMap::from([(
                    channel_id(1),
                    derive_evm_address(&peer_signer.public_key().unwrap()),
                )]),
            );
            book.set_channel_domain(channel_id(1), test_domain())
                .unwrap();
            book.set_journal(Arc::new(InMemoryJournal::new())).unwrap();
            book.record_inbound_delivery(&channel_id(1), 10);
            let claim = sign_claim(&peer_signer, &channel_id(1), 1, 999);
            assert_eq!(book.accept_inbound(&claim), ClaimAckOutcome::Accepted);
            let entries = book.journal.read_all().unwrap();

            // Rebuilding a fresh book from that same (divergent) journal
            // reports it rather than absorbing it silently.
            let mut rebuilt = ClaimBook::new(None, HashMap::new(), HashMap::new());
            let journal = InMemoryJournal::new();
            for entry in entries {
                journal.append(&entry).unwrap();
            }
            let divergences = rebuilt.set_journal(Arc::new(journal)).unwrap();

            assert_eq!(
                divergences,
                vec![ProjectionDivergence::ClaimedExceedsFulfilled {
                    channel_id: channel_id(1),
                    claimed: 999,
                    fulfilled: 10,
                }]
            );
        }
    }
}
