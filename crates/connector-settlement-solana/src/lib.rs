//! Solana settlement backend (issue #567, ADR 0001, ADR 0002): a real,
//! chain-backed [`SettlementBackend`] driven against
//! `packages/solana-program` -- the SPL-token, PDA-addressed payment
//! channel program the live fleet already settles through on
//! `solana:devnet` (program id `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`,
//! see `packages/solana-program/deployments/devnet-public.md`).
//!
//! `connector-settlement-solana-program` -- this crate's own former,
//! throwaway, native-SOL, signature-unverified channel program -- is gone.
//! Nothing here constructs, deploys or calls it anymore; [`wire`] speaks
//! `packages/solana-program`'s own wire directly (discriminators, PDA
//! seeds, account layouts, the Ed25519-precompile balance-proof check)
//! since that crate builds for the SBF target only and exports no client
//! SDK of its own.
//!
//! Like [`connector_settlement::InMemorySettlementBackend`] this holds no
//! local channel *ledger* -- every method reads the chain fresh before
//! deciding what the port's rules require. It does hold one small piece of
//! local memory, [`SolanaSettlementBackend`]'s `settled` set: `settle`
//! (`packages/solana-program/src/processor.rs:635-647`) zeroes the
//! channel PDA's lamports and data as its very last step, which is how a
//! genuinely rent-exempt Solana account is closed -- so a channel this
//! backend has itself driven to `Settled` no longer exists on chain at
//! all, and is indistinguishable from "never opened" without that memory.

#[cfg(feature = "test-util")]
pub mod test_support;
pub mod wire;

use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use chrono::Duration;

use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::Instruction;
use solana_sdk::program_pack::Pack;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer as SolanaSigner};
use solana_sdk::transaction::Transaction;

use connector_settlement::{
    ChannelId, ChannelState, ChannelStatus, Claim, SettlementBackend, SettlementError,
};

/// A [`SettlementBackend`] backed by a real `packages/solana-program`
/// instance on a Solana chain.
pub struct SolanaSettlementBackend {
    rpc: RpcClient,
    program_id: Pubkey,
    /// This backend's own identity -- every channel it opens names this as
    /// one of the two on-chain participants, exactly like
    /// `EvmSettlementBackend::own_address` (issue #576's precedent), so
    /// [`counterparty_of`](Self::counterparty_of) can tell which side is
    /// "self" and which is the counterparty's.
    payer: Keypair,
    /// The SPL mint every channel this backend opens settles in --
    /// `[settlement] token_address` in production, a freshly created mock
    /// mint for [`deploy`](Self::deploy).
    token_mint: Pubkey,
    /// Present only for a [`deploy`](Self::deploy)-built backend:
    /// counterparty identities this backend privately holds keys for, so
    /// this crate's own tests can drive a full open/fund/redeem/close/settle
    /// lifecycle without a second, external actor. Two of them, because the
    /// deployed program holds exactly one live channel per (pair, mint) --
    /// its channel PDA is seeded `["channel", min, max, mint]` -- so a test
    /// needing two concurrently-live, *fundable* channels (the port's
    /// contract suite does: `counterparty`'s channel is still in its
    /// challenge window when `instant_counterparty`'s opens) needs two
    /// distinct counterparty identities with real keys.
    ///
    /// This is not a shortcut around a real constraint -- it is the
    /// answer to one. `packages/solana-program`'s `Deposit` instruction
    /// requires the depositing participant to sign for *themselves*
    /// (`processor.rs:309-311`, `:356-360`): unlike
    /// `TokenNetwork.setTotalDeposit`, which lets any caller credit an
    /// arbitrary participant's deposit from the caller's own token
    /// balance (`EvmSettlementBackend::fund`'s "approve-then-deposit"),
    /// there is no delegate-deposit path here. A `connect`-built
    /// production backend never has any: real deposits happen from the
    /// counterparty's own wallet directly against the deployed program
    /// (rig opens and funds its own channel), never through this
    /// backend's [`fund`](SettlementBackend::fund) -- see that method's
    /// own doc for what it does without one.
    counterparty_signers: Vec<Keypair>,
    /// Channel PDAs this backend has itself driven
    /// [`settle`](SettlementBackend::settle) to completion on -- see this
    /// struct's own top-of-file doc for why the chain alone cannot answer
    /// "was this settled, or did it never exist" once that has happened.
    settled: Mutex<HashSet<Pubkey>>,
}

