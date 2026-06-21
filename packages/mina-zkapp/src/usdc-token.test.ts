/**
 * USDC token (mina-fungible-token) — deploy + mint + transfer.
 *
 * Verifies the USDC token-owner zkApp deploys at 6 decimals, mints to an account
 * via the admin authority, and transfers between accounts. Runs on the o1js
 * LocalBlockchain with proofsEnabled: false for fast execution (constraints are
 * still enforced).
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #190.
 */

import { AccountUpdate, Bool, Mina, PrivateKey, UInt64 } from 'o1js';

import {
  FungibleToken,
  FungibleTokenAdmin,
  USDC_DECIMALS,
  USDC_DECIMALS_U8,
  ONE_USDC,
  usdcDeployProps,
} from './usdc-token';

describe('USDC token (mina-fungible-token)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey; // mint authority — must be a FUNDED account

  let adminContractKey: PrivateKey; // admin contract account
  let tokenKey: PrivateKey; // token contract account
  let admin: FungibleTokenAdmin;
  let token: FungibleToken;

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, alice, bob, adminAuthority] = Local.testAccounts;

    adminContractKey = PrivateKey.random();
    tokenKey = PrivateKey.random();
    admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
    token = new FungibleToken(tokenKey.toPublicKey());

    // Deploy admin + token and initialize at 6 decimals (one atomic tx).
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 3); // admin acct, token acct, circulation acct
      await admin.deploy({ adminPublicKey: adminAuthority }); // funded account = mint authority
      await token.deploy(usdcDeployProps);
      await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
    });
    await tx.prove();
    await tx.sign([deployer.key, adminContractKey, tokenKey]).send();
  });

  it('deploys USDC at 6 decimals', () => {
    expect(token.decimals.get().toString()).toBe(String(USDC_DECIMALS));
  });

  it('mints USDC to an account via the admin authority', async () => {
    const amount = UInt64.from(1000n * ONE_USDC); // 1,000 USDC
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1); // alice's token account
      await token.mint(alice, amount);
    });
    await tx.prove();
    await tx.sign([deployer.key, adminAuthority.key]).send(); // admin authority signs the mint

    const balance = await token.getBalanceOf(alice);
    expect(balance.toString()).toBe(amount.toString());
  });

  it('transfers USDC between accounts', async () => {
    const amount = UInt64.from(250n * ONE_USDC);
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice, 1); // bob's token account
      await token.transfer(alice, bob, amount);
    });
    await tx.prove();
    await tx.sign([alice.key]).send();

    expect((await token.getBalanceOf(bob)).toString()).toBe(amount.toString());
    expect((await token.getBalanceOf(alice)).toString()).toBe(
      UInt64.from(750n * ONE_USDC).toString()
    );
  });
});
