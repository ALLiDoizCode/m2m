/**
 * Unit tests for `PermissionlessRateLimitedUsdcAdmin` — the FULLY permissionless,
 * per-recipient-per-day rate-limited mint authority (permissionless-mint
 * redeploy; the compile-coverage counterpart lives in circuit-compile.test.ts
 * per the #352 lesson).
 *
 * The distinguishing property vs `RateLimitedUsdcAdmin`: the RECIPIENT NEVER
 * signs. Every mint here is signed by the FEE PAYER only; a recipient key is
 * never on the signer list. The receipt counter is an increase-only packed
 * balance under the admin's token id (see usdc-permissionless-admin.ts).
 *
 * All tests run with proofsEnabled: false on a Mina.LocalBlockchain — o1js still
 * executes every circuit assertion at tx construction, and the local ledger
 * still enforces account preconditions, token-owner approval and permissions at
 * apply time, so both rejection layers (in-proof assert and on-ledger
 * precondition) are exercised. Real compilation of this circuit is covered by
 * circuit-compile.test.ts (CJS in-process + pure-ESM child process), which also
 * pins the deployed verification key.
 *
 * Test Level: Unit (o1js LocalBlockchain, proofsEnabled: false)
 */

import { AccountUpdate, Field, Mina, PrivateKey, UInt64 } from 'o1js';

import { ONE_USDC } from './usdc-token';
import {
  DAILY_MINT_CAP_USDC,
  MINT_WINDOW_SLOTS,
  PER_MINT_CAP_USDC,
  RATE_LIMIT_ASSERT,
  decodeReceiptBalance,
} from './usdc-permissionless-admin';
import { buildMintTx, deployPermissionlessUsdcToken, mintUsdcPermissionless } from './usdc-deploy';

/** Base slot the tests anchor the first mint window at (≫ 0 + window). */
const START_SLOT = 1000;
/** LocalBlockchain account-creation fee (1 MINA), in nanomina. */
const ACCOUNT_CREATION_FEE = 1_000_000_000n;

