/**
 * USDC in-proof settlement — REAL-Mina lightnet integration test (PR #202).
 *
 * The in-proof `UsdcChannelToken` (PR #202) moves channel-rule enforcement INTO
 * THE PROOF: the token owner's `depositToChannel` / `settleFromChannel` author the
 * escrow moves and bind them to the `PaymentChannel`'s on-chain commitment via
 * manual cross-account state preconditions. Per-PR that is only exercised with
 * `proofsEnabled:false` / mocked o1js. The novel pieces can ONLY be confirmed on a
 * real Mina node with REAL proofs:
 *
 *   - custodial-escrow `lazy-none` sends — the spike found o1js `internal.send`'s
 *     hardcoded dummy signature is REJECTED by the real OCaml ledger; the fix is a
 *     manually-authored sender AccountUpdate with `send: none` + lazy-none. A
 *     `LocalBlockchain` does not catch this — only the real ledger does.
 *   - manual cross-account state preconditions on `PaymentChannel`'s @state
 *     (`body.preconditions.account.state[i]`), applied by the REAL ledger.
 *   - the post-deposit-total precondition ORDERING (sibling `channel.deposit`
 *     applies before the token's `depositTotal` precondition in the same tx).
 *
 * This test deploys the real contracts to a running lightnet, drives one happy-path
 * deposit→close→settle with REAL proof generation (asserting on-chain USDC token
 * balances), and proves a TAMPERED settle payout is REJECTED by the node — i.e.
 * enforcement is not a LocalBlockchain artifact.
 *
 * ---------------------------------------------------------------------------
 * Test gating: only runs when MINA_INTEGRATION=true. When unset it skips cleanly
 * (mirrors `mina-lightnet.test.ts` / `standalone-mina-settlement-e2e.test.ts`).
 *
 * Local run (needs ~8GB + minutes of proving — a lightnet is NOT booted in CI PRs):
 *   make mina-up
 *   MINA_INTEGRATION=true npx jest --config jest.config.js \
 *     test/integration/mina-usdc-inproof-lightnet.test.ts --runInBand
 *   make mina-down
 *
 * The nightly (`.github/workflows/nightly-mina-lightnet.yml`) runs it on a real
 * lightnet on schedule.
 * ---------------------------------------------------------------------------
 *
 * @packageDocumentation
 */

import {
  AccountUpdate,
  Bool,
  Field,
  Mina,
  Poseidon,
  PrivateKey,
  type PublicKey,
  Signature,
  UInt32,
  UInt64,
  fetchAccount,
} from 'o1js';

// Import the COMPILED package (`dist`), NOT the TS source. The contracts use o1js
// `@method`/`@state` decorators that need `experimentalDecorators` — which the
// connector tsconfig does NOT enable — so letting ts-jest recompile the package
// `src` (what the bare `@toon-protocol/mina-zkapp` jest moduleNameMapper does)
// fails TS1240/TS1241. The `dist/*` deep imports bypass that mapper and load the
// already-compiled CJS (the nightly's "Build mina-zkapp" step builds it first).
import { PaymentChannel, UsdcChannelToken, CHANNEL_STATE } from '@toon-protocol/mina-zkapp/dist';
import {
  FungibleTokenAdmin,
  usdcDeployProps,
  USDC_DECIMALS_U8,
  ONE_USDC,
} from '@toon-protocol/mina-zkapp/dist/usdc-token';

import {
  waitForMinaReady,
  acquireFundedAccount,
  releaseFundedAccount,
  MINA_GRAPHQL_URL,
  sleep,
} from './mina-helpers';
import type { MinaFundedAccount } from './mina-helpers';

// ───────────────────────────────────────────────────────────────────────────
// Gating + timing
// ───────────────────────────────────────────────────────────────────────────

const RUN_MINA = process.env.MINA_INTEGRATION === 'true';
const describeMina = RUN_MINA ? describe : describe.skip;

// Compile (3 contracts) + several real proofs + multiple block confirmations is
// slow; give the whole suite a generous ceiling. The nightly job allots 60 min.
jest.setTimeout(30 * 60_000);

/**
 * Conventional zkApp fee (0.1 MINA = 100_000_000 nanomina), as a decimal string —
 * o1js's `Mina.transaction` fee field takes `string | number | UInt64`, and the
 * SDK (`DEFAULT_MINA_TX_FEE_NANOMINA`) likewise passes it as a string. Real nodes
 * reject zero-fee zkApp txs ("Insufficient fee").
 */
const TX_FEE = '100000000';

/** How long to wait for a submitted tx to be included + observable on-chain. */
const INCLUSION_TIMEOUT_MS = 6 * 60_000;
const INCLUSION_POLL_MS = 5_000;

// ───────────────────────────────────────────────────────────────────────────
// Lightnet tx helpers (REAL network — no LocalBlockchain.setGlobalSlot here)
// ───────────────────────────────────────────────────────────────────────────