impl SolanaSettlementBackend {
    /// Bind to an already-deployed `packages/solana-program` instance at
    /// `program_id`, settling in `token_mint`, signing every transaction
    /// with the keypair `payer_seed` derives (a 32-byte ed25519 seed, the
    /// same key-file shape `[settlement] key` already resolves for the EVM
    /// backend's private key).
    ///
    /// Refuses -- naming the address -- if `program_id` names no
    /// executable account, or `token_mint` is not owned by the SPL Token
    /// program: the coarse, "did I misconfigure this entirely" check issue
    /// #567 made on its own. Executable alone is not identity -- a typo'd
    /// `program_id` naming any *other* real program (SPL Token itself,
    /// say) would pass it and fail lazily at the first settle -- so
    /// `connect` also proves the program actually behaves like the
    /// deployed payment-channel program before this node serves traffic
    /// ([`Self::verify_program_identity`]), the Solana twin of
    /// `EvmSettlementBackend::connect` proving its contract by calling
    /// `get_token_network` on it (issue #630's review).
    ///
    /// `expected_decimals` is the scale the operator wrote down
    /// (`[settlement.solana] decimals`), the Solana twin of
    /// `EvmSettlementBackend::connect`'s own `expected_decimals` (issue
    /// #564): nothing here scales by it -- every amount this backend moves
    /// is already in the mint's own base units -- so it is checked rather
    /// than applied. `connect` reads the mint's own `decimals` field and
    /// refuses, naming both values, when they disagree (issue #630, ADR
    /// 0009): the fuller "does the fleet's own identity match what's
    /// deployed" check issue #567 deferred here.
    pub async fn connect(
        rpc_url: &str,
        payer_seed: &[u8; 32],
        program_id: Pubkey,
        token_mint: Pubkey,
        expected_decimals: u8,
    ) -> Result<Self, SettlementError> {
        let payer = solana_sdk::signer::keypair::keypair_from_seed(payer_seed)
            .map_err(|error| SettlementError::Backend(error.to_string()))?;
        let rpc =
            RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());

        let program_account = rpc.get_account(&program_id).await.map_err(backend_error)?;
        if !program_account.executable {
            return Err(SettlementError::Backend(format!(
                "settlement program_id {program_id} is not an executable program account"
            )));
        }
        let mint_account = rpc.get_account(&token_mint).await.map_err(backend_error)?;
        if mint_account.owner != spl_token::id() {
            return Err(SettlementError::Backend(format!(
                "settlement token_address {token_mint} is not owned by the SPL Token program"
            )));
        }
        let mint = spl_token::state::Mint::unpack(&mint_account.data).map_err(backend_error)?;
        if mint.decimals != expected_decimals {
            return Err(SettlementError::Backend(format!(
                "[settlement.solana] decimals is {expected_decimals}, but mint {token_mint} \
                 reports decimals = {}",
                mint.decimals
            )));
        }

