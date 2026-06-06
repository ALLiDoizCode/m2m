/**
 * Solana claim_from_channel — fee-payer / non-signer split, REAL on-chain E2E (#99 / #101)
 *
 * Proves the post-#99 account layout end-to-end against the LOCAL docker
 * `solana-validator` over JSON-RPC (NOT bankrun):
 *
 *   account 0 = fee_payer / submitter   = the CONNECTOR (signs + pays the tx)
 *   account 1 = claiming participant    = the PEER (a NON-signer; its sole
 *                                          authorization is the Ed25519
 *                                          precompile over the balance proof)
 *
 * The connector unilaterally redeems an inbound peer's signed balance proof:
 * the peer signs ONLY the 48-byte balance-proof message (verified by the
 * Ed25519 precompile at instruction index 0); the peer does NOT co-sign the
 * Solana transaction. This test asserts the claim confirms with a real tx
 * signature and that on-chain channel state credits the peer's
 * (nonce, transferred_amount) — while the peer never signed the tx.
 *
 * NO MOCKS (project rule). The test self-provisions everything over RPC using
 * the connector's own SolanaPaymentChannelSDK plus @solana-program/token:
 *   - airdrops SOL to the connector fee-payer,
 *   - creates an SPL mint + ATAs and mints tokens,
 *   - opens a channel PDA and deposits,
 *   - signs a COUNTERPARTY (peer) balance proof,
 *   - submits claim_from_channel through the SDK with the new layout,
 *   - reads back getChannelState and asserts the peer side was credited.
 *
 * Prerequisites (LOCAL only):
 *   make solana-up                 # docker solana-validator at :8899 with the
 *                                  # payment-channel program deployed at
 *                                  # SOLANA_TEST_PROGRAM_ID (see infra/solana)
 *   SOLANA_INTEGRATION=true \
 *   SOLANA_TEST_PROGRAM_ID=EjdqGLoYpwiP7J8ufZjSiuE759ixAwV7A7Z5txBoFSUH \
 *   npx jest test/integration/solana-claim-feepayer-onchain-e2e.test.ts
 *
 * If the validator is unreachable or no program id is supplied, the on-chain
 * test self-skips cleanly (mirroring the other gated Solana suites).
 *
 * @packageDocumentation
 */

import {
  generateKeyPairSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getAddressEncoder,
  getU32Encoder,
  getU64Encoder,
  getStructEncoder,
  AccountRole,
} from '@solana/kit';
import type { Address, TransactionSigner, Instruction, KeyPairSigner } from '@solana/kit';
import {
  getInitializeMint2Instruction,
  getMintToInstruction,
  getCreateAssociatedTokenInstructionAsync,
  findAssociatedTokenPda,
  getMintSize,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

import { SolanaPaymentChannelSDK } from '../../src/settlement/solana-payment-channel-sdk';
import { createLogger } from '../../src/utils/logger';

// ────────────────────────────────────────────────────────────────────────────
// Gating
// ────────────────────────────────────────────────────────────────────────────

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
// A Solana validator serves the PubSub WebSocket on rpc_port + 1 (RPC :8899 →
// WS :8900). Increment the explicit port; fall back to a scheme swap otherwise.
const SOLANA_WS_URL = (() => {
  try {
    const u = new URL(SOLANA_RPC_URL);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (u.port) u.port = String(Number(u.port) + 1);
    return u.toString();
  } catch {
    return SOLANA_RPC_URL.replace('http', 'ws');
  }
})();
const PROGRAM_ID = process.env.SOLANA_TEST_PROGRAM_ID;
const RUN = process.env.SOLANA_INTEGRATION === 'true' && !!PROGRAM_ID;
const describeOnChain = RUN ? describe : describe.skip;

const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;

jest.setTimeout(180_000);

// ────────────────────────────────────────────────────────────────────────────
// Minimal SystemProgram.createAccount instruction (no @solana-program/system dep)
// data: u32 instruction index (0) || u64 lamports || u64 space || 32-byte owner
// ────────────────────────────────────────────────────────────────────────────

function buildCreateAccountInstruction(opts: {
  payer: TransactionSigner;
  newAccount: TransactionSigner;
  lamports: bigint;
  space: bigint;
  owner: Address;
}): Instruction {
  const dataEncoder = getStructEncoder([
    ['instruction', getU32Encoder()],
    ['lamports', getU64Encoder()],
    ['space', getU64Encoder()],
    ['owner', getAddressEncoder()],
  ]);
  const data = dataEncoder.encode({
    instruction: 0,
    lamports: opts.lamports,
    space: opts.space,
    owner: opts.owner,
  });
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: opts.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: opts.payer },
      {
        address: opts.newAccount.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: opts.newAccount,
      },
    ],
    data,
  } as unknown as Instruction;
}

