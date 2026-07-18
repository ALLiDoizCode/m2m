/**
 * Unit tests for `RateLimitedUsdcAdmin` — the permissionless, per-address-
 * per-day rate-limited mint authority (rate-limited mint redeploy; the
 * compile-coverage counterpart lives in circuit-compile.test.ts per the #352
 * lesson).
 *
 * All tests run with proofsEnabled: false on a Mina.LocalBlockchain — o1js
 * still executes every circuit assertion at tx construction, and the local
 * ledger still enforces account preconditions, token-owner approval and
 * permissions at apply time, so both rejection layers (in-proof assert and
 * on-ledger precondition) are exercised. Real compilation of this circuit is
 * covered by circuit-compile.test.ts (CJS in-process + pure-ESM child
 * process), which also pins the deployed verification key.
 *
 * Test Level: Unit (o1js LocalBlockchain, proofsEnabled: false)
 */

import { AccountUpdate, Bool, Field, Mina, PrivateKey } from 'o1js';

import { ONE_USDC } from './usdc-token';
import {
  DAILY_MINT_CAP_USDC,
  MINT_WINDOW_SLOTS,
  PER_MINT_CAP_USDC,
  RATE_LIMIT_ASSERT,
  RECEIPT_STATE_SLOT,
} from './usdc-rate-limited-admin';
import { buildSelfMintTx, deployRateLimitedUsdcToken, selfMintUsdc } from './usdc-deploy';

/** Base slot the tests anchor the first mint window at (≫ 0 + window). */
const START_SLOT = 1000;

