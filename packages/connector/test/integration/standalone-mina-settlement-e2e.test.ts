/**
 * Standalone Mina Settlement E2E Integration Test (issue #86)
 *
 * Proves that a Mina-only ConnectorNode (no EVM chainProvider) boots the full
 * settlement stack and that its registered Mina provider can drive a real
 * `claimFromChannel` (unidirectional, and a dual-party case threading
 * `balanceB`/`signatureB`/`salt`) against a local lightnet.
 *
 *   - A `chainProviders` config with ONLY a `chainType: 'mina'` entry is enough
 *     to boot the settlement stack (chainRegistry + SettlementExecutor +
 *     ClaimReceiver + SettlementMonitor).
 *   - `this._paymentChannelSDK` and ChannelManager stay null for a non-EVM-only
 *     node — settlement is claim-driven redemption of channels opened out-of-band.
 *
 * NO MOCKS (project rule): Test A boots a real ConnectorNode; Test B drives the
 * real MinaPaymentChannelProvider against a live lightnet (reusing mina-helpers).
 *
 * Prerequisites for the on-chain portion (Test B):
 *   make mina-up                     # local Mina lightnet + accounts manager
 *   MINA_INTEGRATION=true npx jest test/integration/standalone-mina-settlement-e2e.test.ts
 *
 * Test A (boot) needs no live chain — Mina signer resolution and SDK
 * construction are fully offline (o1js is lazy-loaded only at sign time).
 *
 * @packageDocumentation
 */

import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import {
  waitForMinaReady,
  acquireFundedAccount,
  releaseFundedAccount,
  MINA_GRAPHQL_URL,
} from './mina-helpers';
import type { MinaFundedAccount } from './mina-helpers';

// ────────────────────────────────────────────────────────────────────────────
// Constants + infra gate
// ────────────────────────────────────────────────────────────────────────────

/** Mina network name used for chain-id namespacing (`mina:<network>`). */
const MINA_NETWORK = 'devnet';

/** zkApp address for the (out-of-band) payment channel contract. */
const MINA_ZKAPP_ADDRESS =
  process.env.MINA_TEST_ZKAPP_ADDRESS ?? 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';

/** Token id for the channel token (native MINA fungible-token id). */
const MINA_TOKEN_ID =
  process.env.MINA_TEST_TOKEN_ID ?? 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';

/**
 * Throwaway valid base58 Pallas (Mina) private key for the OFFLINE boot test.
 * Generated via `o1js` `PrivateKey.random().toBase58()`; not funded and only
 * used to satisfy the keyId contract — booting needs no on-chain signing.
 */
const MINA_BOOT_KEY = 'EKEuR1wnfFejQpKvzt1QNWbaRV8XzPaPVwjSP89aL8hTe9Zi4s4z';

/**
 * On-chain claim path is gated behind MINA_INTEGRATION=true (mirrors
 * `mina-lightnet.test.ts`). When false, Test B skips cleanly.
 */
const RUN_MINA = process.env.MINA_INTEGRATION === 'true';
const describeMina = RUN_MINA ? describe : describe.skip;

jest.setTimeout(180_000);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Build a Mina-only ConnectorNode config (no EVM chainProvider). */
function buildMinaOnlyConfig(opts: {
  nodeId: string;
  btpPort: number;
  healthPort: number;
  keyId: string;
}): ConnectorConfig {
  return {
    nodeId: opts.nodeId,
    btpServerPort: opts.btpPort,
    healthCheckPort: opts.healthPort,
    logLevel: 'warn',
    environment: 'development',
    deploymentMode: 'standalone',
    // No peers required: the node accepts inbound BTP and redeems claims.
    peers: [],
    routes: [],
    chainProviders: [
      {
        chainType: 'mina',
        chainId: `mina:${MINA_NETWORK}`,
        graphqlUrl: process.env.MINA_GRAPHQL_URL ?? MINA_GRAPHQL_URL,
        zkAppAddress: MINA_ZKAPP_ADDRESS,
        keyId: opts.keyId,
        tokenId: MINA_TOKEN_ID,
        network: MINA_NETWORK,
      },
    ],
  } as ConnectorConfig;
}

// ────────────────────────────────────────────────────────────────────────────
// Test A — Boot a Mina-only node (offline, no live chain calls)
// ────────────────────────────────────────────────────────────────────────────

