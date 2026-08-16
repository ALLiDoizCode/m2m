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
use chrono::{SecondsFormat, Utc};
use connector_domain::x402::X402PaymentRequired;
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, evm_claim_state_challenge_digest,
    solana_balance_proof_message, solana_claim_state_challenge_message, to_hex, Ed25519Signer,
    EvmBalanceProof, EvmClaimStateChallenge, Signature, Signer,
};
use thiserror::Error;

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
    /// A Solana claim's cumulative amount does not fit the `u64`
    /// `solana_balance_proof_message` signs over (issue #1011). Refused
    /// before signing -- unlike the EVM claim, whose wire form is checked
    /// for this only once assembled (`Connector::cover_forward`), a Solana
    /// claim's SIGNED MESSAGE is already the truncated value if this is not
    /// caught first, which would sign something other than what watermark
    /// tracking believes it signed.
    #[error(
        "the covering claim's cumulative amount {cumulative} on channel {channel} does not fit \
         the wire's uint64"
    )]
    CumulativeAmountOverflow { channel: String, cumulative: u128 },
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
        domain: &EvmDomain,
    ) -> Result<ClaimWatermark, OutboundClientError>;
}

/// Ask a client edge's `POST /ilp/claim-state` (issue #693) where this
/// node's own claims on a channel stand.
///
/// Authenticated per channel by an EIP-712 challenge signed with the same
/// settlement key the claim itself is signed with -- a *different* digest
/// from a balance proof on purpose, so a captured challenge is not
/// replayable as a payment.
pub struct HttpClaimState<'a> {
    client: &'a reqwest::Client,
    /// The full `POST /ilp` endpoint of the receiver; `claim-state` hangs
    /// off it as a sub-path.
    edge_url: String,
    signer: &'a dyn Signer,
}

