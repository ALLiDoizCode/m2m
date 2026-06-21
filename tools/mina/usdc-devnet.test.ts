/**
 * Smoke test for the Mina USDC devnet tooling (ticket #193).
 *
 * Verifies the deploy + funding LOGIC used by tools/mina/deploy-usdc-token.ts and
 * tools/mina/fund-usdc.ts against an o1js Mina.LocalBlockchain (proofsEnabled:
 * false) — no live devnet, no funded key. Mirrors packages/mina-zkapp's
 * usdc-token.test.ts deploy sequence, but exercises THIS package's exported
 * functions so the devnet scripts stay honest.
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #193.
 */

import { Mina, PrivateKey } from 'o1js';

import { ONE_USDC, USDC_DECIMALS } from '../../packages/mina-zkapp/src/usdc-token';
import { deployUsdcToken } from './deploy-usdc-token';
import { mintUsdc } from './fund-usdc';

describe('Mina USDC devnet tooling (#193)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let recipient: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let tokenKey: PrivateKey;
  let adminContractKey: PrivateKey;
  let deployResult: Awaited<ReturnType<typeof deployUsdcToken>>;

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, recipient, adminAuthority] = Local.testAccounts;

    tokenKey = PrivateKey.random();
    adminContractKey = PrivateKey.random();

    deployResult = await deployUsdcToken({
      feePayer: deployer,
      adminAuthority,
      adminContractKey,
      tokenKey,
      signers: [deployer.key, adminContractKey, tokenKey],
      network: 'LocalBlockchain',
    });
  });

  it('deploy harness deploys USDC at 6 decimals', () => {
    expect(deployResult.token.decimals.get().toString()).toBe(String(USDC_DECIMALS));
    expect(deployResult.result.decimals).toBe(6);
  });

  it('reports the token address and derived tokenId to pin in endpoints.json', () => {
    expect(deployResult.result.tokenAddress).toBe(tokenKey.toPublicKey().toBase58());
    expect(deployResult.result.tokenId).toBe(deployResult.token.deriveTokenId().toString());
    expect(deployResult.result.tokenId).toMatch(/^\d+$/);
    expect(deployResult.result.adminContractAddress).toBe(
      adminContractKey.toPublicKey().toBase58()
    );
    expect(deployResult.result.adminAuthority).toBe(adminAuthority.toBase58());
  });

  it('funding harness admin-mints USDC to a recipient', async () => {
    const wholeUsdc = 1000n;
    const balance = await mintUsdc({
      token: deployResult.token,
      feePayer: deployer,
      recipient,
      wholeUsdc,
      signers: [deployer.key, adminAuthority.key],
      fundRecipient: true,
    });
    expect(balance).toBe((wholeUsdc * ONE_USDC).toString());
  });
});
