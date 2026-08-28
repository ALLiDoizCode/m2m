//! The **outbound client ledger** (issue #873): what this node needs to pay
//! a next hop it has no matched credential with, as an ordinary client of
//! that hop.
//!
//! # Two ledgers, and why they must never merge
//!
//! A connector keeps two entirely separate books, and the whole hazard in
//! this file is that they look similar enough to be confused:
//!
//! | | [`crate::ClaimBook`] -- the INBOUND journal | this module -- the OUTBOUND client ledger |
//! | --- | --- | --- |
//! | what it records | claims this node **received** and verified | claims this node **signs and hands to somebody else** |
//! | who is the authority | this node -- it judges what it accepted | **the receiver** -- it judges what it accepted |
//! | keyed by | channel | **next-hop peer id** |
//! | durability | append-only `JournalEntry` file under `state_dir` | its own file, never the journal's |
//!
//! `refuse_if_a_second_process_would_fork_the_ledger` in `connector-cli`'s
//! `announce` module exists precisely because those two books must not
//! become one, and nothing here weakens it: this ledger never appends a
//! [`connector_domain::JournalEntry`], never opens the journal's path, and
//! its file-backed form is opened by the long-lived serving process only
//! (see [`OutboundClientLedger::in_memory`] for the one-shot case and why
//! it deliberately keeps no file at all).
//!
//! # The watermark authority is the receiver
//!
//! A claim's cumulative amount comes from [`ClaimStateSource::watermark`]
//! -- the receiver answering "where do this sender's claims on this channel
//! stand". It is **never** taken from anything this node remembers. A claim
//! whose nonce does not advance the receiver's record is refused as a
//! replay; one whose cumulative amount sits below its record is refused
//! too. So a payer that remembered locally would still have to reconcile,
//! and a payer that guessed would either replay (refused, free) or overpay
//! (accepted, silent) -- and only one of those is survivable.
//!
//! # What the local side is for, then
//!
//! Exactly one number, and only for one failure mode: the **nonce floor**.
//!
//! Between signing a claim and the receiver recording it there is a window.
//! A claim signed in that window and then lost -- the process restarted,
//! the packet timed out, the far side answered and the answer never
//! arrived -- leaves the receiver's watermark where it was, so a fresh
//! process asking again would be told nonce N and would sign N+1 a second
//! time, with a different cumulative amount. That is a fork of the sender's
//! own nonce line, and the counterparty resolves it by refusing one of the
//! two as a replay.
//!
//! So this ledger persists, per next hop, the highest nonce it has ever
//! **issued**, and the next claim's nonce is
//! `max(receiver.nonce, issued_floor) + 1`. The cumulative amount still
//! comes from the receiver and only from the receiver. A restart therefore
//! cannot reuse or replay a nonce, and the receiver stays the authority on
//! what is owed.
//!
//! Keyed by next-hop peer id rather than by channel on purpose: one hop
//! reached over several routes is still one nonce line, and a ledger keyed
//! by channel would fork the moment a second route to the same hop was
//! configured.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use connector_domain::x402::X402PaymentRequired;
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, evm_claim_state_challenge_digest,
    solana_balance_proof_message, solana_claim_state_challenge_message, to_hex, Ed25519Signer,
    EvmBalanceProof, EvmClaimStateChallenge, Signer,
};
use thiserror::Error;

use crate::claim::ClaimSignature;

/// How long a `POST /ilp/claim-state` challenge is valid for. Short: it is
/// signed and used in the same round trip, and a challenge is a capability
/// to read a channel's state.
const CLAIM_STATE_CHALLENGE_TTL_SECS: u64 = 60;

/// The two facts a client claim's signature is bound to, taken from the
/// RECEIVER's own greeting rather than from this node's settlement section.
///
/// This is not a convenience. `claim_state.rs`'s `resolve_evm` builds its
/// challenge domain from the channel as **that node** resolved it, and its
/// claim gate (`crates/connector-client-edge/src/claim_gate.rs`) recovers a
/// claim's signer under the same domain -- so a claim signed under this
/// node's idea of the domain verifies to a different address and is
/// refused. The greeting is the receiver saying which `TokenNetwork` it
/// judges by, and it is the only correct source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvmDomain {
    pub chain_id: u64,
    pub token_network: [u8; 20],
}

impl EvmDomain {
    /// The domain a receiver's own x402 greeting names (issue #875), read
    /// from the `extra.settlement`/`extra.settlements` facts issue #617/#632
    /// put there.
    ///
    /// `None` when the greeting names no EVM settlement, or names one this
    /// connector cannot read -- `chain` that is not `evm:<decimal chainId>`,
    /// or a `tokenNetwork` that is not a 20-byte hex address. Refused rather
    /// than defaulted: a claim signed under a guessed domain recovers to a
    /// different address and is refused at the far gate, with the packet
    /// already spent getting there.
    pub fn from_greeting(terms: &X402PaymentRequired) -> Option<EvmDomain> {
        let settlement = terms.evm_settlement()?;
        let chain_id = settlement.chain.strip_prefix("evm:")?.parse().ok()?;
        Some(EvmDomain {
            chain_id,
            token_network: decode_address(&settlement.token_network)?,
        })
    }
}

/// `0x`-prefixed (or bare) 20-byte hex as an address, or `None` for
/// anything else.
fn decode_address(value: &str) -> Option<[u8; 20]> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    if value.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(value.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The settlement program a Solana channel lives under, raw 32 bytes
/// (issue #1146).
///
/// The Solana counterpart of [`EvmDomain`], and deliberately not folded
/// into it: ADR 0053 binds this program id into
/// [`connector_signer::solana_balance_proof_message`] the way ADR 0024's
/// EIP-712 domain separator binds `chain_id`/`token_network` -- so a claim
/// signed under one deployment does not verify against another. Before ADR
/// 0053 a Solana claim bound nothing about which chain it lived on, and the
/// separation came from program ids happening to differ between
/// deployments.
///
/// One field rather than two: there is no cluster here, and none is
/// invented. A Solana program knows its own id and nothing about which
/// cluster it runs on, so a cluster string could never be rebuilt on chain
/// to compare against -- `claim_signature.rs` documents that at length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolanaDomain {
    pub program_id: [u8; 32],
}

/// Which chain a [`ClaimStateSource`] is being asked about, and the facts
/// that ask is bound to (issue #1146).
///
/// The EVM variant carries the channel's own EIP-712 domain because the
/// challenge digest is computed under it -- `claim_state.rs`'s `resolve_evm`
/// rebuilds the same digest from the channel as **it** resolved it, so a
/// challenge signed under a different domain recovers to a different address
/// and is refused.
///
/// The Solana variant carries **nothing**, and that is not an omission.
/// [`connector_signer::solana_claim_state_challenge_message`] covers a fixed
/// domain tag, the channel account and the expiry, and the far side's
/// `resolve_solana` verifies exactly those -- so there is no Solana domain
/// for an ask to be bound to, and inventing one here would be a second thing
/// to keep in step with a verifier that never reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimStateDomain {
    Evm(EvmDomain),
    Solana,
}

