//! Claim ingest gate for the client edge (`docs/protocol/client-edge-spec.md`
//! §1.3, issues #504, #522, #506/#544, #558): turns the
//! `ILP-Payment-Channel-Claim` (`-Wrapped`) header's already-decoded JSON
//! into a structurally valid, fresh, value-covering, cryptographically
//! verified [`ClientClaim`], or a documented refusal -- structure, then
//! freshness/watermark, then value binding against the matched route's
//! price, then (last, and only once all three have passed) the claim's
//! signature against its channel's counterparty: a replay or an
//! underpayment is refused before this ingress ever spends a signature
//! check on it.
//!
//! Reuses `connector_domain`'s pure nonce/watermark/value rules
//! ([`connector_domain::validate_claim`], [`connector_domain::validate_price`],
//! [`connector_domain::advance_watermark`]) exactly as the peer wire's own
//! `connector_runtime::ClaimBook` does for the first two -- this is a
//! second *state* around the same rules, not a second set of rules. The
//! state is deliberately separate from `ClaimBook`: a client-edge claim's
//! channel is never a peer-wire channel, and (unlike `ClaimBook::accept_inbound`)
//! a watermark advance here is gated behind a signature verification, on the
//! `ClientClaimGate`'s own claim-native scheme (EIP-712 for EVM, Ed25519 for
//! Solana -- `connector_signer::claim_signature`), not `ClaimBook`'s
//! chain-agnostic internal digest.
//!
//! **What "verified" means here** (issue #558): a claim's signature must
//! recover to the counterparty this connector has recorded for the channel
//! the claim names -- client-edge-spec.md §1.3 step 4 in full -- looked up
//! in the [`ClientChannelRegistry`] this gate is built with. A claim's own
//! `signerAddress`/`signerPublicKey` is not consulted, and neither is the
//! EIP-712 domain it declares for itself: a claim gets no say in what it is
//! checked against, or a forger would simply sign their own bytes with
//! their own key and declare themself the payer. A claim naming a channel
//! this connector has no record of is refused as
//! [`ClaimIngestRejection::UnknownChannel`], distinguishably from a bad
//! signature and from an underpayment -- there is nothing to verify it
//! against, and "unverifiable" is never "accepted". No configuration, flag
//! or build profile falls back to the claim's self-declared signer.
//!
//! **Where that record comes from** (issue #556): the registry answers
//! from what the config file declared, or -- for a channel nothing
//! declared -- from the chain, via a [`crate::ClientChannelSource`]. That
//! resolution is the one part of this gate that can do I/O, which is why
//! [`ClientClaimGate::ingest`] is `async`. A resolution that *fails* is
//! [`ClaimIngestRejection::ChannelLookupFailed`]: the claim is refused,
//! loudly and distinguishably from a channel that genuinely does not
//! exist, and under no circumstance falls back to trusting it.
//!
//! **What survives a restart** (issue #605): every watermark this gate
//! advances is written to a [`Journal`] -- the same ADR 0005 port the peer
//! wire's own `connector_runtime::ClaimBook` persists its watermarks
//! through, and the same [`JournalEntry::InboundClaimAccepted`] alphabet,
//! rather than a second persistence mechanism invented for this edge. A
//! gate can only be built by [`ClientClaimGate::restore`], which replays
//! that journal before serving anything, so a process that restarts
//! resumes at the watermark it left off at instead of at `None` -- and
//! `validate_claim(None, ..)` accepts any nonce, which makes every claim
//! the client already spent free service again. Two consequences are
//! deliberate and load-bearing:
//!
//! * A journal that cannot be read, or that has a line this build cannot
//!   decode, is an error out of [`ClientClaimGate::restore`] -- the node
//!   refuses to start rather than starting from zero, since starting from
//!   zero is precisely the defect.
//! * A claim whose acceptance cannot be made durable is **refused**
//!   ([`ClaimIngestRejection::NotDurable`]) and advances nothing, rather
//!   than accepted against an in-memory watermark a crash would erase. The
//!   journal append happens before the in-memory watermark moves and
//!   before the claim is handed back for the packet to be routed, exactly
//!   as ADR 0005 requires ("the journal being written before value is
//!   considered moved"). The append happens under the write lock that
//!   decides the acceptance, after -- never across -- the channel
//!   resolution await above, so a durable order is an accepted order and
//!   no in-flight lookup stalls another packet.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use connector_domain::client_claim::{
    parse_client_claim, ClientClaim, ClientClaimError, EvmClientClaim, SolanaClientClaim,
};
use connector_domain::{
    advance_watermark, validate_claim, validate_price, ClaimError, JournalEntry, Watermark,
};
use connector_runtime::{Journal, JournalError};
use connector_signer::{verify_evm_balance_proof, verify_solana_balance_proof, EvmBalanceProof};

use crate::channels::{decode_base58_bytes, decode_hex_bytes, ClientChannelRegistry};

/// Why the gate refused a claim. [`ClaimIngestRejection::Mina`] and
/// [`ClaimIngestRejection::Malformed`] are kept distinct on purpose: the
/// acceptance criteria requires a Mina claim's refusal to be distinguishable
/// from a merely malformed one; [`ClaimIngestRejection::Underpayment`] is
/// kept distinct from both for the same reason (issue #522);
/// [`ClaimIngestRejection::SignatureInvalid`] is kept distinct from all of
/// them for the same reason again (issue #506/#544) -- a claim that fails
/// cryptographic verification is neither stale, malformed nor underpaying;
/// and [`ClaimIngestRejection::UnknownChannel`] is kept distinct from
/// *those* for the same reason once more (issue #558) -- a claim naming a
/// channel this connector has no record of has not failed verification, it
/// could not be verified at all, and the two must not be reported as the
/// same thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimIngestRejection {
    Malformed(String),
    Mina,
    NonceNotAdvancing,
    AmountNotAdvancing,
    Underpayment {
        advanced: u64,
        price: u64,
    },
    /// The claim names a channel this connector has no counterparty
    /// recorded for (issue #558), so there is no key its signature could
    /// be checked against. Matches the peer wire's own
    /// `connector_runtime::ClaimRejectReason::UnknownChannel`.
    UnknownChannel,
    /// This connector could not find out who the claim's channel belongs
    /// to (issue #556) -- its [`crate::ClientChannelSource`] failed, e.g.
    /// an unreachable RPC endpoint. Distinct from
    /// [`ClaimIngestRejection::UnknownChannel`] on purpose: that one is a
    /// fact about the channel, this one is a failure of this connector's,
    /// and reporting an outage as "no such channel" would tell a
    /// legitimate payer to go away for a reason that is not true. Both
    /// refuse the claim -- an unverifiable claim is never accepted.
    ChannelLookupFailed(String),
    SignatureInvalid,
    /// The claim was structurally valid, fresh, value-covering and
    /// correctly signed -- and this connector could not durably record
    /// having accepted it (issue #605). Kept distinct from every refusal
    /// above for the same reason they are kept distinct from each other:
    /// nothing is wrong with the claim, so a sender must not be told its
    /// claim was invalid, and the same claim resubmitted once this
    /// connector's journal is writable again is still good. This is the
    /// only refusal here that is this connector's own fault, and the only
    /// one answered as a temporary (`T00`) rather than a final error.
    NotDurable,
    WrapUnsupported,
    WrapFailed(String),
}