        let backend = Self {
            rpc,
            program_id,
            payer,
            token_mint,
            counterparty_signers: Vec::new(),
            settled: Mutex::new(HashSet::new()),
        };
        // Ordered after `ensure_own_ata_exists`, which already proves the
        // payer holds real lamports by submitting a transaction -- so a
        // probe failure below means program identity, never an unfunded
        // payer reported as the wrong program.
        backend.ensure_own_ata_exists().await?;
        backend.verify_program_identity().await?;
        Ok(backend)
    }

    /// Prove the account at `program_id` actually implements the deployed
    /// payment-channel program, not merely that *something* executable
    /// lives there (issue #630's review, finding 2): simulate -- never
    /// submit -- an `InitializeChannel` against a freshly generated,
    /// throwaway counterparty, whose channel PDA therefore cannot exist,
    /// and require the simulation to succeed. Only the real program
    /// accepts that instruction: it must recognize the discriminator,
    /// derive the same `["channel", ..]`/`["vault", ..]` PDAs from the
    /// same seeds, and drive the create-account and SPL-token CPIs to
    /// completion -- any other executable program (SPL Token itself, say)
    /// rejects the instruction data or its accounts. The counterparty is
    /// random rather than fixed so nobody can pre-create the probe's PDA
    /// on a public cluster and wedge this node's startup.
    ///
    /// Refusing here, at connect, is the point: the alternative is a node
    /// that starts clean against a typo'd `program_id` and discovers it at
    /// its first settle, hours later, with claims already accepted (the
    /// `#564` fail-closed pattern, ADR 0009).
    async fn verify_program_identity(&self) -> Result<(), SettlementError> {
        let own = self.payer.pubkey();
        let probe_counterparty = Keypair::new().pubkey();
        let (channel, _bump) = wire::channel_pda(
            &own,
            &probe_counterparty,
            &self.token_mint,
            &self.program_id,
        );
        let (vault, _bump) = wire::vault_pda(&channel, &self.program_id);
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_initialize_channel(3600),
            wire::Accounts::initialize_channel(
                &own,
                &own,
                &probe_counterparty,
                &self.token_mint,
                &channel,
                &vault,
            ),
        );
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(backend_error)?;
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&own),
            &[&self.payer],
            recent_blockhash,
        );
        let simulation = self
            .rpc
            .simulate_transaction(&transaction)
            .await
            .map_err(backend_error)?;
        if let Some(error) = simulation.value.err {
            return Err(SettlementError::Backend(format!(
                "settlement program_id {} is executable but rejected a simulated \
                 payment-channel InitializeChannel ({error}) -- it does not behave like the \
                 deployed packages/solana-program payment-channel program, so this node \
                 refuses to start rather than fail at its first settlement",
                self.program_id
            )));
        }
        Ok(())
    }

    /// Bind to `program_id` (already loaded into the target validator's
    /// genesis -- see this crate's `test_support` module), creating a
    /// fresh mock SPL mint and airdropping and funding this backend's own
    /// identity and two privately-held counterparty identities (see
    /// [`counterparty_signers`](Self::counterparty_signers)'s doc for why
    /// two) with test tokens. Used by this crate's own tests, mirroring
    /// `EvmSettlementBackend::deploy`'s role against `anvil` -- never used
    /// against a real chain, where the mint and every identity already
    /// exist.
    pub async fn deploy(rpc_url: &str, program_id: Pubkey) -> Result<Self, SettlementError> {
        let rpc =
            RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
        let payer = Keypair::new();
        let counterparties = [Keypair::new(), Keypair::new()];
        for keypair in [&payer, &counterparties[0], &counterparties[1]] {
            let signature = rpc
                .request_airdrop(&keypair.pubkey(), 100_000_000_000)
                .await
                .map_err(backend_error)?;
            wait_for_confirmation(&rpc, &signature).await?;
        }

        let mint = Keypair::new();
        let rent = rpc
            .get_minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN)
            .await
            .map_err(backend_error)?;
        let create_mint_account = solana_sdk::system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            rent,
            spl_token::state::Mint::LEN as u64,
            &spl_token::id(),
        );
        let initialize_mint = spl_token::instruction::initialize_mint2(
            &spl_token::id(),
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            6,
        )
        .map_err(backend_error)?;
        let recent_blockhash = rpc.get_latest_blockhash().await.map_err(backend_error)?;
        let transaction = Transaction::new_signed_with_payer(
            &[create_mint_account, initialize_mint],
            Some(&payer.pubkey()),
            &[&payer, &mint],
            recent_blockhash,
        );
        rpc.send_and_confirm_transaction(&transaction)
            .await
            .map_err(backend_error)?;

        let backend = Self {
            rpc,
            program_id,
            payer,
            token_mint: mint.pubkey(),
            counterparty_signers: counterparties.into(),
            settled: Mutex::new(HashSet::new()),
        };
        backend.ensure_own_ata_exists().await?;
        backend
            .mint_test_tokens_to(&backend.payer.pubkey(), 1_000_000_000)
            .await?;
        let counterparty_pubkeys: Vec<Pubkey> = backend
            .counterparty_signers
            .iter()
            .map(|keypair| keypair.pubkey())
            .collect();
        for counterparty_pubkey in counterparty_pubkeys {
            let create_counterparty_ata =
                spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                    &backend.payer.pubkey(),
                    &counterparty_pubkey,
                    &backend.token_mint,
                    &spl_token::id(),
                );
            backend.submit(&[create_counterparty_ata], &[]).await?;
            backend
                .mint_test_tokens_to(&counterparty_pubkey, 1_000_000_000)
                .await?;
        }

        Ok(backend)
    }

    /// This backend's own signing address -- the on-chain identity every
    /// channel it opens names as one of the two participants.
    pub fn own_pubkey(&self) -> Pubkey {
        self.payer.pubkey()
    }

    /// The SPL mint every channel this backend opens settles in.
    pub fn token_mint(&self) -> Pubkey {
        self.token_mint
    }

    /// The deployed `payment-channel` program instance this backend drives
    /// (issue #632's greeting facts -- the Solana twin of
    /// `EvmSettlementBackend::address`/`registry_address`).
    pub fn program_id(&self) -> Pubkey {
        self.program_id
    }

    /// Who this backend's counterparty is on the channel at `channel_account`,
    /// as the chain itself holds it -- the Solana twin of
    /// `EvmSettlementBackend::channel_counterparty` (issue #611), and the
    /// client edge's own channel record for a Solana channel nothing was
    /// declared for (issue #629/#631).
    ///
    /// `Ok(None)`, rather than an error, for every "this is not a channel
    /// this backend can be paid on":
    ///
    /// - nothing was ever opened at `channel_account`, or it has already
    ///   `Settled` (`redeem` requires `Opened` or `Closed` --
    ///   [`SolanaSettlementBackend`]'s own top-of-file doc on why a settled
    ///   channel's account does not even exist to be fetched -- and honouring
    ///   a claim against it would be giving the app's work away; a merely
    ///   `Closed` channel still redeems during its challenge window (issue
    ///   #574), so it still answers);
    /// - neither participant is this backend's own signing address, i.e. it
    ///   is somebody else's channel;
    /// - its `token_mint` is not the mint this backend is configured to
    ///   settle in. The deployed program lets any payer open a channel
    ///   with ANY mint, and the balance-proof signature does not cover the
    ///   mint (`connector_signer::solana_balance_proof_message` signs
    ///   channel account, nonce and amount alone), so this resolution
    ///   check is the one place the mint is bound: without it, a claim on
    ///   a channel funded with a worthless SPL token would buy
    ///   USDC-priced writes.
    ///
    /// `Err` is reserved for a lookup that genuinely failed -- an
    /// unreachable endpoint, a malformed response -- so a caller can tell
    /// "there is no such channel" apart from "I could not find out".
    pub async fn channel_counterparty(
        &self,
        channel_account: Pubkey,
    ) -> Result<Option<Pubkey>, SettlementError> {
        let Some(account) = self.fetch_account(&channel_account).await? else {
            return Ok(None);
        };
        Ok(Self::resolvable_counterparty(
            &account,
            self.payer.pubkey(),
            self.token_mint,
        ))
    }

    /// The pure per-account half of
    /// [`channel_counterparty`](Self::channel_counterparty): given a parsed
    /// channel account, decide whether it is a channel a backend with
    /// identity `own` settling in `token_mint` can be paid on, and if so by
    /// whom. Extracted so every refusal branch -- settled, wrong mint,
    /// not a participant -- is unit-testable against a fabricated account
    /// without a validator.
    fn resolvable_counterparty(
        account: &wire::ChannelAccount,
        own: Pubkey,
        token_mint: Pubkey,
    ) -> Option<Pubkey> {
        if account.status == wire::ChannelStatus::Settled {
            return None;
        }
        if account.token_mint != token_mint {
            return None;
        }
        if account.participant_a == own {
            Some(account.participant_b)
        } else if account.participant_b == own {
            Some(account.participant_a)
        } else {
            None
        }
    }

    /// Test/dev-only accessor (issue #631's mint-binding review): the
    /// 32-byte ed25519 seed of this backend's own signing keypair, so a
    /// test can [`connect`](Self::connect) a second backend under the SAME
    /// on-chain identity but a different `token_mint` -- the shape the
    /// mint-binding check in
    /// [`channel_counterparty`](Self::channel_counterparty) exists to
    /// refuse.
    pub fn test_payer_seed(&self) -> [u8; 32] {
        self.payer.to_bytes()[..32]
            .try_into()
            .expect("a Keypair's first 32 bytes are its seed")
    }

    /// Test/dev-only accessor (issue #567): the pubkey bytes of the first
    /// counterparty identity a [`deploy`](Self::deploy)-built backend
    /// privately holds a key for -- what this crate's own tests pass as
    /// [`connector_settlement::contract::ContractFixture::counterparty`].
    /// `None` for a [`connect`](Self::connect)-built production backend.
    pub fn test_counterparty_pubkey(&self) -> Option<Vec<u8>> {
        self.counterparty_signers
            .first()
            .map(|keypair| keypair.pubkey().to_bytes().to_vec())
    }

    /// Test/dev-only accessor (issue #567): the pubkey bytes of the second
    /// held counterparty identity -- what this crate's own tests pass as
    /// [`connector_settlement::contract::ContractFixture::instant_counterparty`],
    /// distinct from [`test_counterparty_pubkey`](Self::test_counterparty_pubkey)'s
    /// because the deployed program holds one live channel per (pair, mint)
    /// (see [`counterparty_signers`](Self::counterparty_signers)'s doc).
    /// `None` for a [`connect`](Self::connect)-built production backend.
    pub fn test_instant_counterparty_pubkey(&self) -> Option<Vec<u8>> {
        self.counterparty_signers
            .get(1)
            .map(|keypair| keypair.pubkey().to_bytes().to_vec())
    }

    /// Test/dev-only accessor (issue #567): sign the balance-proof message
    /// for `channel`, `nonce` and `cumulative_amount` as whichever held
    /// counterparty identity `channel` was opened against -- the Ed25519
    /// signature `redeem`'s `Claim::signature` must carry for the deployed
    /// program's precompile check to accept. Which identity that is is
    /// re-derived rather than looked up: the channel PDA is a pure function
    /// of (own identity, counterparty, mint), so the held key whose derived
    /// PDA matches `channel`'s id is the channel's counterparty. `None` for
    /// a [`connect`](Self::connect)-built production backend, or if no held
    /// key derives `channel`'s id.
    pub fn test_sign_claim(
        &self,
        channel: &ChannelId,
        nonce: u64,
        cumulative_amount: u128,
    ) -> Option<Vec<u8>> {
        let pubkey = Pubkey::from_str(&channel.0).ok()?;
        let counterparty = self.counterparty_signers.iter().find(|keypair| {
            wire::channel_pda(
                &self.payer.pubkey(),
                &keypair.pubkey(),
                &self.token_mint,
                &self.program_id,
            )
            .0 == pubkey
        })?;
        let units = to_units(cumulative_amount).ok()?;
        let message = wire::balance_proof_message(&pubkey, nonce, units);
        Some(counterparty.sign_message(&message).as_ref().to_vec())
    }

    async fn ensure_own_ata_exists(&self) -> Result<(), SettlementError> {
        let instruction =
            spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                &self.payer.pubkey(),
                &self.payer.pubkey(),
                &self.token_mint,
                &spl_token::id(),
            );
        self.submit(&[instruction], &[]).await
    }

    async fn mint_test_tokens_to(
        &self,
        owner: &Pubkey,
        amount: u64,
    ) -> Result<(), SettlementError> {
        let destination =
            spl_associated_token_account::get_associated_token_address(owner, &self.token_mint);
        let instruction = spl_token::instruction::mint_to(
            &spl_token::id(),
            &self.token_mint,
            &destination,
            &self.payer.pubkey(),
            &[],
            amount,
        )
        .map_err(backend_error)?;
        self.submit(&[instruction], &[]).await
    }

    async fn submit(
        &self,
        instructions: &[Instruction],
        extra_signers: &[&Keypair],
    ) -> Result<(), SettlementError> {
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(backend_error)?;
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra_signers);
        let transaction = Transaction::new_signed_with_payer(
            instructions,
            Some(&self.payer.pubkey()),
            &signers,
            recent_blockhash,
        );
        self.rpc
            .send_and_confirm_transaction(&transaction)
            .await
            .map_err(backend_error)?;
        Ok(())
    }

    /// Fetch and parse the `ChannelState` account at `pubkey`, or `None`
    /// if nothing this program owns lives there.
    async fn fetch_account(
        &self,
        pubkey: &Pubkey,
    ) -> Result<Option<wire::ChannelAccount>, SettlementError> {
        let response = self
            .rpc
            .get_account_with_commitment(pubkey, CommitmentConfig::confirmed())
            .await
            .map_err(backend_error)?;
        let Some(account) = response.value else {
            return Ok(None);
        };
        if account.owner != self.program_id {
            return Ok(None);
        }
        Ok(wire::ChannelAccount::parse(&account.data))
    }

    /// Resolve `channel` to its on-chain pubkey and current state: either
    /// a live, parsed account, or -- if nothing lives there but this
    /// backend itself remembers settling it -- the fact that it was
    /// settled and its account is now gone (this struct's own top-of-file
    /// doc). Anything else nothing was ever opened at is
    /// [`SettlementError::ChannelNotFound`].
    async fn resolve(&self, channel: &ChannelId) -> Result<(Pubkey, Resolved), SettlementError> {
        let pubkey = Pubkey::from_str(&channel.0)
            .map_err(|_| SettlementError::ChannelNotFound(channel.clone()))?;
        match self.fetch_account(&pubkey).await? {
            Some(account) => Ok((pubkey, Resolved::Live(account))),
            None => {
                if self
                    .settled
                    .lock()
                    .expect("settled mutex poisoned")
                    .contains(&pubkey)
                {
                    Ok((pubkey, Resolved::Settled))
                } else {
                    Err(SettlementError::ChannelNotFound(channel.clone()))
                }
            }
        }
    }

    /// [`resolve`](Self::resolve), then reject anything but a live
    /// `Opened` channel -- the precondition [`fund`](SettlementBackend::fund)
    /// and [`close`](SettlementBackend::close) share.
    /// [`redeem`](SettlementBackend::redeem) uses
    /// [`redeemable_channel`](Self::redeemable_channel) instead, since it
    /// still succeeds against a `Closed` channel (issue #574).
    async fn open_channel(
        &self,
        channel: &ChannelId,
    ) -> Result<(Pubkey, wire::ChannelAccount), SettlementError> {
        let (pubkey, resolved) = self.resolve(channel).await?;
        match resolved {
            Resolved::Live(account) => match account.status {
                wire::ChannelStatus::Opened => Ok((pubkey, account)),
                wire::ChannelStatus::Closed => Err(SettlementError::ChannelClosed(channel.clone())),
                wire::ChannelStatus::Settled => {
                    Err(SettlementError::ChannelSettled(channel.clone()))
                }
            },
            Resolved::Settled => Err(SettlementError::ChannelSettled(channel.clone())),
        }
    }

    /// [`resolve`](Self::resolve), then reject only a settled channel
    /// (issue #574) -- the shared precondition/read-back for anything
    /// that still works against a `Closed` channel:
    /// [`redeem`](SettlementBackend::redeem)'s precondition and post-submit
    /// read-back, and [`close`](SettlementBackend::close)'s post-submit
    /// read-back (the channel is expected to be `Closed` by then, but
    /// accepting `Opened` too costs nothing and avoids a near-identical
    /// third check).
    async fn redeemable_channel(
        &self,
        channel: &ChannelId,
    ) -> Result<(Pubkey, wire::ChannelAccount), SettlementError> {
        let (pubkey, resolved) = self.resolve(channel).await?;
        match resolved {
            Resolved::Live(account) if account.status == wire::ChannelStatus::Settled => {
                Err(SettlementError::ChannelSettled(channel.clone()))
            }
            Resolved::Live(account) => Ok((pubkey, account)),
            Resolved::Settled => Err(SettlementError::ChannelSettled(channel.clone())),
        }
    }

    /// Whether this backend's own signing address is `account`'s
    /// participant A (`true`) or participant B (`false`) --
    /// [`SettlementError::Backend`] if it is neither, which should never
    /// happen for a channel this backend itself opened. The one place
    /// [`counterparty_of`](Self::counterparty_of) and
    /// [`to_channel_state`](Self::to_channel_state) both need to know
    /// which side is "self".
    fn own_is_participant_a(
        &self,
        account: &wire::ChannelAccount,
    ) -> Result<bool, SettlementError> {
        let own = self.payer.pubkey();
        if account.participant_a == own {
            Ok(true)
        } else if account.participant_b == own {
            Ok(false)
        } else {
            Err(SettlementError::Backend(format!(
                "channel participants {}/{} include neither this backend's own signing address {own}",
                account.participant_a, account.participant_b
            )))
        }
    }

    /// Which side of `account` is the counterparty's identity (the other
    /// side from [`own_is_participant_a`](Self::own_is_participant_a)).
    fn counterparty_of(&self, account: &wire::ChannelAccount) -> Result<Pubkey, SettlementError> {
        Ok(if self.own_is_participant_a(account)? {
            account.participant_b
        } else {
            account.participant_a
        })
    }

    /// Derive a single [`ChannelState`] from `account`'s two-sided shape
    /// (mirrors `EvmSettlementBackend::read_state`'s own doc): `deposited`
    /// and `redeemed` are the counterparty's own `deposit_x` and
    /// `transferred_amount_x` -- what a claim signed by the counterparty
    /// is bounded against on chain (`processor.rs:770-789`), and what
    /// `redeem` actually advances (`processor.rs:800-807`).
    fn to_channel_state(
        &self,
        channel: &ChannelId,
        account: &wire::ChannelAccount,
    ) -> Result<ChannelState, SettlementError> {
        let (counterparty, deposited, redeemed) = if self.own_is_participant_a(account)? {
            (
                account.participant_b,
                account.deposit_b,
                account.transferred_amount_b,
            )
        } else {
            (
                account.participant_a,
                account.deposit_a,
                account.transferred_amount_a,
            )
        };
        Ok(ChannelState {
            id: channel.clone(),
            counterparty: counterparty.to_bytes().to_vec(),
            status: match account.status {
                wire::ChannelStatus::Opened => ChannelStatus::Open,
                wire::ChannelStatus::Closed => ChannelStatus::Closed,
                wire::ChannelStatus::Settled => ChannelStatus::Settled,
            },
            deposited: deposited as u128,
            redeemed: redeemed as u128,
        })
    }
}