/// The key this node signs a `POST /ilp/claim-state` challenge with, in
/// whichever scheme the channel's chain verifies (issue #1146).
///
/// Always the **settlement** key of the channel's on-chain participant, on
/// either curve: the challenge is a proof of control over that participant,
/// which is the only thing that entitles a caller to read the channel's
/// state at all.
#[derive(Clone)]
pub enum ClaimStateChallengeSigner {
    Evm(Arc<dyn Signer>),
    Solana(Arc<dyn Ed25519Signer>),
}

/// What a covering claim's signature is bound to, and the key that produces
/// it (issue #1146).
///
/// One enum carrying both halves rather than a domain and a signer passed
/// side by side: pairing a secp256k1 key with a Solana program id (or the
/// reverse) is not a thing this connector should be able to express. A claim
/// signed under a binding nobody wrote recovers to a different key and is
/// refused at the far gate with the packet already paid for -- the same
/// property `deny_unknown_fields` holds on every money-shaped config table.
pub enum OutboundClaimBinding<'a> {
    Evm {
        /// The RECEIVER's EIP-712 domain -- see [`EvmDomain`] for why it
        /// cannot be this node's own.
        domain: EvmDomain,
        signer: &'a dyn Signer,
    },
    Solana {
        /// `[settlement.solana] program_id`, base58-decoded. Unlike the EVM
        /// domain this IS read from local config rather than from the
        /// receiver: since issue #1128 there is exactly one program a node
        /// can redeem a Solana claim under, so a payer and a payee that
        /// disagreed about it would have no channel in common to begin with.
        program_id: [u8; 32],
        signer: &'a dyn Ed25519Signer,
    },
}

impl OutboundClaimBinding<'_> {
    /// The ask this binding implies -- what [`ClaimStateSource::watermark`]
    /// is handed, derived from the binding rather than passed beside it so
    /// the chain a claim is signed on and the chain its watermark was asked
    /// about can never be two different answers.
    pub fn claim_state_domain(&self) -> ClaimStateDomain {
        match self {
            OutboundClaimBinding::Evm { domain, .. } => ClaimStateDomain::Evm(*domain),
            OutboundClaimBinding::Solana { .. } => ClaimStateDomain::Solana,
        }
    }
}

/// Where a channel's watermark stands, according to the node that judges it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimWatermark {
    /// The last nonce this receiver accepted; the next claim must exceed it.
    pub nonce: u64,
    /// What this receiver has already accepted cumulatively on the channel.
    pub cumulative: u128,
    /// Spendable headroom (`deposit - claimed + credited`), or `None` for a
    /// declared channel that names no amount.
    pub available: Option<u128>,
}

/// Everything that can stop this node paying a next hop as a client, each
/// named for what an operator has to change.
#[derive(Debug, Error)]
pub enum OutboundClientError {
    /// The receiver would not say where this node's claims on the channel
    /// stand, so there is no watermark to advance and nothing safe to sign.
    #[error(
        "the receiver would not report the claim state of channel {channel}: {reason} -- usual \
         causes: the channel id is not one this node's settlement address participates in, the \
         far side does not know the channel yet, or its claim-state endpoint is not reachable"
    )]
    ClaimStateUnavailable { channel: String, reason: String },
    /// The channel has less headroom left than the packet costs. Refused
    /// here rather than bought: a claim above what has actually been
    /// deposited could never be redeemed on chain, so the far side declines
    /// it (issue #646) -- and this way the operator is told the number.
    #[error(
        "channel {channel} has {available} base units of headroom left, which does not cover the \
         {amount} this packet costs -- deposit more into the channel, or settle what is \
         outstanding on it"
    )]
    InsufficientHeadroom {
        channel: String,
        available: u128,
        amount: u64,
    },
    /// The settlement key could not sign. A configuration or key-material
    /// failure, never a protocol one.
    #[error("could not sign the outbound claim: {0}")]
    Signing(String),
    /// The nonce floor could not be made durable. Refused rather than
    /// signed: a claim issued from a floor that did not reach the disk is
    /// exactly the claim a restart would reissue.
    #[error(
        "the outbound client ledger at {path} could not be written: {reason} -- refusing to sign \
         a claim whose nonce could be reissued after a restart"
    )]
    LedgerUnwritable { path: PathBuf, reason: String },
}

/// The receiver, asked where this node's claims on a channel stand.
///
/// A port rather than a function so the forwarding path can ask a next hop
/// over whichever carriage it already holds, and so a test can stand a real
/// answering node in front of it. [`HttpClaimState`] is the implementation
/// every deployed path uses today.
#[async_trait]
pub trait ClaimStateSource: Send + Sync {
    async fn watermark(
        &self,
        channel: &[u8; 32],
        domain: &ClaimStateDomain,
    ) -> Result<ClaimWatermark, OutboundClientError>;
}

/// Ask a client edge's `POST /ilp/claim-state` (issue #693) where this
/// node's own claims on a channel stand.
///
/// Authenticated per channel by a challenge signed with the same settlement
/// key the claim itself is signed with -- an EIP-712 digest on EVM, an
/// ed25519 message on Solana (issue #1146), and in both cases a *different*
/// message from a balance proof on purpose, so a captured challenge is not
/// replayable as a payment. The Solana pair are kept apart by domain tag
/// rather than by length alone; `claim_state_challenge.rs` documents the
/// choice.
pub struct HttpClaimState<'a> {
    client: &'a reqwest::Client,
    /// The full `POST /ilp` endpoint of the receiver; `claim-state` hangs
    /// off it as a sub-path.
    edge_url: String,
    signer: &'a ClaimStateChallengeSigner,
}

impl<'a> HttpClaimState<'a> {
    pub fn new(
        client: &'a reqwest::Client,
        edge_url: impl Into<String>,
        signer: &'a ClaimStateChallengeSigner,
    ) -> HttpClaimState<'a> {
        HttpClaimState {
            client,
            edge_url: edge_url.into(),
            signer,
        }
    }
}

