/**
 * Unit tests for the faucet-treasury USDC orchestration (`usdc-faucet.ts`):
 * accumulate via rate-limited SELF-MINT, drip via uncapped TRANSFER.
 *
 * All tests run with proofsEnabled: false on a Mina.LocalBlockchain (the
 * repo's convention — see usdc-rate-limited-admin.test.ts): o1js still
 * executes every circuit assertion at tx construction and the local ledger
 * still enforces preconditions/permissions at apply time. No NEW circuits are
 * introduced by the faucet flow — it only drives the existing
 * `RateLimitedUsdcAdmin` + `UsdcChannelToken` methods — so compile coverage
 * stays with circuit-compile.test.ts, unchanged.
 *
 * Scenario coverage (the faucet's four on-chain modes):
 *   1. lazy top-up: below the low-water mark the treasury self-mints its full
 *      remaining window allowance, then transfers the drip (fresh recipient's
 *      token account funded by the treasury);
 *   2. no top-up while above the low-water mark (transfer only);
 *   3. window exhausted but balance available → drip still works (transfers
 *      are uncapped by the admin contract);
 *   4. treasury empty AND window exhausted → UsdcTreasuryEmptyError;
 *   5. window reset after MINT_WINDOW_SLOTS → the treasury replenishes again.
 *
 * Test Level: Unit (o1js LocalBlockchain, proofsEnabled: false)
 */

import { Mina, PrivateKey, PublicKey } from 'o1js';

import { ONE_USDC } from './usdc-token';
import { DAILY_MINT_CAP_USDC, MINT_WINDOW_SLOTS } from './usdc-rate-limited-admin';
import { deployRateLimitedUsdcToken } from './usdc-deploy';
import {
  buildUsdcTransferTx,
  dripUsdcFromTreasury,
  getUsdcBalance,
  readMintReceiptState,
  remainingMintAllowance,
  USDC_TREASURY_EMPTY,
} from './usdc-faucet';

/** Base slot the tests anchor the first mint window at (≫ 0 + window). */
const START_SLOT = 1000;
/** Whole USDC per drip / low-water mark, mirroring the faucet defaults. */
const DRIP = 50n;
const LOW_WATER = 500n;

const NANO = 1_000_000_000n;
const FEE = 100_000_000n; // MINT_FEE_NANOMINA default (0.1 MINA)