/** A funded lightnet account turned into an o1js keypair. */
interface Signer {
  priv: PrivateKey;
  pub: PublicKey;
}

function toSigner(acct: MinaFundedAccount): Signer {
  const priv = PrivateKey.fromBase58(acct.privateKey);
  return { priv, pub: priv.toPublicKey() };
}

/** Refresh o1js's account cache for `pub` from the node (state + nonce + balance). */
async function refresh(pub: PublicKey, tokenId?: Field): Promise<void> {
  await fetchAccount(tokenId ? { publicKey: pub, tokenId } : { publicKey: pub });
}

/**
 * Build → prove → sign → send a transaction, then BLOCK until it is included
 * (observable by re-fetching `confirmAccount`). Real proving + block production,
 * so this can take a minute-plus per tx.
 */
async function sendTx(
  feePayer: Signer,
  build: () => Promise<void>,
  extraSigners: PrivateKey[],
  confirmAccount: { publicKey: PublicKey; tokenId?: Field }
): Promise<void> {
  await refresh(feePayer.pub);
  const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, build);
  await tx.prove();
  const pending = await tx.sign([feePayer.priv, ...extraSigners]).send();
  // `wait()` resolves once the tx is included in a block (lightnet ~ tens of sec).
  await pending.wait({
    maxAttempts: Math.ceil(INCLUSION_TIMEOUT_MS / INCLUSION_POLL_MS),
    interval: INCLUSION_POLL_MS,
  });
  await fetchAccount(
    confirmAccount.tokenId ? confirmAccount : { publicKey: confirmAccount.publicKey }
  );
}

/** Current network global slot (UInt32) as read from the node. */
async function currentGlobalSlot(): Promise<bigint> {
  const res = await fetch(MINA_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query:
        '{ bestChain(maxLength: 1) { protocolState { consensusState { slotSinceGenesis } } } }',
    }),
  });
  const data = (await res.json()) as {
    data?: {
      bestChain?: Array<{ protocolState: { consensusState: { slotSinceGenesis: string } } }>;
    };
  };
  const slot = data?.data?.bestChain?.[0]?.protocolState?.consensusState?.slotSinceGenesis;
  if (slot == null) throw new Error('could not read global slot from lightnet GraphQL');
  return BigInt(slot);
}

/** Block until the network global slot reaches `deadline` (the settle window). */
async function waitForGlobalSlot(
  deadline: bigint,
  timeoutMs = INCLUSION_TIMEOUT_MS
): Promise<void> {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    if ((await currentGlobalSlot()) >= deadline) return;
    if (Date.now() >= stop) {
      throw new Error(`global slot did not reach ${deadline} within ${timeoutMs}ms`);
    }
    await sleep(INCLUSION_POLL_MS);
  }
}

/** Read a USDC token balance (base units) for `owner` under the USDC token id. */
async function tokenBalance(token: UsdcChannelToken, owner: PublicKey): Promise<bigint> {
  await fetchAccount({ publicKey: owner, tokenId: token.deriveTokenId() });
  return (await token.getBalanceOf(owner)).toBigInt();
}

// ───────────────────────────────────────────────────────────────────────────
// Suite
// ───────────────────────────────────────────────────────────────────────────