#[async_trait]
impl ClaimStateSource for HttpClaimState<'_> {
    async fn watermark(
        &self,
        channel: &[u8; 32],
        domain: &ClaimStateDomain,
    ) -> Result<ClaimWatermark, OutboundClientError> {
        // How the channel is named in the ask and in every error out of
        // it: `0x` hex for EVM, base58 for Solana -- the same disjoint
        // spellings the two claim namespaces are already kept apart by.
        let channel_named = match domain {
            ClaimStateDomain::Evm(_) => format!("0x{}", hex_encode(channel)),
            ClaimStateDomain::Solana => bs58::encode(channel).into_string(),
        };
        let url = format!("{}/claim-state", self.edge_url.trim_end_matches('/'));
        let expires = now_secs() + CLAIM_STATE_CHALLENGE_TTL_SECS;
        let failed = |reason: String| OutboundClientError::ClaimStateUnavailable {
            channel: channel_named.clone(),
            reason,
        };

        // One ask per chain, each built to exactly what the far side's own
        // verifier reads (`connector_client_edge::claim_state`): EVM sends
        // `channelId` and a 65-byte `r ‖ s ‖ v` as `0x` hex, Solana sends
        // `channelAccount` and a 64-byte ed25519 signature as base64.
        let request = match (domain, self.signer) {
            (ClaimStateDomain::Evm(domain), ClaimStateChallengeSigner::Evm(signer)) => {
                let digest = evm_claim_state_challenge_digest(&EvmClaimStateChallenge {
                    channel_id: *channel,
                    expires,
                    chain_id: domain.chain_id,
                    token_network_address: domain.token_network,
                });
                let signature = signer
                    .sign(&digest)
                    .map_err(|error| failed(error.to_string()))?
                    .to_bytes();
                serde_json::json!({
                    "channels": [{
                        "blockchain": "evm",
                        "channelId": channel_named,
                        "expires": expires,
                        "signature": format!("0x{}", hex_encode(&signature)),
                    }]
                })
            }
            (ClaimStateDomain::Solana, ClaimStateChallengeSigner::Solana(signer)) => {
                let message = solana_claim_state_challenge_message(channel, expires);
                let signature = signer.sign(&message);
                serde_json::json!({
                    "channels": [{
                        "blockchain": "solana",
                        "channelAccount": channel_named,
                        "expires": expires,
                        "signature": BASE64.encode(signature),
                    }]
                })
            }
            // Unreachable through any wired path -- a hop's domain and its
            // challenge signer are chosen together, per `[[pay_channels]]`
            // row, in `connector_cli::runtime`. Refused rather than
            // defaulted anyway: signing a challenge on the wrong curve
            // would be answered `unverified` by the far side, and "the
            // receiver would not report" is a much worse description of
            // this than naming it.
            _ => {
                return Err(failed(
                    "this node's claim-state challenge signer is not on the same chain as the \
                     channel it was asked about"
                        .to_string(),
                ))
            }
        };
        let body: serde_json::Value = self
            .client
            .post(&url)
            .json(&request)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| failed(error.to_string()))?
            .json()
            .await
            .map_err(|error| failed(error.to_string()))?;

        let entry = body["channels"]
            .get(0)
            .ok_or_else(|| failed(format!("no answer for the channel asked about: {body}")))?;
        if entry["ok"] != serde_json::Value::Bool(true) {
            // The endpoint collapses every refusal to one generic reason on
            // purpose (a caller must learn nothing about a channel it does
            // not control), so there is nothing more specific to report
            // here -- hence the long "usual causes" on the error itself.
            return Err(failed(format!(
                "answered ok=false ({})",
                entry["error"].as_str().unwrap_or("no reason given")
            )));
        }
        Ok(ClaimWatermark {
            nonce: entry["nonce"]
                .as_u64()
                .ok_or_else(|| failed(format!("no nonce in the answer: {entry}")))?,
            cumulative: entry["cumulativeClaimed"]
                .as_str()
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| failed(format!("no cumulativeClaimed in the answer: {entry}")))?,
            available: entry["available"]
                .as_str()
                .and_then(|value| value.parse().ok()),
        })
    }
}

/// [`HttpClaimState`] for a caller that has to **hold** one rather than
/// build it per call (issue #881).
///
/// A [`crate::Connector`] keeps its client-role hops for the life of the
/// process, in an `Arc<dyn ClaimStateSource>` -- which cannot borrow a
/// stack-local [`reqwest::Client`] and [`Signer`] the way the one-shot
/// `connector announce` path does. Everything about the ask is
/// [`HttpClaimState`]'s and this owns rather than reimplements it: one
/// `POST /ilp/claim-state`, one challenge digest, one parse of the answer,
/// so a serving node and a one-shot announce cannot drift into asking the
/// same question two ways.
pub struct OwnedHttpClaimState {
    client: reqwest::Client,
    edge_url: String,
    signer: ClaimStateChallengeSigner,
}

impl OwnedHttpClaimState {
    /// `edge_url` is the receiver's full `POST /ilp` endpoint --
    /// `claim-state` hangs off it as a sub-path -- and `signer` is the
    /// settlement key the claim itself will be signed with, on the
    /// channel's own chain, since the challenge proves control of the
    /// channel's on-chain participant.
    pub fn new(
        client: reqwest::Client,
        edge_url: impl Into<String>,
        signer: ClaimStateChallengeSigner,
    ) -> OwnedHttpClaimState {
        OwnedHttpClaimState {
            client,
            edge_url: edge_url.into(),
            signer,
        }
    }
}

#[async_trait]
impl ClaimStateSource for OwnedHttpClaimState {
    async fn watermark(
        &self,
        channel: &[u8; 32],
        domain: &ClaimStateDomain,
    ) -> Result<ClaimWatermark, OutboundClientError> {
        HttpClaimState::new(&self.client, &self.edge_url, &self.signer)
            .watermark(channel, domain)
            .await
    }
}

/// A claim this node signed for exactly one packet to one next hop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundClaim {
    /// The nonce it was issued at -- strictly above both the receiver's
    /// record and every nonce this ledger has issued before.
    pub nonce: u64,
    /// The receiver's cumulative record advanced by exactly the amount.
    pub cumulative: u128,
    /// What the receiver reported, carried back so a caller can log or act
    /// on the headroom it saw.
    pub watermark: ClaimWatermark,
    /// The claim JSON, ready for the `ilp-payment-channel-claim` header or
    /// a BTP frame's protocol data.
    pub json: String,
    /// The balance-proof signature the JSON above carries, kept in its
    /// decoded form (issue #875) so a caller that has to put this claim on a
    /// carriage taking `crate::WireClaim` -- the forwarding path's
    /// `PeerTransport` port -- does not have to parse back the JSON this
    /// module just wrote. Discriminated by scheme (issue #1146): a
    /// secp256k1 `r ‖ s ‖ v` for an EVM channel, a 64-byte ed25519
    /// signature for a Solana one, kept apart for the whole of their travel
    /// exactly as [`ClaimSignature`]'s own doc requires.
    pub signature: ClaimSignature,
}

/// This node's outbound claims, one nonce line per next hop.
///
/// See the module header for the two-ledger rule and for why the only
/// locally remembered number is the nonce floor.
pub struct OutboundClientLedger {
    /// The highest nonce issued to each next hop, replayed from `path` at
    /// open and advanced in step with it.
    floors: Mutex<BTreeMap<String, u64>>,
    /// `None` for the in-memory form -- see [`OutboundClientLedger::in_memory`].
    path: Option<PathBuf>,
}

impl OutboundClientLedger {
    /// A ledger that remembers nothing across a restart, and is therefore
    /// bound entirely by what the receiver reports.
    ///
    /// This is the right shape for a **one-shot** payer -- `connector
    /// announce` is one -- and not a lesser version of the file-backed
    /// form. A one-shot process has no restart to survive: it signs at most
    /// one claim in its whole life, and the next invocation asks the
    /// receiver again from scratch. Giving it a file under `state_dir`
    /// would put a second writer beside a running node's own money state,
    /// which is exactly the fork
    /// `refuse_if_a_second_process_would_fork_the_ledger` exists to refuse
    /// -- and that guard does not cover the client path, because until now
    /// the client path wrote nothing.
    pub fn in_memory() -> OutboundClientLedger {
        OutboundClientLedger {
            floors: Mutex::new(BTreeMap::new()),
            path: None,
        }
    }

