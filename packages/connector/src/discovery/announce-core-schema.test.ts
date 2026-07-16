/**
 * Schema-conformance tests: the connector's SIGNED kind:10032 self-announce
 * must parse under `@toon-protocol/core`'s `parseIlpPeerInfo` (#289).
 *
 * The devnet apex/store announced `settlementAddresses` keyed by bare chain
 * namespace (`"evm"`), which core's parser REJECTS (`validateChainId` requires
 * 2–3 colon segments, and every key must be a member of `supportedChains`) —
 * so every published-core SDK client failed discovery with
 * "Failed to parse peer info". These tests pin the emitted event to the
 * published schema so that regression cannot ship again.
 *
 * Why REPLICATE the validator instead of importing `parseIlpPeerInfo` from
 * `@toon-protocol/core`? The connector intentionally has NO dependency on core
 * (see `ilp-peer-info-event.ts`): core declares a peerDependency back onto
 * `@toon-protocol/connector` (circular), and pins `@noble/*@^2` against this
 * repo's `@noble@^1` tree. Adding it even as a devDependency would reintroduce
 * exactly that conflict. The replica below is transcribed from the PUBLISHED
 * `@toon-protocol/core` dist (`parseIlpPeerInfo`, `validateChainId`,
 * `isValidIlpAddressStructure`), which is byte-identical between the two
 * published majors, 1.6.0 and 2.0.0, for every check replicated here — so a
 * pass means the event parses under BOTH published core majors.
 *
 * @module discovery/announce-core-schema.test
 */

import { generateSecretKey } from 'nostr-tools';
import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import { buildSelfAnnouncementInfo } from './self-announce-builder';
import { buildIlpPeerInfoEvent, ILP_PEER_INFO_KIND } from './ilp-peer-info-event';

/* ------------------------------------------------------------------------ *
 * Replica of @toon-protocol/core's parseIlpPeerInfo validation
 * (published dist, identical in 1.6.0 and 2.0.0). Throws on any violation.
 * ------------------------------------------------------------------------ */

const ILP_SEGMENT_PATTERN = /^[a-z0-9-]+$/;
const MAX_ILP_ADDRESS_LENGTH = 1023;

/** core: `isValidIlpAddressStructure` (chain/ilp-address.ts). */
function isValidIlpAddressStructure(address: string): boolean {
  if (!address) return false;
  if (address.length > MAX_ILP_ADDRESS_LENGTH) return false;
  const segments = address.split('.');
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (!ILP_SEGMENT_PATTERN.test(segment)) return false;
  }
  return true;
}