impl ClaimIngestRejection {
    /// A human-readable reason, carried in the REJECT packet's `message`
    /// (RFC-0027) so a client can tell what went wrong without access to
    /// this connector's logs.
    pub fn message(&self) -> String {
        match self {
            ClaimIngestRejection::Malformed(reason) => {
                format!("claim rejected: structurally invalid: {reason}")
            }
            ClaimIngestRejection::Mina => "claim rejected: mina claims are refused -- ADR 0002 \
                 drops Mina support from the Rust connector; stay on the TypeScript fleet for \
                 Mina channels"
                .to_string(),
            ClaimIngestRejection::NonceNotAdvancing => {
                "claim rejected: nonce does not advance this channel's watermark (replay)"
                    .to_string()
            }
            ClaimIngestRejection::AmountNotAdvancing => "claim rejected: cumulative amount goes \
                 backwards relative to this channel's watermark"
                .to_string(),
            ClaimIngestRejection::Underpayment { advanced, price } => format!(
                "claim rejected: advances value by {advanced}, less than this route's price of {price}"
            ),
            ClaimIngestRejection::UnknownChannel => "claim rejected: names a channel this \
                 connector has no record of, so there is no counterparty to verify its \
                 signature against"
                .to_string(),
            ClaimIngestRejection::ChannelLookupFailed(reason) => format!(
                "claim rejected: this connector could not look up the channel's counterparty, \
                 so the claim cannot be verified -- retry once the lookup succeeds: {reason}"
            ),
            ClaimIngestRejection::SignatureInvalid => "claim rejected: signature does not \
                 verify against this channel's recorded counterparty"
                .to_string(),
            ClaimIngestRejection::NotDurable => "claim rejected: this connector could not \
                 durably record having accepted this claim, and will not accept a claim it \
                 could not remember spending -- retry"
                .to_string(),
            ClaimIngestRejection::WrapUnsupported => "claim rejected: this connector is not \
                 configured to unwrap a privacy-wrapped claim"
                .to_string(),
            ClaimIngestRejection::WrapFailed(reason) => {
                format!("claim rejected: failed to unwrap claim: {reason}")
            }
        }
    }
}

/// Per-channel watermark state for claims presented at the client edge,
/// over the channels this connector has a record of -- durable across a
/// restart, since a watermark that only lives in this process is not a
/// replay defence at all (issue #605). See this module's own doc.
pub struct ClientClaimGate {
    /// Whose signature this gate accepts, per channel (issue #558). Fixed
    /// at construction rather than mutable behind the lock: a channel's
    /// counterparty is configuration, not something an arriving claim may
    /// teach this connector.
    channels: ClientChannelRegistry,
    /// The live watermarks, and the durable record they are recovered
    /// from, held behind the *same* lock (issue #605): every accepted
    /// claim is journaled and then reflected here, and no other claim on
    /// any channel is judged in between, so the durable record and the
    /// in-memory one can never disagree about what was accepted or in
    /// what order.
    watermarks: RwLock<HashMap<String, Watermark>>,
    journal: Arc<dyn Journal>,
}

impl ClientClaimGate {
    /// A gate accepting claims on `channels` and no others, resuming from
    /// the watermarks `journal` already records (issue #605).
    ///
    /// This is the only way to build a gate, and it always replays: there
    /// is deliberately no constructor that starts a gate at no watermarks
    /// without saying where its watermarks came from, because a gate that
    /// silently starts at `None` accepts every nonce a client has already
    /// spent.
    ///
    /// An empty registry refuses every claim as
    /// [`ClaimIngestRejection::UnknownChannel`] -- see
    /// [`crate::ClientChannelRegistry`]'s own doc for why that is the
    /// intended failure mode rather than an oversight.
    ///
    /// # Errors
    ///
    /// A journal that cannot be read, or that carries a line this build
    /// cannot decode ([`JournalError::Corrupt`]). The caller must fail --
    /// per ADR 0009, before anything else starts -- rather than fall back
    /// to an empty set of watermarks.
    pub fn restore(
        channels: ClientChannelRegistry,
        journal: Arc<dyn Journal>,
    ) -> Result<ClientClaimGate, JournalError> {
        let watermarks = replay_watermarks(&journal.read_all()?);
        Ok(ClientClaimGate {
            channels,
            watermarks: RwLock::new(watermarks),
            journal,
        })
    }

    /// The watermark this gate currently holds for `channel_key` (the
    /// chain-namespaced key `ClientClaim::channel_key` produces), or `None`
    /// if it has never accepted a claim on that channel. Read-only: the
    /// only thing that advances a watermark is a fully accepted claim.
    pub fn watermark(&self, channel_key: &str) -> Option<Watermark> {
        self.watermarks
            .read()
            .expect("client claim watermarks lock poisoned")
            .get(channel_key)
            .copied()
    }

    /// Parse and fully validate a plaintext claim JSON body (already
    /// base64-decoded and, if it arrived wrapped, already unwrapped by the
    /// caller): structure, then freshness/watermark, then value binding
    /// against `price` -- the matched route's price (issue #522), `0` for a
    /// route that charges nothing or that isn't priced at all -- then,
    /// last, the claim's signature against the counterparty recorded for
    /// the channel it names (issue #506/#544, #558).
    /// Advances this claim's channel watermark only when the claim is
    /// fully accepted -- a rejected claim, whether stale, underpaying,
    /// unverifiable or unrecordable, leaves the watermark exactly as it
    /// was, so a corrected resubmission is still judged against the same
    /// baseline.
    ///
    /// `async` because resolving a channel nothing declared is a read
    /// against a chain (issue #556). The watermark lock is deliberately
    /// **not** held across that await -- a `std::sync::RwLock` guard held
    /// across a suspension point would stall every other packet in flight
    /// -- so the freshness and value rules are evaluated twice: once up
    /// front, which is what keeps #544's ordering promise that a replay or
    /// an underpayment never pays for a signature check, and once more
    /// under the write lock immediately before the watermark advances,
    /// which is what makes two concurrent claims on one channel still
    /// serialise. The second evaluation is the authoritative one.
    ///
    /// The advance is made durable before it is made visible (issue #605):
    /// the accepted claim is appended to this gate's journal, and only if
    /// that append reports the entry durable does the in-memory watermark
    /// move and the claim come back `Ok`. An append that fails refuses the
    /// claim as [`ClaimIngestRejection::NotDurable`] and changes nothing,
    /// so this connector never renders service against a watermark a
    /// restart would forget. That append is the *last* thing before the
    /// watermark moves, inside the same write lock the authoritative
    /// re-check was decided under and after the channel resolution await
    /// has already completed -- the two requirements compose rather than
    /// compete, because the only work that has to happen across the await
    /// is the lookup, and the only work that has to happen under the lock
    /// is the re-check, the append and the advance, in that order.
    pub async fn ingest(
        &self,
        claim_json: &str,
        price: u64,
    ) -> Result<ClientClaim, ClaimIngestRejection> {
        let claim = parse_client_claim(claim_json).map_err(|error| match error {
            ClientClaimError::Mina => ClaimIngestRejection::Mina,
            other => ClaimIngestRejection::Malformed(other.to_string()),
        })?;

        let key = claim.channel_key();
        {
            let watermarks = self
                .watermarks
                .read()
                .expect("client claim watermarks lock poisoned");
            check_freshness_and_value(watermarks.get(&key).copied(), &claim, price)?;
        }

        // The one await, and the only work that has to happen outside the
        // lock -- so it is also the last thing that happens outside it.
        let signature = verify_claim_signature(&self.channels, &claim).await?;

        let mut watermarks = self
            .watermarks
            .write()
            .expect("client claim watermarks lock poisoned");
        // Re-read rather than reusing the value from above: a concurrent
        // claim on this same channel may have advanced the watermark while
        // the channel lookup was in flight, and accepting both would be
        // exactly the replay this gate exists to refuse.
        check_freshness_and_value(watermarks.get(&key).copied(), &claim, price)?;

        // Durable first, visible second (ADR 0005, issue #605). Under the
        // same write lock, and after the authoritative re-check just
        // above, so the order entries land in the journal is exactly the
        // order watermarks advanced in -- a replay of the journal after a
        // restart reconstructs this state and not some interleaving of it.
        // Nothing awaits between here and the insert below, so the lock
        // spans a decision and an fsync and no I/O this gate has to wait
        // on a chain for.
        // The signature is retained rather than discarded for the same
        // reason the peer wire retains it (issue #425): a watermark says
        // what was spent, but only the claim itself is redeemable.
        if let Err(err) = self.journal.append(&JournalEntry::InboundClaimAccepted {
            channel_id: key.clone(),
            nonce: claim.nonce(),
            cumulative_amount: claim.transferred_amount(),
            signature,
        }) {
            tracing::error!(
                %err,
                channel = %key,
                "refusing a valid claim: its acceptance could not be durably recorded"
            );
            return Err(ClaimIngestRejection::NotDurable);
        }

        watermarks.insert(
            key,
            advance_watermark(claim.nonce(), claim.transferred_amount()),
        );
        Ok(claim)
    }
}