    /// A ledger backed by `path`, replaying whatever an earlier run of the
    /// **same** long-lived process left there.
    ///
    /// `path` must not be either journal file: this book is not a
    /// [`connector_domain::JournalEntry`] stream and nothing replaying the
    /// journal would understand it -- see the module header's table.
    ///
    /// A missing file is an empty ledger, not an error: a node paying a
    /// next hop for the first time has issued no nonces. A file that exists
    /// but cannot be read IS an error, because "no floor" and "a floor this
    /// process could not see" are the same on the wire and only one of them
    /// is safe.
    pub fn open(path: impl AsRef<Path>) -> Result<OutboundClientLedger, OutboundClientError> {
        let path = path.as_ref().to_path_buf();
        let mut floors: BTreeMap<String, u64> = BTreeMap::new();
        match std::fs::File::open(&path) {
            Ok(file) => {
                for line in BufReader::new(file).lines() {
                    let line = line.map_err(|error| OutboundClientError::LedgerUnwritable {
                        path: path.clone(),
                        reason: error.to_string(),
                    })?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    let record: IssuedNonce = serde_json::from_str(&line).map_err(|error| {
                        OutboundClientError::LedgerUnwritable {
                            path: path.clone(),
                            reason: format!("corrupt entry '{line}': {error}"),
                        }
                    })?;
                    let floor = floors.entry(record.next_hop).or_insert(0);
                    *floor = (*floor).max(record.nonce);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(OutboundClientError::LedgerUnwritable {
                    path,
                    reason: error.to_string(),
                })
            }
        }
        Ok(OutboundClientLedger {
            floors: Mutex::new(floors),
            path: Some(path),
        })
    }

    /// The highest nonce this ledger has issued to `next_hop`, or 0 for a
    /// next hop it has never paid.
    pub fn issued_nonce(&self, next_hop: &str) -> u64 {
        self.floors
            .lock()
            .expect("outbound client ledger lock poisoned")
            .get(next_hop)
            .copied()
            .unwrap_or(0)
    }

    /// Sign the next claim to `next_hop` for exactly `amount`.
    ///
    /// The order here is the contract, not an implementation detail:
    ///
    ///   1. **ask the receiver** where the channel stands -- it is the
    ///      authority on its own watermark, and nothing local substitutes
    ///      for the answer;
    ///   2. **refuse** rather than sign when the reported headroom does not
    ///      cover the packet;
    ///   3. **record the nonce durably** before the claim exists, so a
    ///      crash between signing and sending can only ever skip a nonce,
    ///      never reissue one;
    ///   4. **sign**.
    ///
    /// `binding` carries both halves of the chain-specific question -- what
    /// the signature is bound to and the key that produces it -- so they can
    /// never disagree. On EVM that is the RECEIVER's EIP-712 domain (see
    /// [`EvmDomain`] for why it cannot be this node's own) and the
    /// settlement key of the channel's on-chain participant; on Solana
    /// (issue #1146) it is `[settlement.solana] program_id`, which ADR 0053
    /// signs into the message, and that table's ed25519 key.
    pub async fn next_claim(
        &self,
        next_hop: &str,
        receiver: &dyn ClaimStateSource,
        channel: &[u8; 32],
        binding: &OutboundClaimBinding<'_>,
        amount: u64,
    ) -> Result<OutboundClaim, OutboundClientError> {
        let watermark = receiver
            .watermark(channel, &binding.claim_state_domain())
            .await?;
        if let Some(available) = watermark.available {
            if available < u128::from(amount) {
                return Err(OutboundClientError::InsufficientHeadroom {
                    channel: name_channel(channel, binding),
                    available,
                    amount,
                });
            }
        }
        let nonce = self.reserve_nonce(next_hop, watermark.nonce)?;
        let cumulative = watermark.cumulative + u128::from(amount);
        let (json, signature) = claim_json(channel, binding, nonce, cumulative)?;
        Ok(OutboundClaim {
            nonce,
            cumulative,
            watermark,
            json,
            signature,
        })
    }

    /// The next nonce for `next_hop`, made durable before it is returned.
    ///
    /// `max` of what the receiver reported and what this ledger has already
    /// issued: the receiver is ahead whenever a claim landed and this
    /// process has forgotten it, and this ledger is ahead whenever a claim
    /// was issued and never landed. Both are normal, and taking the higher
    /// of the two is the only choice that neither replays nor stalls.
    fn reserve_nonce(
        &self,
        next_hop: &str,
        receiver_nonce: u64,
    ) -> Result<u64, OutboundClientError> {
        let mut floors = self
            .floors
            .lock()
            .expect("outbound client ledger lock poisoned");
        let floor = floors.get(next_hop).copied().unwrap_or(0);
        let nonce = floor.max(receiver_nonce) + 1;
        if let Some(path) = &self.path {
            append_durably(
                path,
                &IssuedNonce {
                    next_hop: next_hop.to_string(),
                    nonce,
                },
            )?;
        }
        floors.insert(next_hop.to_string(), nonce);
        Ok(nonce)
    }
}

/// One line of the ledger file: "this node issued nonce N to this next
/// hop". Append-only and replayed by taking the maximum per hop, which
/// makes a torn tail lose the newest line rather than corrupt the book --
/// and losing the newest line can only skip a nonce, which is safe.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssuedNonce {
    next_hop: String,
    nonce: u64,
}

/// Append `record` to `path` and return only once it is on the disk -- the
/// same contract [`crate::Journal::append`] holds, for the same reason: a
/// caller treats value as moved once this returns.
fn append_durably(path: &Path, record: &IssuedNonce) -> Result<(), OutboundClientError> {
    let failed = |reason: String| OutboundClientError::LedgerUnwritable {
        path: path.to_path_buf(),
        reason,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| failed(error.to_string()))?;
    }
    let mut line = serde_json::to_string(record).map_err(|error| failed(error.to_string()))?;
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| failed(error.to_string()))?;
    file.write_all(line.as_bytes())
        .map_err(|error| failed(error.to_string()))?;
    file.sync_all().map_err(|error| failed(error.to_string()))
}

/// How a channel is named in a message to an operator, in the spelling its
/// own chain uses (`0x` hex for EVM, base58 for Solana). The two namespaces
/// are already kept apart by exactly this difference in spelling.
fn name_channel(channel: &[u8; 32], binding: &OutboundClaimBinding<'_>) -> String {
    match binding {
        OutboundClaimBinding::Evm { .. } => format!("0x{}", hex_encode(channel)),
        OutboundClaimBinding::Solana { .. } => bs58::encode(channel).into_string(),
    }
}