impl<'a> HttpClaimState<'a> {
    pub fn new(
        client: &'a reqwest::Client,
        edge_url: impl Into<String>,
        signer: &'a dyn Signer,
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
        domain: &EvmDomain,
    ) -> Result<ClaimWatermark, OutboundClientError> {
        let channel_hex = format!("0x{}", hex_encode(channel));
        let url = format!("{}/claim-state", self.edge_url.trim_end_matches('/'));
        let expires = now_secs() + CLAIM_STATE_CHALLENGE_TTL_SECS;
        let digest = evm_claim_state_challenge_digest(&EvmClaimStateChallenge {
            channel_id: *channel,
            expires,
            chain_id: domain.chain_id,
            token_network_address: domain.token_network,
        });
        let failed = |reason: String| OutboundClientError::ClaimStateUnavailable {
            channel: channel_hex.clone(),
            reason,
        };
        let signature = self
            .signer
            .sign(&digest)
            .map_err(|error| failed(error.to_string()))?
            .to_bytes();

        let request = serde_json::json!({
            "channels": [{
                "blockchain": "evm",
                "channelId": channel_hex,
                "expires": expires,
                "signature": format!("0x{}", hex_encode(&signature)),
            }]
        });
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

/// [`HttpClaimState`], owning what it borrows, so it can outlive the one
/// async call `connector announce` (its other caller) makes it for and be
/// stored for the life of a serving node (issue #1011,
/// `Connector::with_outbound_client_hop`) -- a config-driven client-role
/// hop is armed once at startup and asked repeatedly, so its
/// [`ClaimStateSource`] cannot borrow anything scoped to one call. Delegates
/// to [`HttpClaimState`] itself rather than re-implementing the request --
/// one HTTP/signing implementation serves both the one-shot and the
/// long-lived caller.
pub struct OwnedHttpClaimState {
    client: reqwest::Client,
    edge_url: String,
    signer: Arc<dyn Signer>,
}

impl OwnedHttpClaimState {
    pub fn new(
        client: reqwest::Client,
        edge_url: impl Into<String>,
        signer: Arc<dyn Signer>,
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
        domain: &EvmDomain,
    ) -> Result<ClaimWatermark, OutboundClientError> {
        HttpClaimState::new(&self.client, &self.edge_url, self.signer.as_ref())
            .watermark(channel, domain)
            .await
    }
}

/// The Solana counterpart of [`ClaimStateSource`] (issue #1011): asks a
/// receiver where this node's claims on a Solana channel ACCOUNT stand.
///
/// Kept as its own trait rather than a second method on [`ClaimStateSource`]
/// for the same reason this workspace keeps `ClaimSignature::Evm`/`::Solana`
/// and `Signer`/`Ed25519Signer` apart throughout: a Solana channel carries
/// no EIP-712 domain to ask under, so one shared method would take a
/// parameter the Solana implementation always ignores.
#[async_trait]
pub trait SolanaClaimStateSource: Send + Sync {
    async fn watermark(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<ClaimWatermark, OutboundClientError>;
}

/// Ask a client edge's `POST /ilp/claim-state` where this node's own claims
/// on a Solana channel account stand -- the Solana counterpart of
/// [`HttpClaimState`]/[`OwnedHttpClaimState`], owned for the same reason
/// [`OwnedHttpClaimState`] is (issue #1011).
///
/// Authenticated per channel by a claim-state challenge
/// (`connector_signer::solana_claim_state_challenge_message`) signed with
/// the same settlement key a real claim is -- domain-separated from a
/// balance proof on purpose, so a captured challenge is not replayable as a
/// payment (mirrors [`HttpClaimState`]'s own EIP-712 challenge).
pub struct HttpSolanaClaimState {
    client: reqwest::Client,
    edge_url: String,
    signer: Arc<dyn Ed25519Signer>,
}

impl HttpSolanaClaimState {
    pub fn new(
        client: reqwest::Client,
        edge_url: impl Into<String>,
        signer: Arc<dyn Ed25519Signer>,
    ) -> HttpSolanaClaimState {
        HttpSolanaClaimState {
            client,
            edge_url: edge_url.into(),
            signer,
        }
    }
}

#[async_trait]
impl SolanaClaimStateSource for HttpSolanaClaimState {
    async fn watermark(
        &self,
        channel_account: &[u8; 32],
    ) -> Result<ClaimWatermark, OutboundClientError> {
        let channel_text = bs58::encode(channel_account).into_string();
        let url = format!("{}/claim-state", self.edge_url.trim_end_matches('/'));
        let expires = now_secs() + CLAIM_STATE_CHALLENGE_TTL_SECS;
        let message = solana_claim_state_challenge_message(channel_account, expires);
        let failed = |reason: String| OutboundClientError::ClaimStateUnavailable {
            channel: channel_text.clone(),
            reason,
        };
        let signature = self.signer.sign(&message);

        let request = serde_json::json!({
            "channels": [{
                "blockchain": "solana",
                "channelAccount": channel_text,
                "expires": expires,
                "signature": base64_encode(&signature),
            }]
        });
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
            // Same "one generic reason" posture as `HttpClaimState`'s own
            // EVM branch -- see its comment for why.
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

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
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
    /// The EIP-712 balance-proof signature the JSON above carries, kept in
    /// its decoded form (issue #875) so a caller that has to put this claim
    /// on a carriage taking `crate::WireClaim` -- the forwarding path's
    /// `PeerTransport` port -- does not have to parse back the JSON this
    /// module just wrote.
    pub signature: Signature,
}

/// The Solana counterpart of [`OutboundClaim`] (issue #1011). No `json`
/// field: unlike the EVM path (read by `connector announce`'s one-shot
/// client-edge payer), this one is only ever consumed by
/// `Connector::cover_forward`, which needs the signature to build a
/// `WireClaim` and nothing else -- rendering a Solana claim onto the peer
/// wire is `connector_peer_btp::claim_json::encode`'s job, already wired
/// since issue #998.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundSolanaClaim {
    /// The nonce it was issued at.
    pub nonce: u64,
    /// The receiver's cumulative record advanced by exactly the amount --
    /// already checked to fit the `u64` the signed message and the wire
    /// both require (see [`OutboundClientError::CumulativeAmountOverflow`]).
    pub cumulative: u64,
    /// What the receiver reported.
    pub watermark: ClaimWatermark,
    /// The raw ed25519 signature over
    /// `connector_signer::solana_balance_proof_message`.
    pub signature: [u8; 64],
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
    /// `signer` is the settlement key of the channel's on-chain
    /// participant, and `domain` is the RECEIVER's EIP-712 domain -- see
    /// [`EvmDomain`] for why it cannot be this node's own.
    pub async fn next_claim(
        &self,
        next_hop: &str,
        receiver: &dyn ClaimStateSource,
        channel: &[u8; 32],
        domain: &EvmDomain,
        signer: &dyn Signer,
        amount: u64,
    ) -> Result<OutboundClaim, OutboundClientError> {
        let watermark = receiver.watermark(channel, domain).await?;
        if let Some(available) = watermark.available {
            if available < u128::from(amount) {
                return Err(OutboundClientError::InsufficientHeadroom {
                    channel: format!("0x{}", hex_encode(channel)),
                    available,
                    amount,
                });
            }
        }
        let nonce = self.reserve_nonce(next_hop, watermark.nonce)?;
        let cumulative = watermark.cumulative + u128::from(amount);
        let (json, signature) = claim_json(signer, channel, domain, nonce, cumulative)?;
        Ok(OutboundClaim {
            nonce,
            cumulative,
            watermark,
            json,
            signature,
        })
    }

    /// The Solana counterpart of [`OutboundClientLedger::next_claim`] (issue
    /// #1011): same nonce-floor contract, same "ask the receiver, refuse
    /// short headroom, record durably, then sign" order -- see that
    /// method's own doc for why the order is the contract. The one added
    /// step is the `u64` fit check, which the EVM path performs on the
    /// *wire* claim after signing (`Connector::cover_forward`); a Solana
    /// claim's signed MESSAGE is already that u64
    /// (`connector_signer::solana_balance_proof_message`), so this checks
    /// before signing rather than after.
    pub async fn next_claim_solana(
        &self,
        next_hop: &str,
        receiver: &dyn SolanaClaimStateSource,
        channel_account: &[u8; 32],
        signer: &dyn Ed25519Signer,
        amount: u64,
    ) -> Result<OutboundSolanaClaim, OutboundClientError> {
        let watermark = receiver.watermark(channel_account).await?;
        let channel_text = || bs58::encode(channel_account).into_string();
        if let Some(available) = watermark.available {
            if available < u128::from(amount) {
                return Err(OutboundClientError::InsufficientHeadroom {
                    channel: channel_text(),
                    available,
                    amount,
                });
            }
        }
        // Checked -- and refused -- before `reserve_nonce`, same as the
        // headroom check above: a claim this method cannot actually
        // produce must not consume a nonce either.
        let cumulative = watermark.cumulative + u128::from(amount);
        let cumulative_amount = u64::try_from(cumulative).map_err(|_| {
            OutboundClientError::CumulativeAmountOverflow {
                channel: channel_text(),
                cumulative,
            }
        })?;
        let nonce = self.reserve_nonce(next_hop, watermark.nonce)?;
        let message = solana_balance_proof_message(channel_account, nonce, cumulative_amount);
        let signature = signer.sign(&message);
        Ok(OutboundSolanaClaim {
            nonce,
            cumulative: cumulative_amount,
            watermark,
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

/// The client-edge claim JSON, signed through this workspace's PRODUCTION
/// signing path (`Signer::sign` + `Signature::to_bytes`), whose byte 64 is
/// libsecp256k1's raw recovery id in `{0,1}`. Deliberately no `+27`: issues
/// #590/#591 moved that normalisation to the settlement boundary, and
/// pre-shifting it here would be a second implementation of a rule that
/// already has one.
fn claim_json(
    signer: &dyn Signer,
    channel: &[u8; 32],
    domain: &EvmDomain,
    nonce: u64,
    cumulative: u128,
) -> Result<(String, Signature), OutboundClientError> {
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
    let signature_bytes = signature.to_bytes();
    let address = derive_evm_address(
        &signer
            .public_key()
            .map_err(|error| OutboundClientError::Signing(error.to_string()))?,
    );
    Ok((
        serde_json::json!({
        "version": "1.0",
        "blockchain": "evm",
        "messageId": format!("connector-announce-{nonce}"),
        // `Z`, not `+00:00`. The claim gate refuses a `+00:00` offset by
        // name -- "'timestamp' must be ISO 8601 with a 'Z' timezone" -- and
        // `chrono`'s plain `to_rfc3339()` produces exactly the spelling it
        // rejects.
        "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "senderId": to_hex(&address),
        "channelId": format!("0x{}", hex_encode(channel)),
        "nonce": nonce,
        "transferredAmount": cumulative.to_string(),
        "lockedAmount": "0",
        "locksRoot": format!("0x{}", "0".repeat(64)),
        "signature": format!("0x{}", hex_encode(&signature_bytes)),
        "signerAddress": to_hex(&address),
        "chainId": domain.chain_id,
        "tokenNetworkAddress": to_hex(&domain.token_network),
        })
        .to_string(),
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

    use connector_signer::{verify_evm_balance_proof, LocalSigner};
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response, Server};

    use super::*;

    const DOMAIN: EvmDomain = EvmDomain {
        chain_id: 84_532,
        token_network: [0x1eu8; 20],
    };
    const CHANNEL: [u8; 32] = [0x5cu8; 32];
    /// The peer id of the next hop under test. A real one from this fleet,
    /// so nothing here reads as a placeholder.
    const NEXT_HOP: &str = "apex-store";

    fn claim_signer() -> LocalSigner {
        LocalSigner::from_secret_bytes("outbound-claim-test", [23u8; 32]).expect("signer")
    }

    /// A real receiver: an HTTP server answering `POST /ilp/claim-state`
    /// exactly as a client edge does, from a watermark the test sets. Not a
    /// mock -- the code under test dials it, signs a real challenge, and
    /// parses a real answer.
    struct Receiver {
        url: String,
        nonce: Arc<AtomicU64>,
        cumulative: Arc<AtomicU64>,
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
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
                    Ok::<_, Infallible>(service_fn(move |_: Request<Body>| {
                        let nonce = nonce.load(Ordering::SeqCst);
                        let cumulative = cumulative.load(Ordering::SeqCst);
                        async move {
                            Ok::<_, Infallible>(Response::new(Body::from(
                                serde_json::json!({
                                    "channels": [{
                                        "ok": true,
                                        "nonce": nonce,
                                        "cumulativeClaimed": cumulative.to_string(),
                                        "available": "1000000",
                                    }]
                                })
                                .to_string(),
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
        let state = HttpClaimState::new(&client, &receiver.url, &signer);

        let ledger =
            OutboundClientLedger::open(dir.path().join("outbound-client.log")).expect("open");
        // This first claim is what a local book would remember: nonce 42,
        // cumulative 42_084.
        let first = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 1_002)
            .await
            .expect("first claim");
        assert_eq!((first.nonce, first.cumulative), (42, 42_084));

        // The receiver now says it never recorded that claim -- it is still
        // at 41/41_082. The next claim must be priced off THAT, not off the
        // 42_084 this process last signed.
        let second = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 1_002)
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
            .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 1_002)
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
        let state = HttpClaimState::new(&client, &receiver.url, &signer);

        let before = OutboundClientLedger::open(&path).expect("open");
        let mut issued = Vec::new();
        for _ in 0..3 {
            issued.push(
                before
                    .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 7)
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
            .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 7)
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
        let state = HttpClaimState::new(&client, &receiver.url, &signer);
        let ledger =
            OutboundClientLedger::open(dir.path().join("outbound-client.log")).expect("open");

        for _ in 0..3 {
            ledger
                .next_claim("apex-store", &state, &CHANNEL, &DOMAIN, &signer, 1)
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
        let state = HttpClaimState::new(&client, &receiver.url, &signer);
        let ledger = OutboundClientLedger::in_memory();

        let error = ledger
            .next_claim(NEXT_HOP, &state, &CHANNEL, &DOMAIN, &signer, 2_000_000)
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

    const SOLANA_CHANNEL: [u8; 32] = [0x7au8; 32];
    /// A real one from this fleet, so nothing here reads as a placeholder --
    /// same convention as [`NEXT_HOP`].
    const SOLANA_NEXT_HOP: &str = "drew-store";

    fn solana_claim_signer() -> connector_signer::LocalEd25519Signer {
        connector_signer::LocalEd25519Signer::from_secret_bytes([31u8; 32]).expect("solana signer")
    }

    /// The Solana counterpart of
    /// `the_watermark_comes_from_the_receiver_and_not_from_anything_local`
    /// (issue #1011): same property, over [`HttpSolanaClaimState`] and
    /// [`OutboundClientLedger::next_claim_solana`] instead of their EVM
    /// twins.
    #[tokio::test]
    async fn the_solana_watermark_comes_from_the_receiver_and_not_from_anything_local() {
        let receiver = Receiver::start(41, 41_082).await;
        let client = reqwest::Client::new();
        let signer: Arc<dyn Ed25519Signer> = Arc::new(solana_claim_signer());
        let state = HttpSolanaClaimState::new(client.clone(), &receiver.url, Arc::clone(&signer));
        let ledger = OutboundClientLedger::in_memory();

        let first = ledger
            .next_claim_solana(
                SOLANA_NEXT_HOP,
                &state,
                &SOLANA_CHANNEL,
                signer.as_ref(),
                1_002,
            )
            .await
            .expect("first claim");
        assert_eq!((first.nonce, first.cumulative), (42, 42_084));

        let second = ledger
            .next_claim_solana(
                SOLANA_NEXT_HOP,
                &state,
                &SOLANA_CHANNEL,
                signer.as_ref(),
                1_002,
            )
            .await
            .expect("second claim");
        assert_eq!(
            second.cumulative, 42_084,
            "the cumulative amount must be the receiver's record advanced by the amount"
        );
        assert_eq!(second.watermark.nonce, 41);

        receiver.nonce.store(100, Ordering::SeqCst);
        receiver.cumulative.store(100_200, Ordering::SeqCst);
        let third = ledger
            .next_claim_solana(
                SOLANA_NEXT_HOP,
                &state,
                &SOLANA_CHANNEL,
                signer.as_ref(),
                1_002,
            )
            .await
            .expect("third claim");
        assert_eq!((third.nonce, third.cumulative), (101, 101_202));
    }

    /// The Solana counterpart of `a_restart_never_reissues_a_nonce_the_receiver_has_not_seen`.
    #[tokio::test]
    async fn a_solana_restart_never_reissues_a_nonce_the_receiver_has_not_seen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("outbound-client.log");
        let receiver = Receiver::start(41, 41_082).await;
        let client = reqwest::Client::new();
        let signer: Arc<dyn Ed25519Signer> = Arc::new(solana_claim_signer());
        let state = HttpSolanaClaimState::new(client.clone(), &receiver.url, Arc::clone(&signer));

        let before = OutboundClientLedger::open(&path).expect("open");
        let mut issued = Vec::new();
        for _ in 0..3 {
            issued.push(
                before
                    .next_claim_solana(SOLANA_NEXT_HOP, &state, &SOLANA_CHANNEL, signer.as_ref(), 7)
                    .await
                    .expect("claim")
                    .nonce,
            );
        }
        assert_eq!(issued, vec![42, 43, 44]);
        drop(before);

        let after = OutboundClientLedger::open(&path).expect("reopen");
        assert_eq!(after.issued_nonce(SOLANA_NEXT_HOP), 44);
        let resumed = after
            .next_claim_solana(SOLANA_NEXT_HOP, &state, &SOLANA_CHANNEL, signer.as_ref(), 7)
            .await
            .expect("claim after restart");
        assert_eq!(
            resumed.nonce, 45,
            "a restart must resume above every nonce ever issued, not above the receiver's record"
        );
    }

    /// The Solana counterpart of `a_packet_bigger_than_the_reported_headroom_is_refused_not_signed`.
    #[tokio::test]
    async fn a_solana_packet_bigger_than_the_reported_headroom_is_refused_not_signed() {
        let receiver = Receiver::start(0, 0).await;
        let client = reqwest::Client::new();
        let signer: Arc<dyn Ed25519Signer> = Arc::new(solana_claim_signer());
        let state = HttpSolanaClaimState::new(client.clone(), &receiver.url, Arc::clone(&signer));
        let ledger = OutboundClientLedger::in_memory();

        let error = ledger
            .next_claim_solana(
                SOLANA_NEXT_HOP,
                &state,
                &SOLANA_CHANNEL,
                signer.as_ref(),
                2_000_000,
            )
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
            ledger.issued_nonce(SOLANA_NEXT_HOP),
            0,
            "a refused packet must not consume a nonce"
        );
    }

    /// Issue #1011's own new failure mode, unique to Solana: the signed
    /// message is a `u64`, so an amount that does not fit it must be
    /// refused before signing -- signing it would sign a silently
    /// truncated amount, not the one watermark tracking believes it owes.
    #[tokio::test]
    async fn a_solana_claim_whose_cumulative_amount_does_not_fit_u64_is_refused_before_signing() {
        let receiver = Receiver::start(0, u64::MAX).await;
        let client = reqwest::Client::new();
        let signer: Arc<dyn Ed25519Signer> = Arc::new(solana_claim_signer());
        let state = HttpSolanaClaimState::new(client.clone(), &receiver.url, Arc::clone(&signer));
        let ledger = OutboundClientLedger::in_memory();

        let error = ledger
            .next_claim_solana(SOLANA_NEXT_HOP, &state, &SOLANA_CHANNEL, signer.as_ref(), 1)
            .await
            .expect_err("an amount overflowing u64 must be refused rather than signed truncated");
        assert!(
            matches!(error, OutboundClientError::CumulativeAmountOverflow { .. }),
            "{error}"
        );
        assert_eq!(
            ledger.issued_nonce(SOLANA_NEXT_HOP),
            0,
            "a claim this method could not produce must not consume a nonce"
        );
    }

    /// The Solana counterpart of
    /// `the_claim_verifies_as_the_settlement_address_the_channel_is_opened_with`:
    /// the signature `next_claim_solana` produces verifies the way the
    /// RECEIVER verifies it, against the exact message
    /// `connector_signer::solana_balance_proof_message` defines.
    #[tokio::test]
    async fn the_solana_claim_verifies_as_the_settlement_address_the_channel_is_opened_with() {
        let receiver = Receiver::start(6, 6_000).await;
        let client = reqwest::Client::new();
        let signer: Arc<dyn Ed25519Signer> = Arc::new(solana_claim_signer());
        let state = HttpSolanaClaimState::new(client.clone(), &receiver.url, Arc::clone(&signer));
        let ledger = OutboundClientLedger::in_memory();

        let claim = ledger
            .next_claim_solana(
                SOLANA_NEXT_HOP,
                &state,
                &SOLANA_CHANNEL,
                signer.as_ref(),
                14,
            )
            .await
            .expect("claim");

        assert!(connector_signer::verify_solana_balance_proof(
            &SOLANA_CHANNEL,
            claim.nonce,
            claim.cumulative,
            &claim.signature,
            &signer.public_key(),
        ));
    }

    /// The claim this node emits is verified here the way the RECEIVER
    /// verifies it: recover the signer from the balance-proof digest and
    /// check it is the channel participant this node's settlement key
    /// derives. A claim that fails this is refused at the far gate with the
    /// packet already formed, so it is worth proving locally.
    #[test]
    fn the_claim_verifies_as_the_settlement_address_the_channel_is_opened_with() {
        let signer = claim_signer();
        let (json, _) = claim_json(&signer, &CHANNEL, &DOMAIN, 7, 7_014).expect("sign a claim");
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
        let (json, _) = claim_json(&claim_signer(), &CHANNEL, &DOMAIN, 1, 1).expect("sign");
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
}