describe('RateLimitedUsdcAdmin (rate-limited permissionless mint)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let feePayer2: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  let carol: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let deployResult: Awaited<ReturnType<typeof deployRateLimitedUsdcToken>>;

  const readReceipt = (owner: Mina.TestPublicKey): { windowStart: bigint; minted: bigint } => {
    const account = Mina.getAccount(owner, deployResult.admin.deriveTokenId());
    const appState = account.zkapp?.appState ?? [];
    return {
      windowStart: (appState[RECEIPT_STATE_SLOT.windowStart] ?? Field(0)).toBigInt(),
      minted: (appState[RECEIPT_STATE_SLOT.mintedInWindow] ?? Field(0)).toBigInt(),
    };
  };

  const balanceOf = async (owner: Mina.TestPublicKey): Promise<bigint> =>
    (await deployResult.token.getBalanceOf(owner)).toBigInt();

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, feePayer2, alice, bob, carol, adminAuthority] = Local.testAccounts;

    const adminContractKey = PrivateKey.random();
    const tokenKey = PrivateKey.random();
    deployResult = await deployRateLimitedUsdcToken({
      feePayer: deployer,
      adminAuthority,
      adminContractKey,
      tokenKey,
      signers: [deployer.key, adminContractKey, tokenKey],
      network: 'LocalBlockchain',
    });
    Local.setGlobalSlot(START_SLOT);
  });

  it('deploys the token gated by the rate-limited admin at 6 decimals', () => {
    expect(deployResult.token.decimals.get().toString()).toBe('6');
    expect(deployResult.result.adminContractAddress).toBe(deployResult.admin.address.toBase58());
  });

  it('a first self-mint under the cap succeeds and writes the mint receipt', async () => {
    const balance = await selfMintUsdc({
      token: deployResult.token,
      feePayer: deployer,
      recipient: alice,
      wholeUsdc: 400n,
      signers: [deployer.key, alice.key],
      fundNewAccounts: 2, // token account + mint-receipt account
    });
    expect(balance).toBe((400n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    expect(receipt.windowStart).toBe(BigInt(START_SLOT));
    expect(receipt.minted).toBe(400n * ONE_USDC);
  });

  it('a top-up within the same window succeeds while under the cap', async () => {
    const balance = await selfMintUsdc({
      token: deployResult.token,
      feePayer: deployer,
      recipient: alice,
      wholeUsdc: 600n,
      signers: [deployer.key, alice.key],
    });
    expect(balance).toBe((1000n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    // Window anchor unchanged; minted accumulated to the full daily cap.
    expect(receipt.windowStart).toBe(BigInt(START_SLOT));
    expect(receipt.minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('a mint that would exceed the daily cap in the same window is rejected in-proof', async () => {
    await expect(
      selfMintUsdc({
        token: deployResult.token,
        feePayer: deployer,
        recipient: alice,
        wholeUsdc: 1n,
        signers: [deployer.key, alice.key],
      })
    ).rejects.toThrow(RATE_LIMIT_ASSERT.DAILY_CAP_EXCEEDED);
    expect(await balanceOf(alice)).toBe(1000n * ONE_USDC);
  });

  it('a single mint above the per-mint cap is rejected in-proof', async () => {
    await expect(
      selfMintUsdc({
        token: deployResult.token,
        feePayer: deployer,
        recipient: bob,
        wholeUsdc: PER_MINT_CAP_USDC + 1n,
        signers: [deployer.key, bob.key],
        fundNewAccounts: 2,
      })
    ).rejects.toThrow(RATE_LIMIT_ASSERT.PER_MINT_CAP_EXCEEDED);
  });

  it('two addresses rate-limit independently in the same window', async () => {
    const balance = await selfMintUsdc({
      token: deployResult.token,
      feePayer: deployer,
      recipient: bob,
      wholeUsdc: DAILY_MINT_CAP_USDC,
      signers: [deployer.key, bob.key],
      fundNewAccounts: 2,
    });
    // Bob gets his full cap even though Alice already exhausted hers.
    expect(balance).toBe((DAILY_MINT_CAP_USDC * ONE_USDC).toString());
  });

  it('a mint after the window boundary succeeds and re-anchors the window', async () => {
    const boundary = START_SLOT + Number(MINT_WINDOW_SLOTS.toBigint());
    Local.setGlobalSlot(boundary);

    const balance = await selfMintUsdc({
      token: deployResult.token,
      feePayer: deployer,
      recipient: alice,
      wholeUsdc: DAILY_MINT_CAP_USDC,
      signers: [deployer.key, alice.key],
    });
    expect(balance).toBe((2000n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    expect(receipt.windowStart).toBe(BigInt(boundary));
    expect(receipt.minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('the LEDGER rejects a second mint proved against stale receipt state (on-chain enforcement)', async () => {
    // Build BOTH txs against carol's pre-mint (all-zero) receipt state, then
    // apply them in order — exactly the public-devnet smoke scenario. Distinct
    // fee payers isolate the failure to the receipt preconditions (no fee-payer
    // nonce interference).
    const tx1 = await buildSelfMintTx({
      token: deployResult.token,
      feePayer: deployer,
      recipient: carol,
      wholeUsdc: DAILY_MINT_CAP_USDC,
      signers: [deployer.key, carol.key],
      fundNewAccounts: 2,
    });
    const staleTx = await buildSelfMintTx({
      token: deployResult.token,
      feePayer: feePayer2,
      recipient: carol,
      wholeUsdc: 100n,
      signers: [feePayer2.key, carol.key],
    });

    await tx1.send();
    expect(await balanceOf(carol)).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);

    // The stale tx carries receipt preconditions state[0]=0/state[1]=0, which
    // no longer hold on-chain — the ledger must reject it at apply time.
    await expect(staleTx.send()).rejects.toThrow(/precondition/i);
    expect(await balanceOf(carol)).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
    expect(readReceipt(carol).minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('receipt state cannot be forged without an admin-contract proof', async () => {
    const adminTokenId = deployResult.admin.deriveTokenId();
    const before = readReceipt(alice);

    // Alice tries to reset her own receipt with a signature-only AU under the
    // admin's token id — no admin-contract (token owner) proof in the tx.
    // The token rules + the admin account's `access: proof` permission must
    // reject this, whether at construction or application.
    await expect(
      (async () => {
        const tx = await Mina.transaction({ sender: alice }, async () => {
          const au = AccountUpdate.createSigned(alice, adminTokenId);
          au.body.update.appState[RECEIPT_STATE_SLOT.windowStart] = {
            isSome: Bool(true),
            value: Field(0),
          };
          au.body.update.appState[RECEIPT_STATE_SLOT.mintedInWindow] = {
            isSome: Bool(true),
            value: Field(0),
          };
        });
        await tx.sign([alice.key]).send();
      })()
    ).rejects.toThrow();

    const after = readReceipt(alice);
    expect(after).toEqual(before);
  });
});