/// client-edge-spec.md §1.3 steps 2 and 3 against `current`: the claim's
/// nonce and cumulative amount must advance this channel's watermark, and
/// the advance must cover `price`. Pure, and cheap enough to run twice --
/// see [`ClientClaimGate::ingest`] for why it is.
fn check_freshness_and_value(
    current: Option<Watermark>,
    claim: &ClientClaim,
    price: u64,
) -> Result<(), ClaimIngestRejection> {
    if let Err(error) = validate_claim(current, claim.nonce(), claim.transferred_amount()) {
        return Err(match error {
            ClaimError::NonceNotAdvancing { .. } => ClaimIngestRejection::NonceNotAdvancing,
            ClaimError::AmountNotAdvancing { .. } => ClaimIngestRejection::AmountNotAdvancing,
            ClaimError::Underpayment { .. } => {
                unreachable!("validate_claim never returns Underpayment")
            }
        });
    }
    if let Err(error) = validate_price(current, claim.transferred_amount(), price) {
        return Err(match error {
            ClaimError::Underpayment { advanced, price } => {
                ClaimIngestRejection::Underpayment { advanced, price }
            }
            other => unreachable!("validate_price only ever returns Underpayment: {other:?}"),
        });
    }
    Ok(())
}

/// Rebuild the per-channel watermarks a journal records, folding every
/// [`JournalEntry::InboundClaimAccepted`] in it -- the client edge's own
/// half of the replay `connector_runtime::ClaimBook::set_journal` does for
/// the peer wire, over the same entry.
///
/// Componentwise `max` rather than last-wins, unlike the peer wire's fold:
/// entries are appended in accepted order and each accepted claim strictly
/// advances, so the two agree on any journal this gate itself wrote. They
/// differ only on a journal that has been reordered or spliced, and there
/// the direction of the disagreement matters -- a watermark recovered by
/// `max` can never come back lower than something already accepted, which
/// is the one failure this whole mechanism exists to prevent.
///
/// Entries of other kinds are ignored rather than refused: the entry
/// alphabet is shared with the peer wire, and this gate is only the
/// authority on the ones it writes.
fn replay_watermarks(entries: &[JournalEntry]) -> HashMap<String, Watermark> {
    let mut watermarks: HashMap<String, Watermark> = HashMap::new();
    for entry in entries {
        let JournalEntry::InboundClaimAccepted {
            channel_id,
            nonce,
            cumulative_amount,
            ..
        } = entry
        else {
            continue;
        };
        let watermark = watermarks.entry(channel_id.clone()).or_insert(Watermark {
            nonce: 0,
            cumulative_amount: 0,
        });
        watermark.nonce = watermark.nonce.max(*nonce);
        watermark.cumulative_amount = watermark.cumulative_amount.max(*cumulative_amount);
    }
    watermarks
}

/// Verify a claim's signature against the counterparty `channels` records
/// for the channel it names -- the gate's last stage, run only once
/// structure, freshness and value have all passed (issue #506/#544, #558).
/// The channel lookup belongs to this stage rather than ahead of it
/// precisely because it is the *signature's* missing half: a replay or an
/// underpayment is still refused for what it is, before this connector
/// spends any cryptographic work, exactly as #544 ordered it.
///
/// Returns the verified signature's raw bytes -- decoded here anyway to
/// check it, and what the journal entry recording this claim's acceptance
/// carries (issue #605/#425), so nothing downstream has to re-parse the
/// claim's chain-specific wire encoding to learn them.
async fn verify_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &ClientClaim,
) -> Result<Vec<u8>, ClaimIngestRejection> {
    match claim {
        ClientClaim::Evm(claim) => verify_evm_claim_signature(channels, claim).await,
        ClientClaim::Solana(claim) => verify_solana_claim_signature(channels, claim),
    }
}

async fn verify_evm_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &EvmClientClaim,
) -> Result<Vec<u8>, ClaimIngestRejection> {
    // An id that is not a 32-byte `channelId` cannot be a channel this
    // connector recorded, and cannot be one any chain could resolve either
    // -- so it is unknown rather than merely unverifiable, and is settled
    // here without spending a lookup on it.
    let Some(channel_id) = decode_hex_bytes::<32>(&claim.channel_id) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };
    let channel = match channels.evm(&channel_id).await {
        Ok(Some(channel)) => channel,
        Ok(None) => return Err(ClaimIngestRejection::UnknownChannel),
        // Loud, per issue #556: an operator has to be able to tell "my
        // chain endpoint is down, so no *new* channel can be recognised"
        // apart from "someone is claiming on channels that do not exist".
        // The claim is refused either way.
        Err(failure) => {
            tracing::warn!(
                channel_id = %claim.channel_id,
                error = %failure,
                "refusing a client claim: could not resolve its channel's counterparty"
            );
            return Err(ClaimIngestRejection::ChannelLookupFailed(failure.0));
        }
    };

    // `lockedAmount`/`locksRoot` are read from the claim because they are
    // material the counterparty signed over (ADR 0004 hashes both, as
    // zeros), not because the claim is trusted about them: a value the
    // signer did not sign simply produces a digest their signature does
    // not recover under. The signer and the EIP-712 domain are the two the
    // claim gets no say in, and both come from `channel` below.
    let Some(locks_root) = decode_hex_bytes::<32>(&claim.locks_root) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };
    let Ok(locked_amount) = claim.locked_amount.parse::<u128>() else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };
    let Some(signature) = decode_hex_bytes::<65>(&claim.signature) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };

    let proof = EvmBalanceProof {
        channel_id,
        nonce: claim.nonce,
        transferred_amount: u128::from(claim.transferred_amount),
        locked_amount,
        locks_root,
        chain_id: channel.chain_id,
        token_network_address: channel.token_network_address,
    };
    if verify_evm_balance_proof(&proof, &signature, &channel.counterparty) {
        Ok(signature.to_vec())
    } else {
        Err(ClaimIngestRejection::SignatureInvalid)
    }
}