enum Resolved {
    Live(wire::ChannelAccount),
    Settled,
}

async fn wait_for_confirmation(
    rpc: &RpcClient,
    signature: &solana_sdk::signature::Signature,
) -> Result<(), SettlementError> {
    for _ in 0..200 {
        if rpc.confirm_transaction(signature).await.unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(SettlementError::Backend(
        "transaction did not confirm in time".to_string(),
    ))
}

fn backend_error<E: std::fmt::Display>(error: E) -> SettlementError {
    SettlementError::Backend(error.to_string())
}

/// The port's contract suite deals in small dimensionless "amount" units,
/// which this backend passes straight through as SPL token base units with
/// no scaling: unlike the native-lamport channel this crate used to drive
/// (which needed a large multiplier to clear Solana's rent-exempt minimum
/// balance on every account), an SPL token account's own `amount` field
/// carries no such minimum -- only the *account's* lamports do, which this
/// backend never touches per unit deposited.
fn to_units(amount: u128) -> Result<u64, SettlementError> {
    u64::try_from(amount).map_err(|_| {
        SettlementError::Backend(format!(
            "amount {amount} does not fit in a u64 SPL token amount"
        ))
    })
}

#[async_trait]
impl SettlementBackend for SolanaSettlementBackend {
    async fn open(
        &self,
        counterparty: Vec<u8>,
        settlement_timeout: Duration,
    ) -> Result<ChannelId, SettlementError> {
        let counterparty_pubkey = Pubkey::try_from(counterparty.as_slice()).map_err(|_| {
            SettlementError::Backend(format!(
                "a packages/solana-program counterparty must be a 32-byte Solana pubkey, got {} bytes",
                counterparty.len()
            ))
        })?;
        let own = self.payer.pubkey();
        if counterparty_pubkey == own {
            return Err(SettlementError::Backend(
                "counterparty must differ from this backend's own signing address".to_string(),
            ));
        }
        let (channel, _bump) = wire::channel_pda(
            &own,
            &counterparty_pubkey,
            &self.token_mint,
            &self.program_id,
        );
        let (vault, _bump) = wire::vault_pda(&channel, &self.program_id);
        let seconds = settlement_timeout.num_seconds().max(0) as u64;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_initialize_channel(seconds),
            wire::Accounts::initialize_channel(
                &own,
                &own,
                &counterparty_pubkey,
                &self.token_mint,
                &channel,
                &vault,
            ),
        );
        self.submit(&[instruction], &[]).await?;
        Ok(ChannelId(channel.to_string()))
    }

    /// Deposits into the *counterparty's* own on-chain balance -- see
    /// [`SolanaSettlementBackend::counterparty_signers`]'s doc for why that
    /// requires this backend to itself hold a signing key for the
    /// counterparty, which only a [`deploy`](SolanaSettlementBackend::deploy)-built
    /// backend does. A [`connect`](SolanaSettlementBackend::connect)-built
    /// production backend refuses with [`SettlementError::Backend`] naming
    /// that gap, rather than silently depositing into its own balance
    /// instead (which `redeem`'s bound check, reading the counterparty's
    /// side, would never see).
    async fn fund(
        &self,
        channel: &ChannelId,
        amount: u128,
    ) -> Result<ChannelState, SettlementError> {
        if self.counterparty_signers.is_empty() {
            return Err(SettlementError::Backend(
                "this backend has no signing authority for an external counterparty's own \
                 on-chain deposit -- packages/solana-program's Deposit instruction requires the \
                 depositing participant to sign for themselves, so real deposits happen from the \
                 counterparty's own wallet directly against the deployed program, never through \
                 this method in production"
                    .to_string(),
            ));
        }
        let (pubkey, account) = self.open_channel(channel).await?;
        let Some(counterparty_signer) = self.counterparty_signers.iter().find(|keypair| {
            let counterparty_pubkey = keypair.pubkey();
            account.participant_a == counterparty_pubkey
                || account.participant_b == counterparty_pubkey
        }) else {
            return Err(SettlementError::Backend(
                "none of this backend's held counterparty keys is a participant of this channel"
                    .to_string(),
            ));
        };
        let counterparty_pubkey = counterparty_signer.pubkey();
        let units = to_units(amount)?;
        let depositor_token_account = spl_associated_token_account::get_associated_token_address(
            &counterparty_pubkey,
            &self.token_mint,
        );
        let (vault, _bump) = wire::vault_pda(&pubkey, &self.program_id);

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_deposit(units),
            wire::Accounts::deposit(
                &counterparty_pubkey,
                &depositor_token_account,
                &vault,
                &pubkey,
            ),
        );
        self.submit(&[instruction], &[counterparty_signer]).await?;

        let (_pubkey, account) = self.open_channel(channel).await?;
        self.to_channel_state(channel, &account)
    }

    async fn redeem(
        &self,
        channel: &ChannelId,
        claim: Claim,
    ) -> Result<ChannelState, SettlementError> {
        let (pubkey, account) = self.redeemable_channel(channel).await?;
        let state = self.to_channel_state(channel, &account)?;
        if claim.cumulative_amount <= state.redeemed {
            return Err(SettlementError::StaleClaim {
                claimed: claim.cumulative_amount,
                already_redeemed: state.redeemed,
            });
        }
        if claim.cumulative_amount > state.deposited {
            return Err(SettlementError::InsufficientChannelBalance {
                requested: claim.cumulative_amount,
                deposited: state.deposited,
            });
        }

        let counterparty_pubkey = self.counterparty_of(&account)?;
        let transferred_units = to_units(claim.cumulative_amount)?;
        let signature: [u8; 64] = claim.signature.as_slice().try_into().map_err(|_| {
            SettlementError::InvalidClaimSignature(format!(
                "a packages/solana-program claim signature must be exactly 64 bytes (a raw \
                 ed25519 signature), got {}",
                claim.signature.len()
            ))
        })?;
        let message = wire::balance_proof_message(&pubkey, claim.nonce, transferred_units);
        let ed25519_instruction =
            wire::ed25519_verify_instruction(&counterparty_pubkey, &signature, &message);
        let claim_instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_claim_from_channel(claim.nonce, transferred_units),
            wire::Accounts::claim_from_channel(&self.payer.pubkey(), &counterparty_pubkey, &pubkey),
        );
        // The Ed25519 precompile instruction must be at index 0
        // (`processor.rs:791-798`, `verify_ed25519_precompile`'s
        // `load_instruction_at_checked(0, ..)`), ahead of the program
        // instruction whose accounts and data it authorizes.
        self.submit(&[ed25519_instruction, claim_instruction], &[])
            .await?;

        let (_pubkey, account) = self.redeemable_channel(channel).await?;
        self.to_channel_state(channel, &account)
    }

    async fn close(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (pubkey, _account) = self.open_channel(channel).await?;
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_close_channel(),
            wire::Accounts::close_channel(&self.payer.pubkey(), &pubkey),
        );
        self.submit(&[instruction], &[]).await?;

        let (_pubkey, account) = self.redeemable_channel(channel).await?;
        self.to_channel_state(channel, &account)
    }

    async fn settle(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (pubkey, resolved) = self.resolve(channel).await?;
        let account = match resolved {
            Resolved::Settled => return Err(SettlementError::ChannelSettled(channel.clone())),
            Resolved::Live(account) => account,
        };
        match account.status {
            wire::ChannelStatus::Settled => {
                return Err(SettlementError::ChannelSettled(channel.clone()))
            }
            wire::ChannelStatus::Opened => {
                return Err(SettlementError::SettlementNotYetDue(channel.clone()))
            }
            wire::ChannelStatus::Closed => {}
        }
        // Mirrors `EvmSettlementBackend::settle`: the deployed program
        // itself checks `Clock::get()?.unix_timestamp`
        // (`processor.rs:524-533`), a real-clock value this process's own
        // wall clock agrees with far more closely than it would with, say,
        // an `anvil`-style artificially warped chain clock -- Solana has
        // no equivalent time-travel RPC method this backend's own tests
        // need to account for (see the `test_support` harness: a zero-length
        // challenge period is simply already due).
        let available_at = account
            .close_timestamp
            .saturating_add(account.challenge_duration as i64);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after the Unix epoch")
            .as_secs() as i64;
        if now < available_at {
            return Err(SettlementError::SettlementNotYetDue(channel.clone()));
        }

        let (vault, _bump) = wire::vault_pda(&pubkey, &self.program_id);
        let participant_a_token = spl_associated_token_account::get_associated_token_address(
            &account.participant_a,
            &self.token_mint,
        );
        let participant_b_token = spl_associated_token_account::get_associated_token_address(
            &account.participant_b,
            &self.token_mint,
        );
        let own = self.payer.pubkey();
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &wire::pack_settle_channel(),
            wire::Accounts::settle_channel(
                &own,
                &pubkey,
                &vault,
                &participant_a_token,
                &participant_b_token,
                &own,
            ),
        );
        self.submit(&[instruction], &[]).await?;

        self.settled
            .lock()
            .expect("settled mutex poisoned")
            .insert(pubkey);
        let counterparty = self.counterparty_of(&account)?;
        Ok(ChannelState {
            id: channel.clone(),
            counterparty: counterparty.to_bytes().to_vec(),
            status: ChannelStatus::Settled,
            deposited: 0,
            redeemed: 0,
        })
    }

    async fn channel_state(&self, channel: &ChannelId) -> Result<ChannelState, SettlementError> {
        let (_pubkey, resolved) = self.resolve(channel).await?;
        match resolved {
            Resolved::Live(account) => self.to_channel_state(channel, &account),
            Resolved::Settled => Ok(ChannelState {
                id: channel.clone(),
                counterparty: Vec::new(),
                status: ChannelStatus::Settled,
                deposited: 0,
                redeemed: 0,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fabricated, well-formed channel account for exercising every
    /// refusal branch of
    /// [`SolanaSettlementBackend::resolvable_counterparty`] without a
    /// validator (issue #631's mint-binding review).
    fn account(
        participant_a: Pubkey,
        participant_b: Pubkey,
        token_mint: Pubkey,
        status: wire::ChannelStatus,
    ) -> wire::ChannelAccount {
        wire::ChannelAccount {
            participant_a,
            participant_b,
            token_mint,
            deposit_a: 0,
            deposit_b: 1_000,
            transferred_amount_a: 0,
            transferred_amount_b: 0,
            nonce_a: 0,
            nonce_b: 0,
            challenge_duration: 3_600,
            status,
            close_timestamp: 0,
        }
    }

    #[test]
    fn an_open_channel_resolves_to_the_other_participant_from_either_side() {
        let own = Pubkey::new_unique();
        let counterparty = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(own, counterparty, mint, wire::ChannelStatus::Opened),
                own,
                mint,
            ),
            Some(counterparty),
            "own as participant A resolves to participant B"
        );
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(counterparty, own, mint, wire::ChannelStatus::Opened),
                own,
                mint,
            ),
            Some(counterparty),
            "own as participant B resolves to participant A"
        );
    }

    /// A merely `Closed` channel still redeems during its challenge window
    /// (issue #574), so it still resolves.
    #[test]
    fn a_closed_channel_still_resolves() {
        let own = Pubkey::new_unique();
        let counterparty = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(own, counterparty, mint, wire::ChannelStatus::Closed),
                own,
                mint,
            ),
            Some(counterparty),
        );
    }

    /// A settled channel can never be redeemed against, so honouring a
    /// claim on one would be giving the app's work away.
    #[test]
    fn a_settled_channel_resolves_to_nothing() {
        let own = Pubkey::new_unique();
        let counterparty = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(own, counterparty, mint, wire::ChannelStatus::Settled),
                own,
                mint,
            ),
            None,
        );
    }

    /// The mint binding (issue #631's security review): the deployed
    /// program lets any payer open a channel with ANY mint, and the
    /// balance-proof signature does not cover the mint, so a channel whose
    /// `token_mint` is not the one this backend settles in must be an
    /// unknown channel -- otherwise a claim funded with a worthless SPL
    /// token would buy USDC-priced writes.
    #[test]
    fn a_channel_on_a_different_mint_resolves_to_nothing() {
        let own = Pubkey::new_unique();
        let counterparty = Pubkey::new_unique();
        let configured_mint = Pubkey::new_unique();
        let junk_mint = Pubkey::new_unique();
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(own, counterparty, junk_mint, wire::ChannelStatus::Opened),
                own,
                configured_mint,
            ),
            None,
        );
    }

    /// Somebody else's channel -- neither participant is this backend --
    /// is not a channel this backend can be paid on.
    #[test]
    fn a_channel_this_backend_is_no_participant_of_resolves_to_nothing() {
        let own = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert_eq!(
            SolanaSettlementBackend::resolvable_counterparty(
                &account(
                    Pubkey::new_unique(),
                    Pubkey::new_unique(),
                    mint,
                    wire::ChannelStatus::Opened,
                ),
                own,
                mint,
            ),
            None,
        );
    }
}