describe('Standalone Mina Settlement E2E — boot (issue #86)', () => {
  let node: ConnectorNode | undefined;
  const base = 49000 + Math.floor(Math.random() * 4000);

  afterEach(async () => {
    await node?.stop().catch(() => undefined);
    node = undefined;
  });

  it('boots the settlement stack for a Mina-only config (registry has mina:*, EVM SDK null)', async () => {
    const config = buildMinaOnlyConfig({
      nodeId: 'mina-only',
      btpPort: base,
      healthPort: base + 1,
      keyId: MINA_BOOT_KEY,
    });

    node = new ConnectorNode(config, createLogger('mina-only', 'warn'));
    await node.start();

    // The settlement stack booted (not the `payment_channels_disabled` path):
    // chainRegistry getter is non-null and exposes a mina:* provider.
    const registry = node.chainRegistry;
    expect(registry).not.toBeNull();

    const providers = registry!.getAllProviders();
    expect(providers.length).toBeGreaterThan(0);

    const minaProvider = registry!.getProvider('mina', `mina:${MINA_NETWORK}`);
    expect(minaProvider).toBeDefined();
    expect(minaProvider!.chainType).toBe('mina');
    expect(minaProvider!.chainId).toBe(`mina:${MINA_NETWORK}`);

    // No EVM provider registered, and the EVM payment-channel SDK is null
    // (non-EVM-only nodes are claim-driven; ChannelManager also stays null).
    expect(registry!.getAllProviders().every((p) => p.chainType !== 'evm')).toBe(true);
    expect(node.paymentChannelSDK).toBeNull();
    expect(node.channelManager).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test B — On-chain claim path against the live lightnet (gated)
// ────────────────────────────────────────────────────────────────────────────

describeMina('Standalone Mina Settlement E2E — on-chain (requires make mina-up)', () => {
  let node: ConnectorNode | undefined;
  let funded: MinaFundedAccount | undefined;
  const base = 53000 + Math.floor(Math.random() * 4000);

  beforeAll(async () => {
    // Wait for the lightnet to sync, then acquire a real funded account whose
    // private key becomes the node's settlement keyId.
    await waitForMinaReady();
    funded = await acquireFundedAccount();

    node = new ConnectorNode(
      buildMinaOnlyConfig({
        nodeId: 'mina-onchain',
        btpPort: base,
        healthPort: base + 1,
        keyId: funded.privateKey,
      }),
      createLogger('mina-onchain', 'warn')
    );
    await node.start();
  });

  afterAll(async () => {
    await node?.stop().catch(() => undefined);
    node = undefined;
    if (funded) {
      await releaseFundedAccount(funded.publicKey).catch(() => undefined);
    }
  });

  it('exposes the registered Mina provider wired to the live lightnet', () => {
    const provider = node!.chainRegistry!.getProvider('mina', `mina:${MINA_NETWORK}`);
    expect(provider).toBeDefined();
    expect(provider!.chainType).toBe('mina');
  });

  it('drives a real unidirectional + dual-party claimFromChannel (full provisioning via env)', async () => {
    const provider = node!.chainRegistry!.getProvider('mina', `mina:${MINA_NETWORK}`)!;

    // A real on-chain `claimFromChannel` requires a DEPLOYED zkApp channel
    // contract (compiled o1js, several minutes), an OPENED + DEPOSITED channel,
    // and a counterparty key — all provisioned OUT OF BAND. When the operator
    // supplies a live channel via env (MINA_TEST_CHANNEL_ID = the zkApp address
    // of an open channel), the test drives the booted node's registered provider
    // end-to-end against lightnet. Otherwise this step is skipped cleanly (the
    // lightnet ships no pre-deployed payment-channel zkApp).
    const channelId = process.env.MINA_TEST_CHANNEL_ID;
    if (!channelId) {
      // eslint-disable-next-line no-console
      console.warn(
        'MINA_TEST_CHANNEL_ID not set (no out-of-band zkApp channel provisioned) — ' +
          'skipping the on-chain claimFromChannel assertions.'
      );
      return;
    }

    const transferredAmount = process.env.MINA_TEST_TRANSFERRED_AMOUNT ?? '4000';
    const nonce = Number(process.env.MINA_TEST_NONCE ?? '1');

    // ── Unidirectional claim: only participant A's balance + signature.
    const sigA = await provider.signBalanceProof({
      channelId,
      nonce,
      transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
    });
    const uniResult = await provider.claimFromChannel(
      channelId,
      {
        channelId,
        nonce,
        transferredAmount,
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      },
      sigA
    );
    expect(typeof uniResult.txHash).toBe('string');
    expect(uniResult.txHash.length).toBeGreaterThan(0);

    // ── Dual-party claim: thread balanceB + salt + a distinct signatureB.
    // Provisioned via env when a true two-party (e.g. Mill swap) channel exists.
    const balanceB = process.env.MINA_TEST_BALANCE_B;
    const salt = process.env.MINA_TEST_SALT;
    const sigB = process.env.MINA_TEST_SIGNATURE_B;
    if (balanceB && salt && sigB) {
      const dualResult = await provider.claimFromChannel(
        channelId,
        {
          channelId,
          nonce: nonce + 1,
          transferredAmount,
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          balanceB,
          salt,
          signatureB: sigB,
        },
        sigA
      );
      expect(typeof dualResult.txHash).toBe('string');
      expect(dualResult.txHash.length).toBeGreaterThan(0);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        'MINA_TEST_BALANCE_B / MINA_TEST_SALT / MINA_TEST_SIGNATURE_B not all set — ' +
          'skipping the dual-party claim assertion.'
      );
    }
  });
});