fn verify_solana_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &SolanaClientClaim,
) -> Result<Vec<u8>, ClaimIngestRejection> {
    let Some(channel_account) = decode_base58_bytes::<32>(&claim.channel_account) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };
    // Declared records only -- see `ClientChannelRegistry::solana`: there
    // is no Solana client-edge channel source, so a Solana claim is
    // payable exactly when configuration named its channel.
    let Some(counterparty) = channels.solana(&channel_account) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    let Ok(signature) = BASE64.decode(&claim.signature) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };

    if verify_solana_balance_proof(
        &channel_account,
        claim.nonce,
        claim.transferred_amount,
        &signature,
        &counterparty,
    ) {
        Ok(signature)
    } else {
        Err(ClaimIngestRejection::SignatureInvalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::test_source::FakeChannelSource;
    use crate::channels::EvmChannel;
    use connector_runtime::{FileJournal, InMemoryJournal};
    use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, Address};
    use libsecp256k1::{Message, PublicKey, SecretKey};
    use std::sync::Arc;

    const EVM_CHAIN_ID: u64 = 8453;
    const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];
    const SOLANA_CHANNEL_ACCOUNT: [u8; 32] = [3u8; 32];

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The channels these tests claim against, each recorded with the
    /// fixed test keypair below as its counterparty (issue #558) -- a claim
    /// on any other channel, or signed by any other key, is refused.
    fn test_channels() -> ClientChannelRegistry {
        let (_secret, address) = evm_signer();
        let channel = EvmChannel {
            counterparty: address,
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let mut channels = ClientChannelRegistry::new();
        channels
            .record_evm(&channel_id(), channel)
            .expect("a 32-byte hex channel id");
        channels
            .record_evm(&second_channel_id(), channel)
            .expect("a 32-byte hex channel id");
        channels
            .record_solana(
                &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
                &base58_encode(&solana_signer().public.to_bytes()),
            )
            .expect("a 32-byte base58 channel account");
        channels
    }

    /// A gate with a record of [`test_channels`] and nothing else, over a
    /// journal that lives only as long as the gate does. Every test below
    /// that is not about durability uses this; the durability tests build
    /// their own gates over a [`FileJournal`] so that a "restart" is a
    /// second gate on the same path, not a mocked one.
    fn gate() -> ClientClaimGate {
        gate_over(test_channels())
    }

    /// A gate over `channels`, journaling somewhere that lives no longer
    /// than the test does. Tests about *which* claims a gate accepts use
    /// this; that an accepted watermark outlives the process is the
    /// `durability` module's own subject, and it uses a real file.
    fn gate_over(channels: ClientChannelRegistry) -> ClientClaimGate {
        ClientClaimGate::restore(channels, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
    }

    /// A fixed, deterministic EVM keypair -- deterministic on purpose, since
    /// these tests assert on *whether* a signature verifies, not on which
    /// specific key produced it.
    fn evm_signer() -> (SecretKey, Address) {
        let secret = SecretKey::parse(&[9u8; 32]).unwrap();
        let public = PublicKey::from_secret_key(&secret);
        (secret, derive_evm_address(&public.serialize()))
    }

    /// Sign `digest` exactly the way a real EVM wallet would (a 65-byte
    /// `r || s || v` signature, `v` in the conventional `{27, 28}` range).
    fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
        let message = Message::parse(digest);
        let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
        let mut bytes = signature.serialize().to_vec();
        let recovery_byte: u8 = recovery_id.into();
        bytes.push(recovery_byte + 27);
        bytes
    }

    /// An EVM claim JSON carrying whatever `signature`/`signer_address` hex
    /// strings are given verbatim -- the low-level builder every EVM test
    /// helper below goes through, so a test can substitute a wrong,
    /// corrupted or absent value without hand-writing the whole claim.
    fn evm_claim_json_with(
        channel_id: &str,
        nonce: u64,
        transferred_amount: u64,
        signature_hex: &str,
        signer_address_hex: &str,
        chain_fields: &str,
    ) -> String {
        format!(
            r#"{{
                "version": "1.0",
                "blockchain": "evm",
                "messageId": "msg-{nonce}",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-bob",
                "channelId": "{channel_id}",
                "nonce": {nonce},
                "transferredAmount": "{transferred_amount}",
                "lockedAmount": "0",
                "locksRoot": "0x{zeros}",
                "signature": "{signature_hex}",
                "signerAddress": "{signer_address_hex}"
                {chain_fields}
            }}"#,
            zeros = "0".repeat(64),
        )
    }

    /// An EVM claim JSON with a genuine EIP-712 signature produced by
    /// `secret` and declaring `declared_signer` as its own `signerAddress`
    /// -- the two are separable on purpose (issue #558): a forger signs
    /// perfectly well with a key of their own and declares whatever they
    /// like, so a test needs to be able to build exactly that.
    fn evm_claim_json_signed_by(
        secret: &SecretKey,
        declared_signer: &Address,
        channel_id: &str,
        nonce: u64,
        transferred_amount: u64,
    ) -> String {
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(channel_id).expect("test channel_id is valid hex"),
            nonce,
            transferred_amount: u128::from(transferred_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(secret, &evm_balance_proof_digest(&proof));
        evm_claim_json_with(
            channel_id,
            nonce,
            transferred_amount,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(declared_signer),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        )
    }

    /// An EVM claim JSON with a genuine EIP-712 signature over its own
    /// fields, produced by [`evm_signer`] -- so every test using it exercises
    /// the real verification path (issue #506/#544), not a bypass.
    fn evm_claim_json(channel_id: &str, nonce: u64, transferred_amount: u64) -> String {
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(channel_id).expect("test channel_id is valid hex"),
            nonce,
            transferred_amount: u128::from(transferred_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));
        evm_claim_json_with(
            channel_id,
            nonce,
            transferred_amount,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        )
    }

    fn channel_id() -> String {
        format!("0x{}", "ab".repeat(32))
    }

    /// A second recorded channel, for the tests that need two.
    fn second_channel_id() -> String {
        format!("0x{}", "cd".repeat(32))
    }

    /// A channel this connector has no record of -- well-formed as an id,
    /// simply never recorded.
    fn unrecorded_channel_id() -> String {
        format!("0x{}", "ef".repeat(32))
    }

    #[tokio::test]
    async fn a_fresh_claim_is_accepted() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_replayed_nonce_is_rejected_without_touching_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .await
            .expect("first claim accepted");

        let replay = gate.ingest(&evm_claim_json(&channel, 5, 999), 0).await;
        assert_eq!(replay, Err(ClaimIngestRejection::NonceNotAdvancing));

        // The watermark still holds at nonce 5 -- a genuinely advancing
        // claim after the rejected replay is judged against it, not against
        // whatever the rejected replay tried to claim.
        let next = gate.ingest(&evm_claim_json(&channel, 6, 500), 0).await;
        assert!(next.is_ok());
    }

    #[tokio::test]
    async fn an_amount_going_backwards_is_rejected() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 500), 0)
            .await
            .expect("first claim accepted");

        let result = gate.ingest(&evm_claim_json(&channel, 2, 100), 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::AmountNotAdvancing));
    }

    #[tokio::test]
    async fn the_watermark_never_advances_on_a_rejected_claim() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .await
            .expect("first claim accepted");
        gate.ingest(&evm_claim_json(&channel, 5, 999), 0)
            .await
            .unwrap_err(); // replay, rejected
        gate.ingest(&evm_claim_json(&channel, 6, 100), 0)
            .await
            .unwrap_err(); // amount regresses vs. watermark 500

        // Watermark is still exactly (5, 500): a claim of nonce 6 / amount
        // 500 (equal, not less) still advances cleanly.
        assert!(gate
            .ingest(&evm_claim_json(&channel, 6, 500), 0)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn different_channels_have_independent_watermarks() {
        let gate = gate();
        gate.ingest(&evm_claim_json(&channel_id(), 5, 500), 0)
            .await
            .expect("first channel");

        let result = gate
            .ingest(&evm_claim_json(&second_channel_id(), 1, 10), 0)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_mina_claim_is_rejected_distinguishably_from_malformed() {
        let gate = gate();
        let json = r#"{
            "version": "1.0",
            "blockchain": "mina",
            "messageId": "claim-3",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-dave",
            "zkAppAddress": "irrelevant",
            "tokenId": "1",
            "balanceCommitment": "abc",
            "nonce": 1,
            "proof": "AAAA",
            "salt": "salt"
        }"#;

        assert_eq!(gate.ingest(json, 0).await, Err(ClaimIngestRejection::Mina));
    }

    #[tokio::test]
    async fn a_structurally_invalid_claim_is_rejected_as_malformed() {
        let gate = gate();
        let result = gate
            .ingest(r#"{"version": "1.0", "blockchain": "evm"}"#, 0)
            .await;
        assert!(matches!(result, Err(ClaimIngestRejection::Malformed(_))));
    }

    #[tokio::test]
    async fn a_first_claim_advancing_by_at_least_the_price_is_accepted() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 100)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_first_claim_advancing_by_less_than_the_price_is_underpayment() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&channel_id(), 1, 99), 100)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 99,
                price: 100
            })
        );
    }

    #[tokio::test]
    async fn an_underpaying_claim_does_not_advance_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 99), 100)
            .await
            .unwrap_err();

        // A corrected resubmission is judged against the same (untouched)
        // baseline -- nonce 1 would otherwise fail as a replay if the
        // rejected claim above had advanced anything.
        let result = gate.ingest(&evm_claim_json(&channel, 1, 100), 100).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_later_claim_only_needs_to_cover_the_price_since_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 100), 100)
            .await
            .expect("first claim covers the price");

        // Advances by only 50 past the watermark of 100 -- underpayment
        // against a price of 100, even though the claim's own cumulative
        // transferredAmount (150) is larger than the price in isolation.
        let result = gate.ingest(&evm_claim_json(&channel, 2, 150), 100).await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 50,
                price: 100
            })
        );

        // Advancing by exactly the price is accepted.
        assert!(gate
            .ingest(&evm_claim_json(&channel, 2, 200), 100)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_zero_price_route_charges_nothing() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 0), 0).await;
        assert!(result.is_ok());
    }

    // -- Signature verification (issue #506/#544) --

    #[tokio::test]
    async fn a_genuine_evm_signature_is_accepted() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await;
        assert!(result.is_ok());
    }

    /// The forger of issue #558: a well-formed claim, genuinely signed,
    /// self-consistent -- and signed by a key that is not the channel's
    /// counterparty. Before #558 this was *accepted*, because the claim was
    /// checked against the signer it declared for itself.
    #[tokio::test]
    async fn an_evm_claim_signed_by_a_key_that_is_not_the_channels_counterparty_is_rejected() {
        let gate = gate();

        // An attacker's own freshly generated keypair, declared as this
        // claim's signer. The signature genuinely recovers to it; it is
        // simply not a party to the channel being claimed against.
        let forger_secret = SecretKey::parse(&[0x5a; 32]).unwrap();
        let forger_address =
            derive_evm_address(&PublicKey::from_secret_key(&forger_secret).serialize());
        let (_genuine_secret, counterparty) = evm_signer();
        assert_ne!(
            forger_address, counterparty,
            "the forger must not accidentally be the counterparty"
        );

        let claim =
            evm_claim_json_signed_by(&forger_secret, &forger_address, &channel_id(), 1, 100);

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A forged claim is refused *and* leaves nothing behind: the channel's
    /// real counterparty is judged against the same baseline afterwards.
    #[tokio::test]
    async fn a_forged_claim_advances_no_watermark() {
        let gate = gate();
        let forger_secret = SecretKey::parse(&[0x5a; 32]).unwrap();
        let forger_address =
            derive_evm_address(&PublicKey::from_secret_key(&forger_secret).serialize());
        gate.ingest(
            &evm_claim_json_signed_by(&forger_secret, &forger_address, &channel_id(), 9, 900),
            0,
        )
        .await
        .unwrap_err();

        // The counterparty's own first claim, at a far lower nonce and
        // amount than the forgery named, is still a fresh first claim.
        assert!(gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 0)
            .await
            .is_ok());
    }

    /// A claim's `signerAddress` is not consulted at all -- the registry
    /// decides. A claim declaring the wrong address, but genuinely signed
    /// by the channel's actual counterparty, is accepted: the field is
    /// unverified decoration, and this connector does not act on it either
    /// way.
    #[tokio::test]
    async fn an_evm_claims_declared_signer_field_carries_no_authority() {
        let gate = gate();
        let (secret, _address) = evm_signer();
        let claim = evm_claim_json_signed_by(
            &secret,
            &[0xde; 20], // a declared signer that is nobody
            &channel_id(),
            1,
            100,
        );

        assert!(gate.ingest(&claim, 0).await.is_ok());
    }

    /// A claim naming a channel this connector has no record of is refused
    /// -- distinguishably from a bad signature and from an underpayment
    /// (issue #558's AC2).
    #[tokio::test]
    async fn a_claim_on_an_unrecorded_channel_is_refused_as_unknown_channel() {
        let gate = gate();
        let claim = evm_claim_json(&unrecorded_channel_id(), 1, 100);

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::UnknownChannel));
        assert_ne!(result, Err(ClaimIngestRejection::SignatureInvalid));
        assert!(result.unwrap_err().message().contains("no record of"));
    }

    /// An empty registry is not an open door: a gate with a record of no
    /// channel at all refuses even a perfectly signed claim, rather than
    /// falling back to the claim's own declared signer (issue #558's AC8).
    #[tokio::test]
    async fn a_gate_with_no_recorded_channels_accepts_nothing() {
        let gate = ClientClaimGate::restore(
            ClientChannelRegistry::new(),
            Arc::new(InMemoryJournal::new()),
        )
        .expect("a fresh in-memory journal has nothing to replay");
        assert_eq!(
            gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await,
            Err(ClaimIngestRejection::UnknownChannel)
        );
    }

    /// Issue #556/#502: a channel **nothing declared**, resolved from the
    /// chain, is accepted -- the unaffiliated buyer's path. On a tree
    /// without this change there is no source to consult and this exact
    /// claim is refused `UnknownChannel`, so an operator has to edit
    /// `[[client_channels]]` and restart before anyone new can pay.
    ///
    /// The claim is signed by [`evm_signer`] and the *source* -- standing
    /// in for `TokenNetwork.channels(id)` -- is what names that address as
    /// the channel's counterparty. Nothing here reads the claim's own
    /// `signerAddress`; the forger tests below still pass unchanged.
    #[tokio::test]
    async fn a_claim_on_a_channel_only_the_chain_knows_about_is_accepted() {
        let (_secret, address) = evm_signer();
        let channel_id = decode_hex_bytes::<32>(&unrecorded_channel_id()).unwrap();
        let gate = gate_over(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::knowing(vec![(
                channel_id,
                EvmChannel {
                    counterparty: address,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )]),
        )));

        let accepted = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 100), 100)
            .await
            .expect("a channel the chain knows about is payable without a config edit");
        assert_eq!(
            accepted.channel_key(),
            format!("evm:{}", unrecorded_channel_id())
        );
    }

    /// The forger rule survives the new source: a claim signed by a key
    /// that is not what the *chain* holds as the channel's counterparty is
    /// still refused, even though the channel itself resolves.
    #[tokio::test]
    async fn a_claim_signed_by_someone_other_than_the_chains_counterparty_is_still_refused() {
        let channel_id = decode_hex_bytes::<32>(&unrecorded_channel_id()).unwrap();
        let forger = SecretKey::parse(&[13u8; 32]).unwrap();
        let forger_address = derive_evm_address(&PublicKey::from_secret_key(&forger).serialize());
        let (_secret, genuine) = evm_signer();
        let gate = gate_over(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::knowing(vec![(
                channel_id,
                EvmChannel {
                    counterparty: genuine,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )]),
        )));

        let claim =
            evm_claim_json_signed_by(&forger, &forger_address, &unrecorded_channel_id(), 1, 100);
        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A source that cannot answer refuses the claim -- it never degrades
    /// to trusting what the claim says about itself -- and says so
    /// distinguishably from a channel that genuinely does not exist, so an
    /// operator can tell an RPC outage from a sender naming channels at
    /// random.
    #[tokio::test]
    async fn a_claim_whose_channel_lookup_fails_is_refused_distinguishably() {
        let gate = gate_over(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::unreachable("connection refused"),
        )));

        let result = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 100), 0)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::ChannelLookupFailed(
                "connection refused".to_string()
            ))
        );
        assert_ne!(result, Err(ClaimIngestRejection::UnknownChannel));
        let message = result.unwrap_err().message();
        assert!(message.contains("could not look up"), "{message}");
        assert!(message.contains("connection refused"), "{message}");
    }

    /// A node whose config declares its channels keeps working while its
    /// chain endpoint is down: the declared record answers, and the broken
    /// source is never consulted. This is the "still start and serve when
    /// the chain is unreachable" requirement at claim level.
    #[tokio::test]
    async fn a_declared_channel_is_still_payable_while_the_chain_is_unreachable() {
        let mut channels = ClientChannelRegistry::new();
        let (_secret, address) = evm_signer();
        channels
            .record_evm(
                &channel_id(),
                EvmChannel {
                    counterparty: address,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )
            .expect("a 32-byte hex channel id");
        let gate = gate_over(
            channels.with_source(Arc::new(FakeChannelSource::unreachable(
                "connection refused",
            ))),
        );

        assert!(gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 0)
            .await
            .is_ok());
    }

    /// An unrecorded channel is refused *after* freshness and value, not
    /// before: #544's ordering is preserved, so an underpaying claim still
    /// costs this ingress no channel lookup or cryptographic work to
    /// refuse (issue #558's AC4).
    #[tokio::test]
    async fn an_underpaying_claim_on_an_unrecorded_channel_is_still_refused_as_underpayment() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 99), 100)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 99,
                price: 100
            })
        );
    }

    #[tokio::test]
    async fn an_evm_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let mut signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));
        signature[0] ^= 0xff;

        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[tokio::test]
    async fn an_evm_claim_with_a_truncated_signature_is_rejected_not_panicking() {
        let gate = gate();
        let (_secret, address) = evm_signer();
        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            "0xabcd",
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    /// The EIP-712 domain a claim is verified under comes from the channel's
    /// record, never from the claim (issue #558): a claim declaring no
    /// `chainId`/`tokenNetworkAddress` at all still verifies, and a claim
    /// declaring a *different* domain than the one recorded gains nothing by
    /// it -- both are judged against the recorded domain.
    #[tokio::test]
    async fn an_evm_claims_declared_eip712_domain_carries_no_authority() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));

        let no_declared_domain = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            "",
        );
        assert!(gate.ingest(&no_declared_domain, 0).await.is_ok());

        // The same signature, now declaring a domain it was not produced
        // under. It is still checked against the recorded one, so it still
        // verifies -- the declared fields simply do not participate.
        let wrong_declared_domain = evm_claim_json_with(
            &channel_id(),
            2,
            200,
            &format!(
                "0x{}",
                hex_encode(&sign_evm(
                    &secret,
                    &evm_balance_proof_digest(&EvmBalanceProof {
                        nonce: 2,
                        transferred_amount: 200,
                        ..proof
                    })
                ))
            ),
            &to_hex(&address),
            r#", "chainId": 1, "tokenNetworkAddress": "0x00000000000000000000000000000000000000ff""#,
        );
        assert!(gate.ingest(&wrong_declared_domain, 0).await.is_ok());
    }

    /// A claim signed under a domain that is *not* the channel's recorded
    /// one does not verify -- the recorded domain is the only one this
    /// connector computes a digest under.
    #[tokio::test]
    async fn an_evm_claim_signed_under_another_domain_is_rejected() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: 1,
            token_network_address: [0xff; 20],
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));

        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            r#", "chainId": 1, "tokenNetworkAddress": "0x00000000000000000000000000000000000000ff""#,
        );

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    #[tokio::test]
    async fn a_claim_failing_signature_verification_does_not_advance_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        let (_secret, address) = evm_signer();
        let bad_signature_claim = evm_claim_json_with(
            &channel,
            1,
            100,
            "0xabcd",
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );
        gate.ingest(&bad_signature_claim, 0).await.unwrap_err();

        // The watermark was never advanced by the rejected claim -- the
        // same nonce/amount is accepted here as a fresh first claim, not
        // refused as a replay.
        let genuine = gate.ingest(&evm_claim_json(&channel, 1, 100), 0).await;
        assert!(genuine.is_ok());
    }

    fn solana_signer() -> ed25519_dalek::Keypair {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::from_seed([13u8; 32]);
        ed25519_dalek::Keypair::generate(&mut rng)
    }

    fn base58_encode(bytes: &[u8]) -> String {
        bs58::encode(bytes).into_string()
    }

    fn solana_claim_json_with(
        channel_account: &str,
        nonce: u64,
        transferred_amount: u64,
        signature_base64: &str,
        signer_public_key: &str,
    ) -> String {
        format!(
            r#"{{
                "version": "1.0",
                "blockchain": "solana",
                "messageId": "msg-{nonce}",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-carol",
                "programId": "11111111111111111111111111111111",
                "channelAccount": "{channel_account}",
                "nonce": {nonce},
                "transferredAmount": "{transferred_amount}",
                "signature": "{signature_base64}",
                "signerPublicKey": "{signer_public_key}"
            }}"#
        )
    }

    fn genuine_solana_claim_json(
        channel_account_bytes: &[u8; 32],
        nonce: u64,
        transferred_amount: u64,
    ) -> String {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let keypair = solana_signer();
        let message = connector_signer::solana_balance_proof_message(
            channel_account_bytes,
            nonce,
            transferred_amount,
        );
        let signature = keypair.sign(&message);
        solana_claim_json_with(
            &base58_encode(channel_account_bytes),
            nonce,
            transferred_amount,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&keypair.public.to_bytes()),
        )
    }

    #[tokio::test]
    async fn a_genuine_solana_signature_is_accepted() {
        let gate = gate();
        let claim = genuine_solana_claim_json(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let result = gate.ingest(&claim, 0).await;
        assert!(result.is_ok());
    }

    /// The Solana half of issue #558's forger: a genuine Ed25519 signature
    /// over the right message, produced by a key that is not the channel's
    /// recorded counterparty and declared as the claim's own signer. Both
    /// families verify against the registry, not against themselves.
    #[tokio::test]
    async fn a_solana_claim_signed_by_a_key_that_is_not_the_channels_counterparty_is_rejected() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;
        use rand::SeedableRng;

        let gate = gate();
        let forger =
            ed25519_dalek::Keypair::generate(&mut rand::rngs::StdRng::from_seed([99u8; 32]));
        assert_ne!(
            forger.public.to_bytes(),
            solana_signer().public.to_bytes(),
            "the forger must not accidentally be the counterparty"
        );
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let signature = forger.sign(&message);

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&forger.public.to_bytes()),
        );

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A Solana claim naming a channel account this connector has no record
    /// of is refused as [`ClaimIngestRejection::UnknownChannel`], the same
    /// as its EVM counterpart.
    #[tokio::test]
    async fn a_solana_claim_on_an_unrecorded_channel_is_refused_as_unknown_channel() {
        let gate = gate();
        let claim = genuine_solana_claim_json(&[8u8; 32], 1, 100);
        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::UnknownChannel)
        );
    }

    /// A Solana claim's `signerPublicKey` carries no authority either: a
    /// claim genuinely signed by the recorded counterparty is accepted
    /// however it declares itself.
    #[tokio::test]
    async fn a_solana_claims_declared_signer_field_carries_no_authority() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = gate();
        let signer = solana_signer();
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let signature = signer.sign(&message);

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&[7u8; 32]),
        );

        assert!(gate.ingest(&claim, 0).await.is_ok());
    }

    #[tokio::test]
    async fn a_solana_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = gate();
        let keypair = solana_signer();
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let mut signature_bytes = keypair.sign(&message).to_bytes();
        signature_bytes[0] ^= 0xff;

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature_bytes),
            &base58_encode(&keypair.public.to_bytes()),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    // -- Watermark durability across a restart (issue #605) --

    mod durability {
        use super::*;

        /// A [`Journal`] whose `append` always fails -- ADR 0007's fake,
        /// not a mock: a real journal on a full or read-only disk behaves
        /// exactly like this, and the gate must refuse claims rather than
        /// accept ones it cannot remember.
        struct UnwritableJournal;

        impl Journal for UnwritableJournal {
            fn append(&self, _entry: &JournalEntry) -> Result<(), JournalError> {
                Err(JournalError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "read-only journal",
                )))
            }

            fn read_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
                Ok(Vec::new())
            }
        }

        /// A [`Journal`] whose `read_all` fails, standing in for a journal
        /// file that exists but cannot be read back.
        struct UnreadableJournal;

        impl Journal for UnreadableJournal {
            fn append(&self, _entry: &JournalEntry) -> Result<(), JournalError> {
                Ok(())
            }

            fn read_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
                Err(JournalError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "unreadable journal",
                )))
            }
        }

        fn file_gate(path: &std::path::Path) -> ClientClaimGate {
            ClientClaimGate::restore(
                test_channels(),
                Arc::new(FileJournal::open(path).expect("open the journal file")),
            )
            .expect("replay the journal")
        }

        /// Issue #605's own failure, end to end: a client spends a claim,
        /// the process restarts, and the client re-presents the very same
        /// claim. Before this fix the restarted gate held no watermark for
        /// the channel and accepted it -- and every claim above it -- as
        /// fresh, so 50 already-spent writes became 50 free ones.
        #[tokio::test]
        async fn a_claim_accepted_before_a_restart_is_refused_after_one() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");
            let channel = channel_id();

            {
                let gate = file_gate(&path);
                gate.ingest(&evm_claim_json(&channel, 50, 50_000), 1000)
                    .await
                    .expect("the first process accepts the claim");
            }

            // A second gate over the same journal file: a restarted
            // process, reading the same durable state off the same disk.
            let restarted = file_gate(&path);

            assert_eq!(
                restarted
                    .ingest(&evm_claim_json(&channel, 50, 50_000), 1000)
                    .await,
                Err(ClaimIngestRejection::NonceNotAdvancing),
                "a claim already spent before the restart must not be spendable after it"
            );
        }

        /// The rest of the replay-attack surface the ticket names: not
        /// just the last claim, but every lower nonce beneath it.
        #[tokio::test]
        async fn no_nonce_at_or_below_the_pre_restart_watermark_is_spendable_after_it() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");
            let channel = channel_id();

            {
                let gate = file_gate(&path);
                for nonce in 1..=5 {
                    gate.ingest(&evm_claim_json(&channel, nonce, nonce * 1000), 1000)
                        .await
                        .expect("a run of claims, each advancing by the price");
                }
            }

            let restarted = file_gate(&path);
            for nonce in 1..=5 {
                assert_eq!(
                    restarted
                        .ingest(&evm_claim_json(&channel, nonce, nonce * 1000), 1000)
                        .await,
                    Err(ClaimIngestRejection::NonceNotAdvancing),
                    "nonce {nonce} was spent before the restart"
                );
            }

            // The next genuinely fresh claim still works: recovery
            // restores the watermark, it does not wedge the channel.
            assert!(restarted
                .ingest(&evm_claim_json(&channel, 6, 6000), 1000)
                .await
                .is_ok());
        }

        /// Recovery is per channel, not a single global high-water mark:
        /// a channel that was never claimed on before the restart still
        /// accepts its first claim afterwards.
        #[tokio::test]
        async fn a_restart_recovers_each_channels_watermark_independently() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");

            {
                let gate = file_gate(&path);
                gate.ingest(&evm_claim_json(&channel_id(), 9, 9000), 0)
                    .await
                    .expect("first channel claimed on");
            }

            let restarted = file_gate(&path);
            assert_eq!(
                restarted
                    .ingest(&evm_claim_json(&channel_id(), 9, 9000), 0)
                    .await,
                Err(ClaimIngestRejection::NonceNotAdvancing)
            );
            assert!(restarted
                .ingest(&evm_claim_json(&second_channel_id(), 1, 10), 0)
                .await
                .is_ok());
        }

        /// Solana claims recover the same way -- the journal is keyed by
        /// the same chain-namespaced `channel_key` the live watermark map
        /// is, so neither chain's recovery can answer for the other's.
        #[tokio::test]
        async fn a_solana_claim_accepted_before_a_restart_is_refused_after_one() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");

            {
                let gate = file_gate(&path);
                gate.ingest(
                    &genuine_solana_claim_json(&SOLANA_CHANNEL_ACCOUNT, 4, 400),
                    0,
                )
                .await
                .expect("the first process accepts the claim");
            }

            let restarted = file_gate(&path);
            assert_eq!(
                restarted
                    .ingest(
                        &genuine_solana_claim_json(&SOLANA_CHANNEL_ACCOUNT, 4, 400),
                        0
                    )
                    .await,
                Err(ClaimIngestRejection::NonceNotAdvancing)
            );
        }

        /// A refused claim leaves nothing durable behind either: the
        /// journal is a record of what was *accepted*, so a corrected
        /// resubmission after a restart is still judged against the same
        /// baseline the live process judged it against.
        #[tokio::test]
        async fn a_refused_claim_writes_nothing_a_restart_could_recover() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");
            let channel = channel_id();

            {
                let gate = file_gate(&path);
                gate.ingest(&evm_claim_json(&channel, 1, 99), 100)
                    .await
                    .unwrap_err(); // underpayment
            }

            let restarted = file_gate(&path);
            assert_eq!(restarted.watermark(&format!("evm:{channel}")), None);
            assert!(restarted
                .ingest(&evm_claim_json(&channel, 1, 100), 100)
                .await
                .is_ok());
        }

        /// A claim this connector cannot durably record is refused, not
        /// accepted against a watermark that only exists in this process
        /// -- accepting it would be exactly the defect, one restart later.
        #[tokio::test]
        async fn a_claim_that_cannot_be_journaled_is_refused_and_advances_nothing() {
            let gate = ClientClaimGate::restore(test_channels(), Arc::new(UnwritableJournal))
                .expect("an unwritable journal still reads back empty");

            assert_eq!(
                gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await,
                Err(ClaimIngestRejection::NotDurable)
            );
            assert_eq!(gate.watermark(&format!("evm:{}", channel_id())), None);
        }

        /// `NotDurable` is distinguishable from every other refusal, for
        /// the same reason the others are distinguishable from each other:
        /// nothing was wrong with this claim.
        #[test]
        fn a_not_durable_refusal_does_not_blame_the_claim() {
            let message = ClaimIngestRejection::NotDurable.message();
            assert!(message.contains("durably record"), "{message}");
            assert_ne!(
                ClaimIngestRejection::NotDurable,
                ClaimIngestRejection::SignatureInvalid
            );
        }

        /// A journal that cannot be read is a refusal to build a gate at
        /// all, which the caller turns into a refusal to start (ADR 0009)
        /// -- never a gate that quietly starts at no watermarks, since
        /// that is the state that accepts every spent claim.
        #[test]
        fn an_unreadable_journal_refuses_to_produce_a_gate() {
            let result = ClientClaimGate::restore(test_channels(), Arc::new(UnreadableJournal));
            assert!(matches!(result, Err(JournalError::Io(_))));
        }

        /// A corrupt line is the same refusal: this build will not guess
        /// what a line it cannot decode meant, and will not skip it.
        #[tokio::test]
        async fn a_corrupt_journal_line_refuses_to_produce_a_gate() {
            use std::io::Write;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("client-edge-claims.log");
            {
                let gate = file_gate(&path);
                gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0)
                    .await
                    .expect("one good entry");
            }
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            writeln!(file, "this is not a journal entry").unwrap();
            drop(file);

            let result = ClientClaimGate::restore(
                test_channels(),
                Arc::new(FileJournal::open(&path).expect("open")),
            );
            assert!(matches!(result, Err(JournalError::Corrupt(_))));
        }

        /// A replayed watermark can only ever move forwards. The fold is
        /// componentwise `max` rather than last-wins precisely so that a
        /// journal whose entries are out of order -- however it got that
        /// way -- cannot hand a restarted node a *lower* watermark than
        /// one already accepted, which is the failure this whole
        /// mechanism exists to prevent.
        #[test]
        fn replay_never_recovers_a_watermark_lower_than_one_already_recorded() {
            let entries = vec![
                JournalEntry::InboundClaimAccepted {
                    channel_id: "evm:0xabc".to_string(),
                    nonce: 7,
                    cumulative_amount: 700,
                    signature: vec![1],
                },
                JournalEntry::InboundClaimAccepted {
                    channel_id: "evm:0xabc".to_string(),
                    nonce: 2,
                    cumulative_amount: 200,
                    signature: vec![2],
                },
            ];

            let watermarks = replay_watermarks(&entries);
            assert_eq!(
                watermarks.get("evm:0xabc").copied(),
                Some(Watermark {
                    nonce: 7,
                    cumulative_amount: 700
                })
            );
        }

        /// Entries the peer wire writes share this journal's alphabet but
        /// not this gate's authority: replaying them must not invent a
        /// client-edge watermark out of an outbound claim or a fulfilment.
        #[test]
        fn replay_ignores_entries_that_are_not_accepted_inbound_claims() {
            let entries = vec![
                JournalEntry::OutboundClaimSigned {
                    peer_id: "peer-b".to_string(),
                    channel_id: "evm:0xabc".to_string(),
                    nonce: 9,
                    cumulative_amount: 900,
                },
                JournalEntry::InboundFulfillmentRecorded {
                    channel_id: "evm:0xabc".to_string(),
                    amount: 50,
                },
            ];

            assert!(replay_watermarks(&entries).is_empty());
        }

        /// The journal keeps the claim itself, not merely its watermark:
        /// a watermark says what was spent, but only the signed claim is
        /// redeemable on chain (issue #425), and this edge's claims are
        /// the only ones a client-facing node ever holds.
        #[tokio::test]
        async fn an_accepted_claim_is_journaled_with_the_signature_it_was_verified_by() {
            let journal = Arc::new(InMemoryJournal::new());
            let gate = ClientClaimGate::restore(test_channels(), journal.clone())
                .expect("nothing to replay");
            gate.ingest(&evm_claim_json(&channel_id(), 3, 300), 0)
                .await
                .expect("accepted");

            let entries = journal.read_all().unwrap();
            assert_eq!(entries.len(), 1);
            let JournalEntry::InboundClaimAccepted {
                channel_id,
                nonce,
                cumulative_amount,
                signature,
            } = &entries[0]
            else {
                panic!("expected an accepted-claim entry, got {:?}", entries[0]);
            };
            assert_eq!(channel_id, &format!("evm:{}", super::channel_id()));
            assert_eq!(*nonce, 3);
            assert_eq!(*cumulative_amount, 300);
            assert_eq!(
                signature.len(),
                65,
                "the raw 65-byte EIP-712 signature, not its hex text"
            );
        }
    }

    #[tokio::test]
    async fn a_mina_claim_is_never_routed_into_signature_verification() {
        // Mina is refused at structural parsing (ADR 0002), long before
        // this gate would ever reach a signature check -- there is no Mina
        // arm in `verify_claim_signature` to route into.
        let gate = gate();
        let json = r#"{
            "version": "1.0",
            "blockchain": "mina",
            "messageId": "claim-mina",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-dave",
            "zkAppAddress": "irrelevant",
            "tokenId": "1",
            "balanceCommitment": "abc",
            "nonce": 1,
            "proof": "AAAA",
            "salt": "salt"
        }"#;
        assert_eq!(gate.ingest(json, 0).await, Err(ClaimIngestRejection::Mina));
    }
}