describe('PermissionlessRateLimitedUsdcAdmin (permissionless mint, no recipient signature)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let feePayer2: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  let carol: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let deployResult: Awaited<ReturnType<typeof deployPermissionlessUsdcToken>>;

  const readReceipt = (owner: Mina.TestPublicKey): { windowStart: bigint; minted: bigint } => {
    let packed = 0n;
    try {
      packed = Mina.getAccount(owner, deployResult.admin.deriveTokenId()).balance.toBigInt();
    } catch {
      packed = 0n;
    }
    const d = decodeReceiptBalance(packed);
    return { windowStart: d.windowStart, minted: d.mintedInWindow };
  };

  const balanceOf = async (owner: Mina.TestPublicKey): Promise<bigint> =>
    (await deployResult.token.getBalanceOf(owner)).toBigInt();

  const minaBalance = (pk: Mina.TestPublicKey): bigint => Mina.getBalance(pk).toBigInt();

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, feePayer2, alice, bob, carol, adminAuthority] = Local.testAccounts;

    const adminContractKey = PrivateKey.random();
    const tokenKey = PrivateKey.random();
    deployResult = await deployPermissionlessUsdcToken({
      feePayer: deployer,
      adminAuthority,
      adminContractKey,
      tokenKey,
      signers: [deployer.key, adminContractKey, tokenKey],
      network: 'LocalBlockchain',
    });
    Local.setGlobalSlot(START_SLOT);
  });

  it('deploys the token gated by the permissionless admin at 6 decimals', () => {
    expect(deployResult.token.decimals.get().toString()).toBe('6');
    expect(deployResult.result.adminContractAddress).toBe(deployResult.admin.address.toBase58());
  });

  it('fee payer A mints to recipient B (B does NOT sign) under cap → succeeds, receipt written', async () => {
    // ONLY the fee payer signs — alice.key is deliberately NOT in `signers`.
    const balance = await mintUsdcPermissionless({
      token: deployResult.token,
      feePayer: deployer,
      recipient: alice,
      wholeUsdc: 400n,
      signers: [deployer.key],
      fundNewAccounts: 2, // token account + mint-receipt account
    });
    expect(balance).toBe((400n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    expect(receipt.windowStart).toBe(BigInt(START_SLOT));
    expect(receipt.minted).toBe(400n * ONE_USDC);
  });

  it('the FEE PAYER funds the fresh recipient token + receipt accounts (2 creation fees)', async () => {
    // A second fee payer mints to a brand-new recipient (bob) and pays exactly
    // two account-creation fees (token account + receipt account).
    const before = minaBalance(feePayer2);
    await mintUsdcPermissionless({
      token: deployResult.token,
      feePayer: feePayer2,
      recipient: bob,
      wholeUsdc: 100n,
      signers: [feePayer2.key],
      fundNewAccounts: 2,
    });
    const after = minaBalance(feePayer2);
    const spent = before - after;
    // Spent = 2 account-creation fees + the zkApp tx fee (0.1 MINA). Assert the
    // creation-fee portion is exactly 2 MINA (the rest is the flat tx fee).
    expect(spent - 2n * ACCOUNT_CREATION_FEE).toBeGreaterThan(0n);
    expect(spent - 2n * ACCOUNT_CREATION_FEE).toBeLessThan(ACCOUNT_CREATION_FEE);
    expect(await balanceOf(bob)).toBe(100n * ONE_USDC);
  });

  it('a first mint that omits the account-creation funding is rejected', async () => {
    await expect(
      mintUsdcPermissionless({
        token: deployResult.token,
        feePayer: deployer,
        recipient: carol,
        wholeUsdc: 100n,
        signers: [deployer.key],
        fundNewAccounts: 0, // WRONG: carol's token + receipt accounts are fresh
      })
    ).rejects.toThrow();
    expect(await balanceOf(carol)).toBe(0n);
  });

  it('a same-window top-up by ANY fee payer succeeds while under the cap', async () => {
    // Different fee payer (feePayer2), recipient alice still never signs.
    const balance = await mintUsdcPermissionless({
      token: deployResult.token,
      feePayer: feePayer2,
      recipient: alice,
      wholeUsdc: 600n,
      signers: [feePayer2.key],
    });
    expect(balance).toBe((1000n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    expect(receipt.windowStart).toBe(BigInt(START_SLOT));
    expect(receipt.minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('a mint that would exceed the daily cap in the same window is rejected in-proof', async () => {
    await expect(
      mintUsdcPermissionless({
        token: deployResult.token,
        feePayer: deployer,
        recipient: alice,
        wholeUsdc: 1n,
        signers: [deployer.key],
      })
    ).rejects.toThrow(RATE_LIMIT_ASSERT.DAILY_CAP_EXCEEDED);
    expect(await balanceOf(alice)).toBe(1000n * ONE_USDC);
  });

  it('a single mint above the per-mint cap is rejected in-proof', async () => {
    const dave = Local.testAccounts[6] ?? PrivateKey.random().toPublicKey();
    await expect(
      mintUsdcPermissionless({
        token: deployResult.token,
        feePayer: deployer,
        recipient: dave as Mina.TestPublicKey,
        wholeUsdc: PER_MINT_CAP_USDC + 1n,
        signers: [deployer.key],
        fundNewAccounts: 2,
      })
    ).rejects.toThrow(RATE_LIMIT_ASSERT.PER_MINT_CAP_EXCEEDED);
  });

  it('two recipients rate-limit independently in the same window', async () => {
    // bob already has 100 USDC; top him up to his own full cap — unaffected by
    // alice having exhausted hers.
    const balance = await mintUsdcPermissionless({
      token: deployResult.token,
      feePayer: deployer,
      recipient: bob,
      wholeUsdc: DAILY_MINT_CAP_USDC - 100n,
      signers: [deployer.key],
    });
    expect(balance).toBe((DAILY_MINT_CAP_USDC * ONE_USDC).toString());
    expect(readReceipt(bob).minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('a mint after the window boundary succeeds and re-anchors the window', async () => {
    const boundary = START_SLOT + Number(MINT_WINDOW_SLOTS.toBigint());
    Local.setGlobalSlot(boundary);

    const balance = await mintUsdcPermissionless({
      token: deployResult.token,
      feePayer: deployer,
      recipient: alice,
      wholeUsdc: DAILY_MINT_CAP_USDC,
      signers: [deployer.key],
    });
    expect(balance).toBe((2000n * ONE_USDC).toString());

    const receipt = readReceipt(alice);
    expect(receipt.windowStart).toBe(BigInt(boundary));
    expect(receipt.minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('the LEDGER rejects a second mint proved against a stale receipt balance (on-chain enforcement)', async () => {
    // Build BOTH txs against carol's pre-mint (all-zero) receipt balance, then
    // apply them in order — the public-devnet smoke scenario. Distinct fee
    // payers isolate the failure to the receipt balance precondition.
    const tx1 = await buildMintTx({
      token: deployResult.token,
      feePayer: deployer,
      recipient: carol,
      wholeUsdc: DAILY_MINT_CAP_USDC,
      signers: [deployer.key],
      fundNewAccounts: 2,
    });
    const staleTx = await buildMintTx({
      token: deployResult.token,
      feePayer: feePayer2,
      recipient: carol,
      wholeUsdc: 100n,
      signers: [feePayer2.key],
    });

    await tx1.send();
    expect(await balanceOf(carol)).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);

    // The stale tx carries a receipt balance precondition of 0, which no longer
    // holds on-chain — the ledger must reject it at apply time.
    await expect(staleTx.send()).rejects.toThrow(/precondition|balance/i);
    expect(await balanceOf(carol)).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
    expect(readReceipt(carol).minted).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });

  it('receipt balance cannot be forged without an admin-contract proof', async () => {
    const adminTokenId = deployResult.admin.deriveTokenId();
    const before = readReceipt(alice);

    // Alice tries to reset her own receipt with a signature-only AU under the
    // admin's token id — no admin-contract (token owner) proof in the tx. The
    // token rules + the admin account's `access: proof` permission must reject
    // this, whether at construction or application.
    await expect(
      (async () => {
        const tx = await Mina.transaction({ sender: alice }, async () => {
          const au = AccountUpdate.createSigned(alice, adminTokenId);
          au.balanceChange = { magnitude: UInt64.from(1n), sgn: Field(1) } as never;
        });
        await tx.sign([alice.key]).send();
      })()
    ).rejects.toThrow();

    const after = readReceipt(alice);
    expect(after).toEqual(before);
  });

  it('admin authority key is pause/upgrade only — never required to mint', () => {
    // Every successful mint above signed ONLY with a fee-payer key; the admin
    // authority key was never a signer. Sanity-assert the deployed admin
    // authority matches the pause/upgrade key we passed, and nothing else.
    expect(deployResult.result.adminAuthority).toBe(adminAuthority.toBase58());
  });
});