/** core: `validateChainId` (chain/chain-id.ts) — 2–3 non-empty colon segments. */
function validateChainId(chainId: string): boolean {
  if (!chainId) return false;
  const segments = chainId.split(':');
  if (segments.length < 2 || segments.length > 3) return false;
  return segments.every((s) => s.length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * core: `parseIlpPeerInfo` (events/parsers.ts) — the subset of checks that
 * apply to fields the connector emits, transcribed check-for-check from the
 * published dist. Throws (like core's `InvalidEventError`) on any violation.
 */
function parseIlpPeerInfoReplica(event: { kind: number; content: string }): void {
  if (event.kind !== ILP_PEER_INFO_KIND) {
    throw new Error(`Expected event kind ${ILP_PEER_INFO_KIND}, got ${event.kind}`);
  }
  const parsed: unknown = JSON.parse(event.content);
  if (!isObject(parsed)) {
    throw new Error('Event content must be a JSON object');
  }

  const { ilpAddress, btpEndpoint, httpEndpoint, assetCode, assetScale } = parsed;
  if (typeof ilpAddress !== 'string' || ilpAddress.length === 0) {
    throw new Error('Missing or invalid required field: ilpAddress');
  }
  if (btpEndpoint !== undefined && typeof btpEndpoint !== 'string') {
    throw new Error('Invalid field: btpEndpoint must be a string');
  }
  if (httpEndpoint !== undefined && typeof httpEndpoint !== 'string') {
    throw new Error('Invalid field: httpEndpoint must be a string');
  }
  if (typeof assetCode !== 'string' || assetCode.length === 0) {
    throw new Error('Missing or invalid required field: assetCode');
  }
  if (typeof assetScale !== 'number' || !Number.isInteger(assetScale)) {
    throw new Error('Missing or invalid required field: assetScale');
  }

  const { supportedChains, settlementAddresses } = parsed;
  if (supportedChains !== undefined) {
    if (!Array.isArray(supportedChains)) {
      throw new Error('supportedChains must be an array');
    }
    if (supportedChains.length === 0) {
      throw new Error('supportedChains must be a non-empty array when provided');
    }
    for (const chainId of supportedChains) {
      if (typeof chainId !== 'string' || !validateChainId(chainId)) {
        throw new Error(`Invalid chain identifier: ${String(chainId)}`);
      }
    }
  }
  if (settlementAddresses !== undefined) {
    if (!isObject(settlementAddresses)) {
      throw new Error('settlementAddresses must be an object');
    }
    for (const [key, value] of Object.entries(settlementAddresses)) {
      if (!validateChainId(key)) {
        throw new Error(`Invalid chain identifier in settlementAddresses: ${key}`);
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('settlementAddresses values must be non-empty strings');
      }
    }
    // Cross-field: settlementAddresses keys must be members of supportedChains.
    if (Array.isArray(supportedChains)) {
      const chainSet = new Set(supportedChains as string[]);
      for (const key of Object.keys(settlementAddresses)) {
        if (!chainSet.has(key)) {
          throw new Error(`settlementAddresses key '${key}' is not in supportedChains`);
        }
      }
    }
  }

  // preferredTokens / tokenNetworks: core (identical in 1.6.0, 2.0.1, and
  // 3.0.0) only requires each to be an object when present — no key-format or
  // supportedChains-membership check. The connector still keys them by the
  // `supportedChains` chain ids for consistency (asserted separately below).
  const { preferredTokens, tokenNetworks } = parsed;
  if (preferredTokens !== undefined && !isObject(preferredTokens)) {
    throw new Error('preferredTokens must be an object');
  }
  if (tokenNetworks !== undefined && !isObject(tokenNetworks)) {
    throw new Error('tokenNetworks must be an object');
  }

  const { ilpAddresses } = parsed;
  if (ilpAddresses !== undefined) {
    if (!Array.isArray(ilpAddresses)) {
      throw new Error('ilpAddresses must be an array');
    }
    for (const addr of ilpAddresses) {
      if (typeof addr !== 'string' || addr.length === 0) {
        throw new Error('ilpAddresses elements must be non-empty strings');
      }
      if (!isValidIlpAddressStructure(addr)) {
        throw new Error(`Invalid ILP address in ilpAddresses: "${addr}"`);
      }
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Fixtures: the canonical devnet deploy shapes (mirroring
 * relay/deploy/connector.yaml and store/deploy/connector.yaml, multi-chain
 * like the live boxes' hand-tuned configs).
 * ------------------------------------------------------------------------ */

const APEX_EVM = '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab';
const STORE_EVM = '0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e';

type ChainProvider = NonNullable<ConnectorConfig['chainProviders']>[number];

function provider(chainType: string, chainId: string): ChainProvider {
  return { chainType, chainId, rpcUrl: 'http://localhost:1', keyId: 'k' } as ChainProvider;
}

const SOL_PROGRAM = 'ChanProg1111111111111111111111111111111111';
const SOL_MINT = 'UsdcMint1111111111111111111111111111111111';
const MINA_ZKAPP = 'B62qChannelZkApp111111111111111111111111111111111111111';
const EVM_TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** Relay-connector apex, three chains — the live `toon` box shape (#289). */
function relayApexConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      { ...provider('evm', 'evm:31337'), tokenAddress: EVM_TOKEN } as ChainProvider,
      {
        ...provider('solana', 'solana:devnet'),
        programId: SOL_PROGRAM,
        tokenMint: SOL_MINT,
      } as ChainProvider,
      { ...provider('mina', 'mina:devnet'), zkAppAddress: MINA_ZKAPP } as ChainProvider,
    ],
    routes: [
      {
        prefix: 'g.proxy.relay',
        nextHop: 'connector',
        upstream: 'http://relay:3100',
        price: '1000',
        chains: ['evm', 'solana', 'mina'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: APEX_EVM, solana: 'A3FGsol', mina: 'B62qkmina' },
      },
      { prefix: 'g.proxy.store', nextHop: 'store-box', ilpAddress: 'g.proxy.store' },
    ],
  };
}

/** Store-connector apex — the live `toon-devnet-store` box shape. */
function storeApexConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [provider('evm', 'evm:31337')],
    routes: [
      {
        prefix: 'g.proxy.store',
        nextHop: 'connector',
        upstream: 'http://store:3300',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.store',
        settlementAddresses: { evm: STORE_EVM },
      },
      {
        prefix: 'g.proxy.relay.store',
        nextHop: 'connector',
        upstream: 'http://store:3300',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay.store',
        settlementAddresses: { evm: STORE_EVM },
      },
    ],
  };
}

const selfAnnounce: SelfAnnounceConfig = {
  enabled: true,
  announceTo: 'g.proxy.relay',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
  httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
  relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
};

function buildSignedAnnounce(config: ConnectorConfig): {
  info: ReturnType<typeof buildSelfAnnouncementInfo>;
  event: ReturnType<typeof buildIlpPeerInfoEvent>;
} {
  const info = buildSelfAnnouncementInfo(config, selfAnnounce);
  return { info, event: buildIlpPeerInfoEvent(info, generateSecretKey(), { ttlSeconds: 600 }) };
}

/* ------------------------------------------------------------------------ */

describe('kind:10032 self-announce conforms to core parseIlpPeerInfo (#289)', () => {
  it('relay apex (multi-chain): the signed event parses under the published core schema', () => {
    const { info, event } = buildSignedAnnounce(relayApexConfig());
    expect(() => parseIlpPeerInfoReplica(event)).not.toThrow();
    // The exact devnet regression: qualified keys, matching supportedChains.
    expect(info.supportedChains).toEqual(['evm:31337', 'solana:devnet', 'mina:devnet']);
    expect(info.settlementAddresses).toEqual({
      'evm:31337': APEX_EVM,
      'solana:devnet': 'A3FGsol',
      'mina:devnet': 'B62qkmina',
    });
  });

  it('store apex: the signed event parses under the published core schema', () => {
    const { event } = buildSignedAnnounce(storeApexConfig());
    expect(() => parseIlpPeerInfoReplica(event)).not.toThrow();
  });

  it('every settlementAddresses key is a member of supportedChains (cross-field check)', () => {
    const { info } = buildSignedAnnounce(relayApexConfig());
    const chains = new Set(info.supportedChains);
    for (const key of Object.keys(info.settlementAddresses ?? {})) {
      expect(chains.has(key)).toBe(true);
    }
  });

  it('carries per-chain tokenNetworks/preferredTokens and still parses (toon-client#378)', () => {
    const { info, event } = buildSignedAnnounce(relayApexConfig());
    expect(() => parseIlpPeerInfoReplica(event)).not.toThrow();
    // Solana: payment-channel PROGRAM id + SPL mint; Mina: channel zkApp. The
    // EVM TokenNetwork is runtime-resolved (registry lookup), not in this
    // config-only build.
    expect(info.tokenNetworks).toEqual({
      'solana:devnet': SOL_PROGRAM,
      'mina:devnet': MINA_ZKAPP,
    });
    expect(info.preferredTokens).toEqual({
      'evm:31337': EVM_TOKEN,
      'solana:devnet': SOL_MINT,
    });
  });

  it('every tokenNetworks/preferredTokens key is a member of supportedChains (consistency)', () => {
    const { info } = buildSignedAnnounce(relayApexConfig());
    const chains = new Set(info.supportedChains);
    for (const key of [
      ...Object.keys(info.tokenNetworks ?? {}),
      ...Object.keys(info.preferredTokens ?? {}),
    ]) {
      expect(chains.has(key)).toBe(true);
    }
  });

  it('REGRESSION: the pre-fix bare-key shape is rejected by the core parser', () => {
    // What the devnet boxes announced before this fix — proves the replica
    // actually catches the bug this suite exists to prevent.
    const bareKeyed = buildIlpPeerInfoEvent(
      {
        ilpAddress: 'g.proxy.relay',
        btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
        assetCode: 'USDC',
        assetScale: 6,
        supportedChains: ['evm:31337', 'solana:devnet', 'mina:devnet'],
        settlementAddresses: { evm: APEX_EVM, solana: 'A3FGsol', mina: 'B62qkmina' },
      },
      generateSecretKey()
    );
    expect(() => parseIlpPeerInfoReplica(bareKeyed)).toThrow(
      /Invalid chain identifier in settlementAddresses/
    );
  });

  it('REGRESSION: a qualified key missing from supportedChains is rejected', () => {
    const mismatched = buildIlpPeerInfoEvent(
      {
        ilpAddress: 'g.proxy.relay',
        btpEndpoint: '',
        assetCode: 'USDC',
        assetScale: 6,
        supportedChains: ['evm:31337'],
        settlementAddresses: { 'solana:devnet': 'A3FGsol' },
      },
      generateSecretKey()
    );
    expect(() => parseIlpPeerInfoReplica(mismatched)).toThrow(/is not in supportedChains/);
  });

  it('out-of-band route hints ride along without breaking core parsing', () => {
    const { info, event } = buildSignedAnnounce(relayApexConfig());
    expect(info.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
    // Core destructures only known fields; extras are ignored, never rejected.
    expect(() => parseIlpPeerInfoReplica(event)).not.toThrow();
  });
});