describe('usdc-faucet (treasury self-mint top-up + uncapped transfer drip)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let treasury: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let deployResult: Awaited<ReturnType<typeof deployRateLimitedUsdcToken>>;
  let adminContract: PublicKey;

  /** Fresh drip recipients: random keys with NO base account (pure token accts). */
  const alice = PrivateKey.random().toPublicKey();
  const bob = PrivateKey.random().toPublicKey();
  const carol = PrivateKey.random().toPublicKey();
  const dave = PrivateKey.random().toPublicKey();

  const treasuryUsdc = (): bigint => getUsdcBalance(deployResult.token, treasury);
  const treasuryMina = (): bigint => Mina.getBalance(treasury).toBigInt();

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, treasury, adminAuthority] = Local.testAccounts;

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
    adminContract = adminContractKey.toPublicKey();
    Local.setGlobalSlot(START_SLOT);
  });

  it('remainingMintAllowance mirrors the circuit window arithmetic', () => {
    const cap = DAILY_MINT_CAP_USDC * ONE_USDC;
    const fresh = { exists: false, windowStart: 0n, mintedInWindow: 0n };
    const partial = { exists: true, windowStart: 1000n, mintedInWindow: 400n * ONE_USDC };
    const exhausted = { exists: true, windowStart: 1000n, mintedInWindow: cap };

    // Fresh address: full cap regardless of slot knowledge.
    expect(remainingMintAllowance(fresh, 1000n)).toBe(cap);
    expect(remainingMintAllowance(fresh)).toBe(cap);
    // Mid-window: cap minus what was minted.
    expect(remainingMintAllowance(partial, 1200n)).toBe(600n * ONE_USDC);
    expect(remainingMintAllowance(exhausted, 1200n)).toBe(0n);
    // Window expired: full cap again (the circuit re-anchors).
    const reset = 1000n + MINT_WINDOW_SLOTS.toBigint();
    expect(remainingMintAllowance(exhausted, reset)).toBe(cap);
    // Unknown slot: CONSERVATIVE — never assumes the reset happened.
    expect(remainingMintAllowance(exhausted)).toBe(0n);
    expect(remainingMintAllowance(partial)).toBe(600n * ONE_USDC);
  });

  it('lazy top-up: the first drip self-mints the full allowance, then transfers (fresh recipient funded)', async () => {
    const minaBefore = treasuryMina();

    const result = await dripUsdcFromTreasury({
      token: deployResult.token,
      adminContract,
      treasuryKey: treasury.key,
      recipient: alice,
      dripUsdc: DRIP,
      lowWaterUsdc: LOW_WATER,
      currentSlot: BigInt(START_SLOT),
    });

    expect(result.mintedUsdc).toBe(DAILY_MINT_CAP_USDC);
    expect(result.mintSkipped).toBeUndefined();
    expect(result.transferredUsdc).toBe(DRIP);
    expect(result.fundedRecipientAccount).toBe(true);
    expect(result.treasuryBalanceBefore).toBe(0n);
    expect(result.treasuryBalanceAfter).toBe((DAILY_MINT_CAP_USDC - DRIP) * ONE_USDC);

    // Recipient got the drip in a freshly created token account.
    expect(getUsdcBalance(deployResult.token, alice)).toBe(DRIP * ONE_USDC);
    expect(Mina.hasAccount(alice, deployResult.token.deriveTokenId())).toBe(true);
    expect(treasuryUsdc()).toBe((DAILY_MINT_CAP_USDC - DRIP) * ONE_USDC);

    // The mint receipt records the full allowance in the current window.
    const receipt = readMintReceiptState(treasury, adminContract);
    expect(receipt.exists).toBe(true);
    expect(receipt.windowStart).toBe(BigInt(START_SLOT));
    expect(receipt.mintedInWindow).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);

    // Treasury paid: 2 new accounts on the mint leg (token + receipt), 1 on the
    // transfer leg (recipient token account), plus 0.1 MINA fee per leg.
    expect(minaBefore - treasuryMina()).toBe(3n * NANO + 2n * FEE);
  });

  it('no top-up while the treasury is above the low-water mark', async () => {
    const result = await dripUsdcFromTreasury({
      token: deployResult.token,
      adminContract,
      treasuryKey: treasury.key,
      recipient: bob,
      dripUsdc: DRIP,
      lowWaterUsdc: LOW_WATER,
      currentSlot: BigInt(START_SLOT),
    });

    expect(result.mintedUsdc).toBe(0n);
    expect(result.mintHash).toBeUndefined();
    expect(result.mintSkipped).toBeUndefined();
    expect(getUsdcBalance(deployResult.token, bob)).toBe(DRIP * ONE_USDC);
    expect(treasuryUsdc()).toBe((DAILY_MINT_CAP_USDC - 2n * DRIP) * ONE_USDC);
  });

  it('drips while the mint window is exhausted (transfers are uncapped by the admin contract)', async () => {
    // Force a top-up attempt with an absurd low-water mark: the window is
    // already exhausted (full cap minted at START_SLOT), so the mint leg is
    // skipped gracefully and the transfer still serves the drip.
    const result = await dripUsdcFromTreasury({
      token: deployResult.token,
      adminContract,
      treasuryKey: treasury.key,
      recipient: carol,
      dripUsdc: DRIP,
      lowWaterUsdc: 10_000n,
      currentSlot: BigInt(START_SLOT),
    });

    expect(result.mintedUsdc).toBe(0n);
    expect(result.mintSkipped).toMatch(/window exhausted/);
    expect(result.transferredUsdc).toBe(DRIP);
    expect(getUsdcBalance(deployResult.token, carol)).toBe(DRIP * ONE_USDC);
    expect(treasuryUsdc()).toBe((DAILY_MINT_CAP_USDC - 3n * DRIP) * ONE_USDC);
  });

  it('refuses the drip when the treasury is empty AND the window is exhausted', async () => {
    // Drain the treasury to zero with a plain transfer (to a sink account).
    const sink = PrivateKey.random().toPublicKey();
    const remaining = treasuryUsdc() / ONE_USDC;
    const drainTx = await buildUsdcTransferTx({
      token: deployResult.token,
      feePayer: treasury,
      from: treasury,
      to: sink,
      wholeUsdc: remaining,
      signers: [treasury.key],
      fundNewAccounts: 1,
    });
    await drainTx.send();
    expect(treasuryUsdc()).toBe(0n);

    // Same window, allowance exhausted, balance zero → the drip must refuse
    // with the typed treasury-empty error (route maps it to a 503).
    await expect(
      dripUsdcFromTreasury({
        token: deployResult.token,
        adminContract,
        treasuryKey: treasury.key,
        recipient: dave,
        dripUsdc: DRIP,
        lowWaterUsdc: LOW_WATER,
        currentSlot: BigInt(START_SLOT),
      })
    ).rejects.toMatchObject({ code: USDC_TREASURY_EMPTY });
    expect(getUsdcBalance(deployResult.token, dave)).toBe(0n);
  });

  it('replenishes after the window resets: the next drip self-mints the full allowance again', async () => {
    const boundary = START_SLOT + Number(MINT_WINDOW_SLOTS.toBigint());
    Local.setGlobalSlot(boundary);

    const result = await dripUsdcFromTreasury({
      token: deployResult.token,
      adminContract,
      treasuryKey: treasury.key,
      recipient: dave,
      dripUsdc: DRIP,
      lowWaterUsdc: LOW_WATER,
      currentSlot: BigInt(boundary),
    });

    // Existing token + receipt accounts → no new-account funding on the mint.
    expect(result.mintedUsdc).toBe(DAILY_MINT_CAP_USDC);
    expect(result.transferredUsdc).toBe(DRIP);
    expect(getUsdcBalance(deployResult.token, dave)).toBe(DRIP * ONE_USDC);
    expect(treasuryUsdc()).toBe((DAILY_MINT_CAP_USDC - DRIP) * ONE_USDC);

    const receipt = readMintReceiptState(treasury, adminContract);
    expect(receipt.windowStart).toBe(BigInt(boundary));
    expect(receipt.mintedInWindow).toBe(DAILY_MINT_CAP_USDC * ONE_USDC);
  });
});