/// The client-edge claim JSON, signed through this workspace's PRODUCTION
/// signing path -- `Signer::sign` + `Signature::to_bytes` on EVM (whose byte
/// 64 is libsecp256k1's raw recovery id in `{0,1}`; deliberately no `+27`,
/// since issues #590/#591 moved that normalisation to the settlement
/// boundary and pre-shifting it here would be a second implementation of a
/// rule that already has one), and `Ed25519Signer::sign` over
/// [`connector_signer::solana_balance_proof_message`] on Solana.
///
/// One function with two arms rather than two functions: the fields that
/// are not chain-specific -- the version, the message id, the `Z`-suffixed
/// timestamp, the decimal `transferredAmount` -- are the same claim shape
/// (`client-edge-spec.md` §1.3) on both chains, and a second copy of them
/// is a second place for the far gate's structural validator to be drifted
/// away from.
fn claim_json(
    channel: &[u8; 32],
    binding: &OutboundClaimBinding<'_>,
    nonce: u64,
    cumulative: u128,
) -> Result<(String, ClaimSignature), OutboundClientError> {
    let mut json = serde_json::json!({
        "version": "1.0",
        "messageId": format!("connector-announce-{nonce}"),
        // `Z`, not `+00:00`. The claim gate refuses a `+00:00` offset by
        // name -- "'timestamp' must be ISO 8601 with a 'Z' timezone" -- and
        // `chrono`'s plain `to_rfc3339()` produces exactly the spelling it
        // rejects.
        "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "nonce": nonce,
        "transferredAmount": cumulative.to_string(),
    });
    let object = json.as_object_mut().expect("a json! object");
    let signature = match binding {
        OutboundClaimBinding::Evm { domain, signer } => {
            let proof = EvmBalanceProof {
                channel_id: *channel,
                nonce,
                transferred_amount: cumulative,
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: domain.chain_id,
                token_network_address: domain.token_network,
            };
            let signature = signer
                .sign(&evm_balance_proof_digest(&proof))
                .map_err(|error| OutboundClientError::Signing(error.to_string()))?;
            let address = derive_evm_address(
                &signer
                    .public_key()
                    .map_err(|error| OutboundClientError::Signing(error.to_string()))?,
            );
            let address = to_hex(&address);
            object.insert("blockchain".to_string(), "evm".into());
            object.insert("senderId".to_string(), address.clone().into());
            object.insert(
                "channelId".to_string(),
                format!("0x{}", hex_encode(channel)).into(),
            );
            object.insert("lockedAmount".to_string(), "0".into());
            object.insert(
                "locksRoot".to_string(),
                format!("0x{}", "0".repeat(64)).into(),
            );
            object.insert(
                "signature".to_string(),
                format!("0x{}", hex_encode(&signature.to_bytes())).into(),
            );
            object.insert("signerAddress".to_string(), address.into());
            object.insert("chainId".to_string(), domain.chain_id.into());
            object.insert(
                "tokenNetworkAddress".to_string(),
                to_hex(&domain.token_network).into(),
            );
            ClaimSignature::Evm(signature)
        }
        OutboundClaimBinding::Solana { program_id, signer } => {
            // ADR 0053's 96 bytes: the domain tag, the PROGRAM ID, the
            // channel account, the nonce and the cumulative amount. The
            // program id is what makes this signature specific to one
            // deployment -- before it, a Solana claim was valid for its
            // account on every cluster the account existed on.
            let signature = signer.sign(&solana_balance_proof_message(
                program_id,
                channel,
                nonce,
                // A Solana balance proof signs a `u64`, and the whole wire
                // carries `transferredAmount` as one (§4.2). Refused rather
                // than truncated: a claim signed for a wrapped-around
                // amount is a claim for less money than the packet cost,
                // accepted and silently short.
                u64::try_from(cumulative).map_err(|_| {
                    OutboundClientError::Signing(format!(
                        "the claim's cumulative amount {cumulative} does not fit the uint64 a \
                         Solana balance proof signs over"
                    ))
                })?,
            ));
            let signer_public_key = bs58::encode(signer.public_key()).into_string();
            object.insert("blockchain".to_string(), "solana".into());
            object.insert("senderId".to_string(), signer_public_key.clone().into());
            object.insert(
                "programId".to_string(),
                bs58::encode(program_id).into_string().into(),
            );
            object.insert(
                "channelAccount".to_string(),
                bs58::encode(channel).into_string().into(),
            );
            object.insert("signature".to_string(), BASE64.encode(signature).into());
            object.insert("signerPublicKey".to_string(), signer_public_key.into());
            // Deliberately no `cluster`: it is an optional routing hint the
            // far gate compares against its own `[settlement.solana]
            // rpc_url` (issue #975/#976), never a security boundary, and a
            // covering payer that guessed one would have its claim refused
            // for a mismatch it invented. ADR 0053 put the binding that
            // matters -- the program id -- inside the signature instead.
            ClaimSignature::Solana(signature)
        }
    };
    Ok((
        serde_json::to_string(&json).expect("a json! object always serializes"),
        signature,
    ))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use connector_signer::{
        verify_evm_balance_proof, verify_solana_balance_proof, verify_solana_claim_state_challenge,
        LocalEd25519Signer, LocalSigner,
    };
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response, Server};

    use super::*;

    const DOMAIN: EvmDomain = EvmDomain {
        chain_id: 84_532,
        token_network: [0x1eu8; 20],
    };
    const CHANNEL: [u8; 32] = [0x5cu8; 32];
    /// The Solana half of the pair: a channel ACCOUNT, deliberately a
    /// different 32 bytes so a test that mixed the two would fail rather
    /// than pass by coincidence.
    const CHANNEL_ACCOUNT: [u8; 32] = [0x7au8; 32];
    /// The settlement program a Solana claim is signed under (ADR 0053).
    const PROGRAM_ID: [u8; 32] = [0x3bu8; 32];
    /// The peer id of the next hop under test. A real one from this fleet,
    /// so nothing here reads as a placeholder.
    const NEXT_HOP: &str = "apex-store";

    fn claim_signer() -> LocalSigner {
        LocalSigner::from_secret_bytes("outbound-claim-test", [23u8; 32]).expect("signer")
    }

    /// The Solana settlement key this node would sign a covering claim --
    /// and the claim-state challenge for it -- with.
    fn solana_claim_signer() -> LocalEd25519Signer {
        LocalEd25519Signer::from_secret_bytes([29u8; 32]).expect("signer")
    }

    fn evm_challenge_signer() -> ClaimStateChallengeSigner {
        ClaimStateChallengeSigner::Evm(Arc::new(claim_signer()))
    }

    fn solana_challenge_signer() -> ClaimStateChallengeSigner {
        ClaimStateChallengeSigner::Solana(Arc::new(solana_claim_signer()))
    }

    fn evm_binding(signer: &LocalSigner) -> OutboundClaimBinding<'_> {
        OutboundClaimBinding::Evm {
            domain: DOMAIN,
            signer,
        }
    }

    fn solana_binding(signer: &LocalEd25519Signer) -> OutboundClaimBinding<'_> {
        OutboundClaimBinding::Solana {
            program_id: PROGRAM_ID,
            signer,
        }
    }

    /// A real receiver: an HTTP server answering `POST /ilp/claim-state`
    /// exactly as a client edge does, from a watermark the test sets. Not a
    /// mock -- the code under test dials it, signs a real challenge, and
    /// parses a real answer.
    ///
    /// It **verifies the challenge** before answering, on either chain,
    /// through the same `connector_signer` functions
    /// `connector_client_edge::claim_state` calls (issue #1146). That is
    /// what makes the ask itself under test rather than only the parse of
    /// the answer: a challenge signed over the wrong message, or encoded
    /// the wrong way, comes back `ok: false` here exactly as it would from
    /// a deployed payee.
    struct Receiver {
        url: String,
        nonce: Arc<AtomicU64>,
        cumulative: Arc<AtomicU64>,
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    }

    /// The far side's own verification of one asked-about channel, and the
    /// answer it produces. Returns `None` for a request this receiver
    /// cannot read at all, which is the same "answered nothing" a caller
    /// must survive.
    fn answer_claim_state(body: &[u8], nonce: u64, cumulative: u64) -> serde_json::Value {
        let request: serde_json::Value = match serde_json::from_slice(body) {
            Ok(request) => request,
            Err(_) => return serde_json::json!({ "channels": [] }),
        };
        let entry = &request["channels"][0];
        let expires = entry["expires"].as_u64().unwrap_or(0);
        let verified = match entry["blockchain"].as_str() {
            Some("evm") => {
                let channel_id = entry["channelId"].as_str().unwrap_or_default();
                let signature = entry["signature"].as_str().unwrap_or_default();
                decode_hex_32(channel_id).is_some_and(|channel_id| {
                    connector_signer::verify_evm_claim_state_challenge(
                        &EvmClaimStateChallenge {
                            channel_id,
                            expires,
                            chain_id: DOMAIN.chain_id,
                            token_network_address: DOMAIN.token_network,
                        },
                        &decode_hex_65(signature),
                        &derive_evm_address(&claim_signer().public_key().expect("public key")),
                    )
                })
            }
            Some("solana") => {
                let account = entry["channelAccount"].as_str().unwrap_or_default();
                let signature = BASE64
                    .decode(entry["signature"].as_str().unwrap_or_default())
                    .unwrap_or_default();
                let account = bs58::decode(account).into_vec().unwrap_or_default();
                <[u8; 32]>::try_from(account).is_ok_and(|account| {
                    verify_solana_claim_state_challenge(
                        &account,
                        expires,
                        &signature,
                        &solana_claim_signer().public_key(),
                    )
                })
            }
            _ => false,
        };
        if !verified {
            return serde_json::json!({
                "channels": [{ "ok": false, "error": "unverified" }]
            });
        }
        serde_json::json!({
            "channels": [{
                "ok": true,
                "nonce": nonce,
                "cumulativeClaimed": cumulative.to_string(),
                "available": "1000000",
            }]
        })
    }

    impl Receiver {
        async fn start(nonce: u64, cumulative: u64) -> Receiver {
            let nonce = Arc::new(AtomicU64::new(nonce));
            let cumulative = Arc::new(AtomicU64::new(cumulative));
            let (state_nonce, state_cumulative) = (Arc::clone(&nonce), Arc::clone(&cumulative));
            let make = make_service_fn(move |_| {
                let nonce = Arc::clone(&state_nonce);
                let cumulative = Arc::clone(&state_cumulative);
                async move {
                    Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                        let nonce = nonce.load(Ordering::SeqCst);
                        let cumulative = cumulative.load(Ordering::SeqCst);
                        async move {
                            let body = hyper::body::to_bytes(request.into_body())
                                .await
                                .expect("a request body");
                            Ok::<_, Infallible>(Response::new(Body::from(
                                answer_claim_state(&body, nonce, cumulative).to_string(),
                            )))
                        }
                    }))
                }
            });
            let server = Server::bind(&SocketAddr::from(([127, 0, 0, 1], 0))).serve(make);
            let url = format!("http://{}/ilp", server.local_addr());
            let (shutdown, stop) = tokio::sync::oneshot::channel();
            tokio::spawn(server.with_graceful_shutdown(async {
                let _ = stop.await;
            }));
            Receiver {
                url,
                nonce,
                cumulative,
                shutdown: Some(shutdown),
            }
        }
    }

    impl Drop for Receiver {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }

    /// The whole point of this ledger's separation from
    /// [`crate::ClaimBook`]: the cumulative amount a claim carries is the
    /// RECEIVER's record advanced by the amount, whatever this node
    /// remembers.
    ///
    /// The local side is loaded with a much higher figure first -- the
    /// shape a local journal would have after claims the receiver never
    /// recorded -- and the claim still lands on the receiver's number. A
    /// ledger that had merged the two books would sign the local one and be
    /// refused at the far gate.
    #[tokio::test]
    async fn the_watermark_comes_from_the_receiver_and_not_from_anything_local() {
        let dir = tempfile::tempdir().expect("tempdir");
        let receiver = Receiver::start(41, 41_082).await;
        let client = reqwest::Client::new();
        let signer = claim_signer();
        let challenge = evm_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);

        let ledger =
            OutboundClientLedger::open(dir.path().join("outbound-client.log")).expect("open");
        // This first claim is what a local book would remember: nonce 42,
        // cumulative 42_084.
        let first = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 1_002)
            .await
            .expect("first claim");
        assert_eq!((first.nonce, first.cumulative), (42, 42_084));

        // The receiver now says it never recorded that claim -- it is still
        // at 41/41_082. The next claim must be priced off THAT, not off the
        // 42_084 this process last signed.
        let second = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 1_002)
            .await
            .expect("second claim");
        assert_eq!(
            second.cumulative, 42_084,
            "the cumulative amount must be the receiver's record advanced by the amount"
        );
        assert_eq!(second.watermark.nonce, 41);

        // ...and when the receiver DOES move, the claim follows it.
        receiver.nonce.store(100, Ordering::SeqCst);
        receiver.cumulative.store(100_200, Ordering::SeqCst);
        let third = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 1_002)
            .await
            .expect("third claim");
        assert_eq!((third.nonce, third.cumulative), (101, 101_202));
    }

    /// A restart must not reissue a nonce. The receiver's record stays put
    /// -- the claims signed before the restart never landed -- so a payer
    /// that trusted the receiver alone would sign nonce 42 twice, with two
    /// different cumulative amounts, and fork its own nonce line.
    #[tokio::test]
    async fn a_restart_never_reissues_a_nonce_the_receiver_has_not_seen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("outbound-client.log");
        let receiver = Receiver::start(41, 41_082).await;
        let client = reqwest::Client::new();
        let signer = claim_signer();
        let challenge = evm_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);

        let before = OutboundClientLedger::open(&path).expect("open");
        let mut issued = Vec::new();
        for _ in 0..3 {
            issued.push(
                before
                    .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 7)
                    .await
                    .expect("claim")
                    .nonce,
            );
        }
        assert_eq!(issued, vec![42, 43, 44]);
        drop(before);

        // The restart: a fresh ledger over the same file, against a
        // receiver that is still at 41.
        let after = OutboundClientLedger::open(&path).expect("reopen");
        assert_eq!(after.issued_nonce(NEXT_HOP), 44);
        let resumed = after
            .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 7)
            .await
            .expect("claim after restart");
        assert_eq!(
            resumed.nonce, 45,
            "a restart must resume above every nonce ever issued, not above the receiver's record"
        );
        assert!(
            issued.iter().all(|earlier| *earlier < resumed.nonce),
            "issued {issued:?} then {} after the restart",
            resumed.nonce
        );
    }

    /// The nonce line is per next hop, not per channel and not global: two
    /// hops paid over the same channel each keep their own.
    #[tokio::test]
    async fn each_next_hop_keeps_its_own_nonce_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let receiver = Receiver::start(0, 0).await;
        let client = reqwest::Client::new();
        let signer = claim_signer();
        let challenge = evm_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);
        let ledger =
            OutboundClientLedger::open(dir.path().join("outbound-client.log")).expect("open");

        for _ in 0..3 {
            ledger
                .next_claim("apex-store", &state, &CHANNEL, &evm_binding(&signer), 1)
                .await
                .expect("claim");
        }
        assert_eq!(ledger.issued_nonce("apex-store"), 3);
        assert_eq!(ledger.issued_nonce("apex-relay"), 0);
    }

    /// Headroom the receiver reports as too small is refused before
    /// anything is signed -- and the operator is told the two numbers
    /// (issue #646).
    #[tokio::test]
    async fn a_packet_bigger_than_the_reported_headroom_is_refused_not_signed() {
        let receiver = Receiver::start(0, 0).await;
        let client = reqwest::Client::new();
        let signer = claim_signer();
        let challenge = evm_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);
        let ledger = OutboundClientLedger::in_memory();

        let error = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &evm_binding(&signer), 2_000_000)
            .await
            .expect_err("a packet above the headroom must be refused");
        assert!(
            matches!(
                error,
                OutboundClientError::InsufficientHeadroom {
                    available: 1_000_000,
                    amount: 2_000_000,
                    ..
                }
            ),
            "{error}"
        );
        assert_eq!(
            ledger.issued_nonce(NEXT_HOP),
            0,
            "a refused packet must not consume a nonce"
        );
    }

    /// The claim this node emits is verified here the way the RECEIVER
    /// verifies it: recover the signer from the balance-proof digest and
    /// check it is the channel participant this node's settlement key
    /// derives. A claim that fails this is refused at the far gate with the
    /// packet already formed, so it is worth proving locally.
    #[test]
    fn the_claim_verifies_as_the_settlement_address_the_channel_is_opened_with() {
        let signer = claim_signer();
        let (json, _) =
            claim_json(&CHANNEL, &evm_binding(&signer), 7, 7_014).expect("sign a claim");
        let claim: serde_json::Value = serde_json::from_str(&json).expect("claim JSON");

        let expected = derive_evm_address(&signer.public_key().expect("public key"));
        assert_eq!(claim["signerAddress"], to_hex(&expected));
        assert_eq!(claim["senderId"], to_hex(&expected));
        assert_eq!(claim["nonce"], 7);
        assert_eq!(claim["transferredAmount"], "7014");
        assert_eq!(claim["chainId"], 84_532);
        assert_eq!(claim["tokenNetworkAddress"], to_hex(&DOMAIN.token_network));
        assert_eq!(claim["blockchain"], "evm");

        let signature = decode_hex_65(claim["signature"].as_str().expect("signature"));
        assert!(
            verify_evm_balance_proof(
                &EvmBalanceProof {
                    channel_id: CHANNEL,
                    nonce: 7,
                    transferred_amount: 7_014,
                    locked_amount: 0,
                    locks_root: [0u8; 32],
                    chain_id: DOMAIN.chain_id,
                    token_network_address: DOMAIN.token_network,
                },
                &signature,
                &expected,
            ),
            "the receiving claim gate must recover this node's own settlement address"
        );
    }

    /// `chrono`'s plain `to_rfc3339()` emits `+00:00`, which the claim gate
    /// refuses by name ("'timestamp' must be ISO 8601 with a 'Z' timezone").
    /// Cheap to hit, free to learn, and easy to reintroduce.
    #[test]
    fn the_claims_timestamp_ends_in_z_not_an_offset() {
        let signer = claim_signer();
        let (json, _) = claim_json(&CHANNEL, &evm_binding(&signer), 1, 1).expect("sign");
        let claim: serde_json::Value = serde_json::from_str(&json).expect("claim JSON");
        let timestamp = claim["timestamp"].as_str().expect("timestamp");

        assert!(timestamp.ends_with('Z'), "{timestamp}");
        assert!(!timestamp.contains("+00:00"), "{timestamp}");
    }

    /// The claim-state challenge [`HttpClaimState`] signs is a DIFFERENT
    /// digest from a balance proof, deliberately -- reusing the claim
    /// signature scheme would make a captured read-challenge replayable as
    /// a payment. Verified through the same function the receiving handler
    /// calls.
    #[test]
    fn the_claim_state_challenge_verifies_under_its_own_domain_separated_digest() {
        let signer = claim_signer();
        let challenge = EvmClaimStateChallenge {
            channel_id: CHANNEL,
            expires: 2_000_000_000,
            chain_id: DOMAIN.chain_id,
            token_network_address: DOMAIN.token_network,
        };
        let signature = signer
            .sign(&evm_claim_state_challenge_digest(&challenge))
            .expect("sign")
            .to_bytes();
        let address = derive_evm_address(&signer.public_key().expect("public key"));

        assert!(connector_signer::verify_evm_claim_state_challenge(
            &challenge, &signature, &address
        ));
        // ...and the two digests are genuinely different, so neither
        // signature is usable as the other.
        assert_ne!(
            evm_claim_state_challenge_digest(&challenge),
            evm_balance_proof_digest(&EvmBalanceProof {
                channel_id: CHANNEL,
                nonce: 0,
                transferred_amount: 0,
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: DOMAIN.chain_id,
                token_network_address: DOMAIN.token_network,
            })
        );
    }

    /// A ledger file this process cannot read is an error, never an empty
    /// book: "nobody has paid this hop" and "a floor I could not see" are
    /// indistinguishable on the wire, and only one of them is safe to
    /// assume.
    #[test]
    fn a_corrupt_ledger_file_is_refused_rather_than_read_as_a_fresh_book() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("outbound-client.log");
        std::fs::write(&path, "{\"nextHop\":\"apex-store\"\n").expect("write");
        assert!(matches!(
            OutboundClientLedger::open(&path),
            Err(OutboundClientError::LedgerUnwritable { .. })
        ));
    }

    /// A file that is not there yet is an empty book -- a node that has
    /// never paid a next hop has issued no nonces.
    #[test]
    fn a_ledger_that_has_never_been_written_opens_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ledger = OutboundClientLedger::open(dir.path().join("never-written.log"))
            .expect("a missing file is an empty ledger");
        assert_eq!(ledger.issued_nonce(NEXT_HOP), 0);
    }

    fn decode_hex_65(value: &str) -> [u8; 65] {
        let value = value.strip_prefix("0x").unwrap_or(value);
        let mut out = [0u8; 65];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).expect("hex");
        }
        out
    }

    fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
        let value = value.strip_prefix("0x").unwrap_or(value);
        if value.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(value.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Some(out)
    }

    // ---------------------------------------------------------------
    // Solana (issue #1146): the arm that made a Solana peering payable
    // proactively rather than only postpay.
    // ---------------------------------------------------------------

    /// The whole round trip on Solana: a real ask the far side actually
    /// verifies, a real ed25519 claim, and the receiver's own record as the
    /// only authority on the cumulative amount. Exactly the property the
    /// EVM twin above pins, on the other curve.
    #[tokio::test]
    async fn a_solana_hop_is_asked_and_paid_from_the_receivers_own_watermark() {
        let receiver = Receiver::start(41, 41_082).await;
        let client = reqwest::Client::new();
        let signer = solana_claim_signer();
        let challenge = solana_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);
        let ledger = OutboundClientLedger::in_memory();

        let claim = ledger
            .next_claim(
                NEXT_HOP,
                &state,
                &CHANNEL_ACCOUNT,
                &solana_binding(&signer),
                1_002,
            )
            .await
            .expect("the receiver verifies the challenge and answers");

        assert_eq!((claim.nonce, claim.cumulative), (42, 42_084));
        // And the signature is the ed25519 one, not an EVM one wearing its
        // label (issue #732's rule).
        let ClaimSignature::Solana(signature) = claim.signature else {
            panic!("a Solana binding must produce a Solana signature");
        };
        assert!(
            verify_solana_balance_proof(
                &PROGRAM_ID,
                &CHANNEL_ACCOUNT,
                42,
                42_084,
                &signature,
                &signer.public_key(),
            ),
            "the far gate must verify this claim against this node's own settlement key"
        );
    }

    /// The claim JSON is the shape `client-edge-spec.md` §1.3 defines for a
    /// Solana claim, in the encodings the far gate decodes: base58 for every
    /// 32-byte identifier, base64 for the signature, a decimal string for
    /// the amount. Checked against the wire rather than against this
    /// module's own idea of it.
    #[test]
    fn the_solana_claim_json_is_the_shape_the_far_gate_parses() {
        let signer = solana_claim_signer();
        let (json, _) =
            claim_json(&CHANNEL_ACCOUNT, &solana_binding(&signer), 7, 7_014).expect("sign a claim");
        let claim: serde_json::Value = serde_json::from_str(&json).expect("claim JSON");

        let public_key = bs58::encode(signer.public_key()).into_string();
        assert_eq!(claim["blockchain"], "solana");
        assert_eq!(claim["version"], "1.0");
        assert_eq!(claim["programId"], bs58::encode(PROGRAM_ID).into_string());
        assert_eq!(
            claim["channelAccount"],
            bs58::encode(CHANNEL_ACCOUNT).into_string()
        );
        assert_eq!(claim["signerPublicKey"], public_key);
        assert_eq!(claim["senderId"], public_key);
        assert_eq!(claim["nonce"], 7);
        assert_eq!(claim["transferredAmount"], "7014");
        // No EVM fields leak across: a Solana claim carrying `chainId`
        // would be a claim whose signed message and declared domain
        // disagree.
        assert!(claim.get("chainId").is_none());
        assert!(claim.get("tokenNetworkAddress").is_none());
        assert!(claim.get("locksRoot").is_none());
        // `cluster` is optional and deliberately not written -- see
        // `claim_json`'s own note.
        assert!(claim.get("cluster").is_none());

        let signature = BASE64
            .decode(claim["signature"].as_str().expect("signature"))
            .expect("base64");
        assert_eq!(signature.len(), 64);
        assert!(
            verify_solana_balance_proof(
                &PROGRAM_ID,
                &CHANNEL_ACCOUNT,
                7,
                7_014,
                &signature,
                &signer.public_key(),
            ),
            "the receiving claim gate must verify this against this node's own settlement key"
        );

        // And the whole point of ADR 0053: the same claim under a different
        // settlement program does NOT verify. Before it, a Solana claim
        // bound nothing about which deployment it was for.
        assert!(!verify_solana_balance_proof(
            &[0x99u8; 32],
            &CHANNEL_ACCOUNT,
            7,
            7_014,
            &signature,
            &signer.public_key(),
        ));
    }

    /// A pairing this connector must not be able to express: the binding
    /// carries the domain and the key together, so the ask and the claim
    /// can never be on two different chains. Asserted through the one
    /// place a mismatch is still representable -- a challenge signer
    /// configured on the other curve from the channel -- which is refused
    /// naming the reason rather than answered as "the receiver would not
    /// report".
    #[tokio::test]
    async fn a_challenge_signer_on_the_wrong_chain_is_refused_naming_the_reason() {
        let receiver = Receiver::start(0, 0).await;
        let client = reqwest::Client::new();
        // An EVM key asked to authenticate a Solana channel's ask.
        let challenge = evm_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);

        let error = state
            .watermark(&CHANNEL_ACCOUNT, &ClaimStateDomain::Solana)
            .await
            .expect_err("a cross-chain pairing must be refused");
        let message = error.to_string();
        assert!(message.contains("not on the same chain"), "{message}");
    }

    /// A Solana claim-state challenge signed over the wrong message is
    /// refused by the far side, not accepted. The receiver in these tests
    /// runs the real verifier, so this is the property that keeps the ask
    /// honest rather than merely well-formed.
    #[tokio::test]
    async fn a_solana_challenge_from_the_wrong_key_is_answered_unverified() {
        let receiver = Receiver::start(5, 5_000).await;
        let client = reqwest::Client::new();
        let impostor: Arc<dyn Ed25519Signer> =
            Arc::new(LocalEd25519Signer::from_secret_bytes([31u8; 32]).expect("signer"));
        let challenge = ClaimStateChallengeSigner::Solana(impostor);
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);

        let error = state
            .watermark(&CHANNEL_ACCOUNT, &ClaimStateDomain::Solana)
            .await
            .expect_err("a challenge from a key the channel does not name is not answered");
        assert!(matches!(
            error,
            OutboundClientError::ClaimStateUnavailable { .. }
        ));
    }

    /// The channel is named in its own chain's spelling everywhere an
    /// operator reads it -- base58 for Solana, never `0x` hex, which is how
    /// the two claim namespaces are kept apart in the first place.
    #[tokio::test]
    async fn a_solana_refusal_names_the_channel_in_base58() {
        let receiver = Receiver::start(0, 0).await;
        let client = reqwest::Client::new();
        let signer = solana_claim_signer();
        let challenge = solana_challenge_signer();
        let state = HttpClaimState::new(&client, &receiver.url, &challenge);
        let ledger = OutboundClientLedger::in_memory();

        let error = ledger
            .next_claim(
                NEXT_HOP,
                &state,
                &CHANNEL_ACCOUNT,
                &solana_binding(&signer),
                2_000_000,
            )
            .await
            .expect_err("above the reported headroom");
        let message = error.to_string();
        assert!(
            message.contains(&bs58::encode(CHANNEL_ACCOUNT).into_string()),
            "{message}"
        );
        assert!(!message.contains("0x"), "{message}");
    }
}