// ────────────────────────────────────────────────────────────────────────────

describeOnChain(
  'Solana claim_from_channel fee-payer/non-signer split — on-chain (#99/#101)',
  () => {
    const logger = createLogger('solana-claim-onchain', 'warn');

    // Built lazily in beforeAll once we know the validator is reachable.
    let reachable = false;
    let rpc: ReturnType<typeof createSolanaRpc>;
    let rpcSubs: ReturnType<typeof createSolanaRpcSubscriptions>;
    let sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
    let sdk: SolanaPaymentChannelSDK;

    /** Airdrop SOL via the raw requestAirdrop RPC, then poll until confirmed. */
    async function airdropSol(recipient: Address, sol: bigint): Promise<void> {
      // createSolanaRpc returns an all-cluster union that does not surface
      // requestAirdrop on its public type; it IS available on the local validator.
      const airdropRpc = rpc as unknown as {
        requestAirdrop: (
          recipient: Address,
          amount: ReturnType<typeof lamports>
        ) => { send: () => Promise<string> };
      };
      const sig = await airdropRpc.requestAirdrop(recipient, lamports(sol * 1_000_000_000n)).send();
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { value } = await rpc
          .getSignatureStatuses([
            sig as unknown as Parameters<typeof rpc.getSignatureStatuses>[0][0],
          ])
          .send();
        const status = value[0];
        if (
          status &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ) {
          return;
        }
        if (Date.now() > deadline) throw new Error(`Airdrop to ${recipient} not confirmed in time`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    async function isReachable(): Promise<boolean> {
      try {
        const res = await fetch(SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    /** Build, sign (with all account signers), submit + confirm a tx. */
    async function submit(
      feePayer: TransactionSigner,
      instructions: Instruction[]
    ): Promise<string> {
      const { value: blockhash } = await rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m) => appendTransactionMessageInstructions(instructions as any, m)
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signed = await signTransactionMessageWithSigners(message as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendAndConfirm(signed as any, { commitment: 'confirmed' });
      return getSignatureFromTransaction(signed);
    }

    beforeAll(async () => {
      reachable = await isReachable();
      if (!reachable) return;
      rpc = createSolanaRpc(SOLANA_RPC_URL);
      rpcSubs = createSolanaRpcSubscriptions(SOLANA_WS_URL);
      sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcSubs });
      sdk = new SolanaPaymentChannelSDK(SOLANA_RPC_URL, PROGRAM_ID!, logger);
    });

    it('provisions a channel and redeems a PEER balance proof with the CONNECTOR as fee-payer (peer never signs the tx)', async () => {
      if (!reachable) {
        // eslint-disable-next-line no-console
        console.warn(
          `Solana validator not reachable at ${SOLANA_RPC_URL} — skipping on-chain claim.`
        );
        return;
      }

      // ── Actors ───────────────────────────────────────────────────────────────
      // connector = fee-payer/submitter (signs + pays). peer = claiming participant
      // (credited; authorizes only via the Ed25519 precompile, NEVER signs the tx).
      const connector: KeyPairSigner = await generateKeyPairSigner();
      const peer: KeyPairSigner = await generateKeyPairSigner();
      const mint: KeyPairSigner = await generateKeyPairSigner();

      // Fund ONLY the connector. The peer is deliberately left unfunded to make the
      // "peer does not sign / pay" property concrete: a peer that never signs the
      // tx needs no lamports.
      await airdropSol(connector.address, 2n); // 2 SOL

      // ── SPL mint ──────────────────────────────────────────────────────────────
      const mintSpace = BigInt(getMintSize());
      const rentLamports = await rpc.getMinimumBalanceForRentExemption(mintSpace).send();
      const createMintAccountIx = buildCreateAccountInstruction({
        payer: connector,
        newAccount: mint,
        lamports: rentLamports,
        space: mintSpace,
        owner: TOKEN_PROGRAM_ADDRESS,
      });
      const initMintIx = getInitializeMint2Instruction({
        mint: mint.address,
        decimals: 6,
        mintAuthority: connector.address,
        freezeAuthority: null,
      });
      await submit(connector, [createMintAccountIx, initMintIx]);

      // ── ATAs for both participants ──────────────────────────────────────────────
      const [connectorAta] = await findAssociatedTokenPda({
        owner: connector.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: mint.address,
      });
      const createConnectorAtaIx = await getCreateAssociatedTokenInstructionAsync({
        payer: connector,
        owner: connector.address,
        mint: mint.address,
      });
      const createPeerAtaIx = await getCreateAssociatedTokenInstructionAsync({
        payer: connector, // connector pays rent for the peer's ATA too
        owner: peer.address,
        mint: mint.address,
      });
      const mintToConnectorIx = getMintToInstruction({
        mint: mint.address,
        token: connectorAta,
        mintAuthority: connector,
        amount: 1_000_000n,
      });
      await submit(connector, [createConnectorAtaIx, createPeerAtaIx, mintToConnectorIx]);

      // ── Open channel (connector ⇄ peer) + deposit ───────────────────────────────
      const { channelPDA, txSignature: openSig } = await sdk.openChannel(
        connector,
        connector.address,
        peer.address,
        mint.address,
        3600n // challenge duration (seconds)
      );
      expect(typeof openSig).toBe('string');
      expect(openSig.length).toBeGreaterThan(0);

      const depositAmount = 500_000n;
      await sdk.deposit(connector, channelPDA, connectorAta, depositAmount);

      // ── Determine which side the PEER is (program sorts participants) ────────────
      const pre = await sdk.getChannelState(channelPDA);
      const peerIsA = pre.participantA === peer.address;
      const peerIsB = pre.participantB === peer.address;
      expect(peerIsA || peerIsB).toBe(true);
      const preNonce = peerIsA ? pre.nonceA : pre.nonceB;
      const preTransferred = peerIsA ? pre.transferredAmountA : pre.transferredAmountB;

      // ── Build a COUNTERPARTY (peer) balance proof ───────────────────────────────
      // The peer signs ONLY the 48-byte balance-proof message with its own key.
      const nonce = preNonce + 1n;
      const transferredAmount = preTransferred + 250_000n;
      const peerSignature = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        nonce,
        transferredAmount,
        // KeyPairSigner exposes a Web Crypto CryptoKeyPair compatible with signBytes.
        peer.keyPair
      );
      expect(peerSignature.length).toBe(64);

      // ── Claim: CONNECTOR is fee-payer/signer; PEER is index-1 non-signer ─────────
      // signerPublicKey = peer.address tells the Ed25519 precompile which key signed
      // the proof. The peer does NOT appear as a tx signer — only `connector` does.
      const claim = await sdk.claimFromChannel(
        connector, // index 0: fee-payer/submitter (signs + pays)
        channelPDA,
        nonce,
        transferredAmount,
        peerSignature,
        peer.address // index 1: credited participant, precompile-authorized non-signer
      );
      expect(typeof claim.txSignature).toBe('string');
      expect(claim.txSignature.length).toBeGreaterThan(0);

      // ── Prove the PEER did NOT sign the on-chain transaction ─────────────────────
      // Fetch the confirmed tx and assert the connector is the (only) signer and the
      // peer's pubkey is NOT among the required signers (header.numRequiredSignatures
      // accounts at the front of accountKeys).
      const tx = await rpc
        .getTransaction(claim.txSignature as unknown as Parameters<typeof rpc.getTransaction>[0], {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send();
      expect(tx).not.toBeNull();
      const msg = tx!.transaction.message as unknown as {
        header: { numRequiredSignatures: number };
        accountKeys: string[];
      };
      const numSigners = msg.header.numRequiredSignatures;
      const signerKeys = msg.accountKeys.slice(0, numSigners);
      // Exactly one required signer, and it is the connector — not the peer.
      expect(numSigners).toBe(1);
      expect(signerKeys).toContain(connector.address as unknown as string);
      expect(signerKeys).not.toContain(peer.address as unknown as string);

      // ── On-chain state credits the PEER side ────────────────────────────────────
      const post = await sdk.getChannelState(channelPDA);
      const postNonce = peerIsA ? post.nonceA : post.nonceB;
      const postTransferred = peerIsA ? post.transferredAmountA : post.transferredAmountB;
      expect(postNonce).toBe(nonce);
      expect(postTransferred).toBe(transferredAmount);

      // Sanity: the OTHER (connector) side was untouched by this peer claim.
      const otherNonce = peerIsA ? post.nonceB : post.nonceA;
      expect(otherNonce).toBe(peerIsA ? pre.nonceB : pre.nonceA);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            event: 'onchain_claim_proof',
            programId: PROGRAM_ID,
            channelPDA,
            claimTxSignature: claim.txSignature,
            feePayerSigner: connector.address,
            creditedPeerParticipant: peer.address,
            peerSignedTx: signerKeys.includes(peer.address as unknown as string),
            before: { nonce: preNonce.toString(), transferred: preTransferred.toString() },
            after: { nonce: postNonce.toString(), transferred: postTransferred.toString() },
          },
          null,
          2
        )
      );
    });
  }
);