describeMina('USDC in-proof settlement — real-Mina lightnet (PR #202)', () => {
  // Funded lightnet accounts (released in afterAll).
  const acquired: MinaFundedAccount[] = [];

  let feePayer: Signer; // deploys + pays fees
  let participantA: Signer; // depositor + refund recipient
  let participantB: Signer; // payout recipient

  // Fresh keys for the deployed contracts (not funded — created as new accounts).
  const channelKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();
  const adminKey = PrivateKey.random();

  let channel: PaymentChannel;
  let token: UsdcChannelToken;
  let admin: FungibleTokenAdmin;

  // Channel parameters.
  const channelNonce = Field(7);
  // SMALL settlement timeout: on a real lightnet we cannot fast-forward slots, so
  // the challenge window must elapse by waiting a handful of real blocks.
  const settlementTimeoutSlots = 3n;

  // Amounts.
  const DEPOSIT = 1000n * ONE_USDC;
  const BAL_A = 400n * ONE_USDC; // refund to A
  const BAL_B = 600n * ONE_USDC; // payout to B
  const salt = Field(50_021);

  // Captured at initiateClose so settle can witness the (un-forgeable) deadline.
  let closedAtSlot = 0n;

  beforeAll(async () => {
    await waitForMinaReady();

    // Point o1js at the lightnet.
    Mina.setActiveInstance(Mina.Network(MINA_GRAPHQL_URL));

    // Funded accounts: fee payer (also deployer), A (depositor), B (recipient).
    const f = await acquireFundedAccount();
    const a = await acquireFundedAccount();
    const b = await acquireFundedAccount();
    acquired.push(f, a, b);
    feePayer = toSigner(f);
    participantA = toSigner(a);
    participantB = toSigner(b);

    channel = new PaymentChannel(channelKey.toPublicKey());
    token = new UsdcChannelToken(tokenKey.toPublicKey());
    admin = new FungibleTokenAdmin(adminKey.toPublicKey());

    // Compile all three circuits with REAL proofs (slow — minutes).
    await FungibleTokenAdmin.compile();
    await UsdcChannelToken.compile();
    await PaymentChannel.compile();
  });

  afterAll(async () => {
    for (const acct of acquired) {
      await releaseFundedAccount(acct.publicKey).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // 1. HAPPY PATH — deploy, escrow, deposit, close, settle, assert balances.
  // -------------------------------------------------------------------------
  it('deposits to escrow, then settle drains escrow to A/B exactly (REAL proofs, on-chain balances)', async () => {
    const channelAddr = channelKey.toPublicKey();
    const adminAuthority = feePayer; // funded account that signs mints

    // ── Deploy USDC (admin + token) + initialize. 3 new accounts (admin, token,
    //    circulation), exactly like usdc-token.test.ts's deploy.
    await sendTx(
      feePayer,
      async () => {
        AccountUpdate.fundNewAccount(feePayer.pub, 3);
        await admin.deploy({ adminPublicKey: adminAuthority.pub });
        await token.deploy(usdcDeployProps);
        await token.initialize(adminKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
      },
      [adminKey, tokenKey],
      { publicKey: tokenKey.toPublicKey() }
    );

    // ── Deploy the bare PaymentChannel zkApp.
    await sendTx(
      feePayer,
      async () => {
        AccountUpdate.fundNewAccount(feePayer.pub);
        await channel.deploy();
      },
      [channelKey],
      { publicKey: channelAddr }
    );

    // ── Initialize the channel between A and B (both participants sign).
    await refresh(channelAddr);
    await sendTx(
      feePayer,
      async () => {
        await channel.initializeChannel(
          participantA.pub,
          participantB.pub,
          channelNonce,
          Field(settlementTimeoutSlots),
          token.deriveTokenId()
        );
      },
      [participantA.priv, participantB.priv],
      { publicKey: channelAddr }
    );

    // ── Mint DEPOSIT USDC to A (admin authority signs; fund A's token account).
    await sendTx(
      adminAuthority,
      async () => {
        AccountUpdate.fundNewAccount(adminAuthority.pub, 1);
        await token.mint(participantA.pub, UInt64.from(DEPOSIT));
      },
      [adminAuthority.priv],
      { publicKey: participantA.pub, tokenId: token.deriveTokenId() }
    );
    expect(await tokenBalance(token, participantA.pub)).toBe(DEPOSIT);

    // ── enableChannelEscrow: make the escrow token account custodial. The CHANNEL
    //    KEY signs this ONE time (the only channel-key signature in the flow);
    //    pays the escrow token account's new-account fee.
    await sendTx(
      feePayer,
      async () => {
        AccountUpdate.fundNewAccount(feePayer.pub, 1);
        await token.enableChannelEscrow(channelAddr);
      },
      [channelKey],
      { publicKey: channelAddr, tokenId: token.deriveTokenId() }
    );

    // ── depositToChannel: deposit → escrow, bound in-proof to OPEN + post-total.
    //    ORDER MATTERS: channel.deposit (accounting) must precede the token's
    //    depositTotal precondition AU so the ledger sees the post-deposit total.
    //    The depositor (A) signs; first deposit → current depositTotal is 0.
    await refresh(channelAddr);
    await refresh(participantA.pub, token.deriveTokenId());
    await sendTx(
      participantA,
      async () => {
        await channel.deposit(Field(DEPOSIT), participantA.pub);
        await token.depositToChannel(
          channelAddr,
          UInt64.from(DEPOSIT),
          participantA.pub,
          Field(DEPOSIT) // 0 + DEPOSIT
        );
      },
      [participantA.priv],
      { publicKey: channelAddr, tokenId: token.deriveTokenId() }
    );

    // The escrow (channel's token account) holds the full deposit; A is drained.
    expect(await tokenBalance(token, channelAddr)).toBe(DEPOSIT);
    expect(await tokenBalance(token, participantA.pub)).toBe(0n);
    await refresh(channelAddr);
    expect(channel.depositTotal.get().toString()).toBe(Field(DEPOSIT).toString());

    // ── Record a single dual-signed claim (balA/balB) to set the commitment.
    const channelHash = Poseidon.hash([participantA.pub.x, participantB.pub.x, channelNonce]);
    const newCommitment = Poseidon.hash([Field(BAL_A), Field(BAL_B), salt]);
    const claimNonce = Field(1);
    const claimMsg = [newCommitment, claimNonce, channelHash];
    const claimSigA = Signature.create(participantA.priv, claimMsg);
    const claimSigB = Signature.create(participantB.priv, claimMsg);
    await refresh(channelAddr);
    await sendTx(
      feePayer,
      async () => {
        await channel.claimFromChannel(
          Field(BAL_A),
          Field(BAL_B),
          salt,
          claimSigA,
          claimSigB,
          participantA.pub,
          participantB.pub,
          channelNonce,
          newCommitment,
          claimNonce
        );
      },
      [],
      { publicKey: channelAddr }
    );

    // ── Cooperative close (CLOSING) — records closedAtSlot from the network.
    //    #202: initiateClose now takes a `currentSlot` witness pinned to "~now" by
    //    a range precondition (the exact-slot precondition it replaced is
    //    unsatisfiable on a real chain). Read the live network slot off-chain and
    //    pass it, exactly as settle witnesses closedAtSlot from the chain.
    const closeMsg = [Field(BAL_A), Field(BAL_B), salt, Field(2)];
    const closeSigA = Signature.create(participantA.priv, closeMsg);
    const closeSigB = Signature.create(participantB.priv, closeMsg);
    await refresh(channelAddr);
    const closeCurrentSlot = UInt32.from(await currentGlobalSlot());
    await sendTx(
      feePayer,
      async () => {
        await channel.initiateClose(
          Field(BAL_A),
          Field(BAL_B),
          salt,
          Field(2),
          closeSigA,
          closeSigB,
          closeCurrentSlot
        );
      },
      [],
      { publicKey: channelAddr }
    );

    await refresh(channelAddr);
    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    closedAtSlot = (channel.closedAtSlot.get() as Field).toBigInt();
    expect(closedAtSlot).toBeGreaterThan(0n);

    // ── Wait out the challenge period on the REAL chain, then settle.
    const deadline = closedAtSlot + settlementTimeoutSlots;
    await waitForGlobalSlot(deadline);

    // First the TAMPER check at the same pre-settle state (see test 2 below): a
    // settle whose payout != committed balance must be REJECTED by the node. We
    // run it HERE (channel still CLOSING, escrow intact) so it does not need its
    // own full deploy. balanceB tampered to 700 → Poseidon(400,700,salt) != commit.
    await refresh(channelAddr);
    await expect(
      (async () => {
        await refresh(feePayer.pub);
        const tx = await Mina.transaction({ sender: feePayer.pub, fee: TX_FEE }, async () => {
          AccountUpdate.fundNewAccount(feePayer.pub, 1);
          await token.settleFromChannel(
            channelAddr,
            UInt64.from(BAL_A),
            UInt64.from(700n * ONE_USDC), // tampered: != committed BAL_B
            salt,
            participantA.pub,
            participantB.pub,
            channelNonce,
            UInt32.from(closedAtSlot),
            UInt32.from(settlementTimeoutSlots)
          );
          await channel.settle(
            Field(BAL_A),
            Field(700n * ONE_USDC),
            salt,
            participantA.pub,
            participantB.pub,
            channelNonce
          );
        });
        await tx.prove();
        await tx.sign([feePayer.priv]).send();
      })()
    ).rejects.toThrow();

    // Tamper rejected → channel is still CLOSING and the escrow is intact.
    await refresh(channelAddr);
    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    expect(await tokenBalance(token, channelAddr)).toBe(DEPOSIT);

    // ── Honest settle (NO channel-key signature — fee payer only). Custodial
    //    escrow lazy-none sends + cross-account preconditions on the REAL ledger.
    //    B needs a new token account (A already has one from the mint).
    await refresh(channelAddr);
    await sendTx(
      feePayer,
      async () => {
        AccountUpdate.fundNewAccount(feePayer.pub, 1);
        await token.settleFromChannel(
          channelAddr,
          UInt64.from(BAL_A),
          UInt64.from(BAL_B),
          salt,
          participantA.pub,
          participantB.pub,
          channelNonce,
          UInt32.from(closedAtSlot),
          UInt32.from(settlementTimeoutSlots)
        );
        await channel.settle(
          Field(BAL_A),
          Field(BAL_B),
          salt,
          participantA.pub,
          participantB.pub,
          channelNonce
        );
      },
      [], // fee payer ONLY — the channel key does NOT sign settle
      { publicKey: channelAddr }
    );

    // ── On-chain assertions: channel SETTLED, participants paid EXACTLY their
    //    committed balances, escrow drained to zero (real-ledger confirmation).
    await refresh(channelAddr);
    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect(await tokenBalance(token, participantA.pub)).toBe(BAL_A);
    expect(await tokenBalance(token, participantB.pub)).toBe(BAL_B);
    expect(await tokenBalance(token, channelAddr)).toBe(0n);
  });
});
