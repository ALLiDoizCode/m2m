/**
 * Tests for deriving the connector's own kind:10032 announcement from its
 * config (relay#37 / store#22).
 *
 * Uses the REAL canonical deploy route shapes (relay/deploy/connector.yaml and
 * store/deploy/connector.yaml) so the derivation is exercised against the
 * topologies it must support: a relay-connector apex (terminates `g.proxy.relay`,
 * forwards `g.proxy.store`/`g.proxy.relay.store`) and a store-connector apex
 * (terminates `g.proxy.store` + `g.proxy.relay.store`).
 *
 * @module discovery/self-announce-builder.test
 */

import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import {
  buildSelfAnnouncementInfo,
  deriveChainSettlementParams,
  normalizeSettlementAddressKeys,
  resolveRouteHints,
} from './self-announce-builder';

const APEX_EVM = '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab';
const STORE_EVM = '0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e';

/** Mirror of relay/deploy/connector.yaml (the relay-connector / g.proxy apex). */
function relayConnectorConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'https://evm-rpc.devnet.toonprotocol.dev',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never,
    ],
    routes: [
      {
        prefix: 'g.proxy.relay',
        nextHop: 'connector',
        upstream: 'http://relay:3100',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: APEX_EVM },
      },
      {
        prefix: 'g.proxy.relay.store',
        nextHop: 'store-box',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay.store',
        settlementAddresses: { evm: APEX_EVM },
      },
      {
        prefix: 'g.proxy.store',
        nextHop: 'store-box',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.store',
        settlementAddresses: { evm: APEX_EVM },
      },
    ],
  };
}

/** Mirror of store/deploy/connector.yaml (the store-connector apex). */
function storeConnectorConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'https://evm-rpc.devnet.toonprotocol.dev',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never,
    ],
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

const baseSelfAnnounce: SelfAnnounceConfig = {
  enabled: true,
  announceTo: 'g.proxy.relay',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

describe('buildSelfAnnouncementInfo — relay-connector apex', () => {
  it('advertises the terminated relay route as the primary ilpAddress', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    // Only g.proxy.relay is locally terminated (has an upstream).
    expect(info.ilpAddress).toBe('g.proxy.relay');
    // A single terminated route → no ilpAddresses array.
    expect(info.ilpAddresses).toBeUndefined();
  });

  it('derives supportedChains, settlement, asset, and endpoints from config', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    expect(info.supportedChains).toEqual(['evm:31337']);
    // Keys are re-keyed from the config's bare `evm` to the qualified chain id
    // so the event parses under core's kind:10032 schema (#289).
    expect(info.settlementAddresses).toEqual({ 'evm:31337': APEX_EVM });
    expect(info.assetCode).toBe('USDC');
    expect(info.assetScale).toBe(6);
    expect(info.btpEndpoint).toBe('wss://proxy.devnet.toonprotocol.dev:443');
  });

  it('derives route hints: publish=g.proxy.relay, store=g.proxy.store', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    expect(info.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });

  it('passes through advertised httpEndpoint and relayUrl when set', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), {
      ...baseSelfAnnounce,
      httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
    });
    expect(info.httpEndpoint).toBe('https://proxy.devnet.toonprotocol.dev/ilp');
    expect(info.relayUrl).toBe('wss://relay-ws.devnet.toonprotocol.dev');
  });
});

describe('buildSelfAnnouncementInfo — store-connector apex', () => {
  it('advertises both terminated store routes (multi-address)', () => {
    const info = buildSelfAnnouncementInfo(storeConnectorConfig(), baseSelfAnnounce);
    expect(info.ilpAddress).toBe('g.proxy.store');
    expect(info.ilpAddresses).toEqual(['g.proxy.store', 'g.proxy.relay.store']);
    expect(info.settlementAddresses).toEqual({ 'evm:31337': STORE_EVM });
  });

  it('derives route hints: publish swapped from store, store=direct g.proxy.store', () => {
    const info = buildSelfAnnouncementInfo(storeConnectorConfig(), baseSelfAnnounce);
    // No `.relay` route on the store box → publish is derived by swapping the
    // trailing `.store` of the direct store route for `.relay`.
    expect(info.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });
});

describe('resolveRouteHints', () => {
  const routes = relayConnectorConfig().routes;

  it('honors explicit overrides over derivation', () => {
    expect(
      resolveRouteHints(routes, { publish: 'g.custom.publish', store: 'g.custom.store' })
    ).toEqual({ publish: 'g.custom.publish', store: 'g.custom.store' });
  });

  it('fills only the missing side from an override', () => {
    expect(resolveRouteHints(routes, { store: 'g.override.store' })).toEqual({
      publish: 'g.proxy.relay',
      store: 'g.override.store',
    });
  });

  it('prefers the DIRECT .store route over the .relay.store hop path', () => {
    expect(resolveRouteHints(routes).store).toBe('g.proxy.store');
  });

  it('falls back to the first route when no .relay/.store labels exist', () => {
    const plain = [
      { prefix: 'g.connector.greet', nextHop: 'local', ilpAddress: 'g.connector.greet' },
    ] as ConnectorConfig['routes'];
    expect(resolveRouteHints(plain)).toEqual({
      publish: 'g.connector.greet',
      store: 'g.connector.greet',
    });
  });

  it('derives the store hint from a publish-only (.relay) route by swapping the label', () => {
    // Only a `.relay` route, no `.store` route → store = publish with `.relay`
    // swapped for `.store` (the `if (!store && publish)` branch).
    const relayOnly = [
      { prefix: 'g.proxy.relay', nextHop: 'connector', ilpAddress: 'g.proxy.relay' },
    ] as ConnectorConfig['routes'];
    expect(resolveRouteHints(relayOnly)).toEqual({
      publish: 'g.proxy.relay',
      store: 'g.proxy.store',
    });
  });

  it('falls back store to the publish value when publish does not end in .relay', () => {
    // A publish override that is NOT a `.relay` address and no `.store` route →
    // the `: publish` fallback of the store derivation (store == publish).
    expect(resolveRouteHints([], { publish: 'g.custom.pub' })).toEqual({
      publish: 'g.custom.pub',
      store: 'g.custom.pub',
    });
  });

  it('derives publish from a non-.store store override (publish == store)', () => {
    // store override not ending in `.store` and no `.relay` route → the
    // `if (!publish && store)` block takes the `: store` fallback.
    expect(resolveRouteHints([], { store: 'g.flat.target' })).toEqual({
      publish: 'g.flat.target',
      store: 'g.flat.target',
    });
  });
});

describe('normalizeSettlementAddressKeys (#289)', () => {
  const ADDR = '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab';

  it('re-keys a bare namespace to the qualified supported chain id', () => {
    expect(normalizeSettlementAddressKeys({ evm: ADDR }, ['evm:31337'])).toEqual({
      'evm:31337': ADDR,
    });
  });

  it('expands a bare namespace to EVERY supported chain in that namespace', () => {
    // An EVM account address is valid on every EVM chain, so a bare `evm` key
    // fans out to each announced eip-style chain id.
    expect(
      normalizeSettlementAddressKeys({ evm: ADDR, solana: 'So1addr' }, [
        'evm:31337',
        'evm:84532',
        'solana:devnet',
      ])
    ).toEqual({ 'evm:31337': ADDR, 'evm:84532': ADDR, 'solana:devnet': 'So1addr' });
  });

  it('passes an already-qualified key through when it is supported', () => {
    expect(normalizeSettlementAddressKeys({ 'evm:31337': ADDR }, ['evm:31337'])).toEqual({
      'evm:31337': ADDR,
    });
  });

  it('keeps a qualified key when no supportedChains are announced (core skips the membership check)', () => {
    expect(normalizeSettlementAddressKeys({ 'evm:31337': ADDR }, [])).toEqual({
      'evm:31337': ADDR,
    });
  });

  it('drops (and warns about) a qualified key not in supportedChains', () => {
    const warn = jest.fn();
    expect(normalizeSettlementAddressKeys({ 'evm:84532': ADDR }, ['evm:31337'], warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'self_announce_settlement_key_dropped',
      key: 'evm:84532',
    });
  });

  it('drops (and warns about) a bare key with no matching supported chain', () => {
    const warn = jest.fn();
    // No chainProviders → a bare `evm` key cannot be qualified, and emitting it
    // bare would make core reject the whole event — so it is dropped.
    expect(normalizeSettlementAddressKeys({ evm: ADDR }, [], warn)).toEqual({});
    expect(normalizeSettlementAddressKeys({ mina: 'B62q' }, ['evm:31337'], warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is wired into buildSelfAnnouncementInfo (warn sink reaches the caller)', () => {
    const warn = jest.fn();
    const config = relayConnectorConfig();
    // Give the terminated route an un-announceable extra key.
    config.routes[0]!.settlementAddresses = {
      evm: APEX_EVM,
      mina: 'B62qUnannounceable',
    };
    const info = buildSelfAnnouncementInfo(config, baseSelfAnnounce, warn);
    expect(info.settlementAddresses).toEqual({ 'evm:31337': APEX_EVM });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('deriveChainSettlementParams (toon-client#378)', () => {
  type ChainProvider = NonNullable<ConnectorConfig['chainProviders']>[number];

  const EVM_TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  const SOL_PROGRAM = 'ChanProg1111111111111111111111111111111111';
  const SOL_MINT = 'UsdcMint1111111111111111111111111111111111';
  const MINA_ZKAPP = 'B62qChannelZkApp111111111111111111111111111111111111111';
  const MINA_TOKEN_OWNER = 'B62qTokenOwner11111111111111111111111111111111111111111';

  function evm(overrides: Record<string, unknown> = {}): ChainProvider {
    return {
      chainType: 'evm',
      chainId: 'evm:31337',
      rpcUrl: 'http://localhost:8545',
      registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      keyId: 'k',
      tokenAddress: EVM_TOKEN,
      ...overrides,
    } as ChainProvider;
  }

  function solana(overrides: Record<string, unknown> = {}): ChainProvider {
    return {
      chainType: 'solana',
      chainId: 'solana:devnet',
      rpcUrl: 'http://localhost:8899',
      programId: SOL_PROGRAM,
      keyId: 'k',
      tokenMint: SOL_MINT,
      ...overrides,
    } as ChainProvider;
  }

  function mina(overrides: Record<string, unknown> = {}): ChainProvider {
    return {
      chainType: 'mina',
      chainId: 'mina:devnet',
      graphqlUrl: 'http://localhost:8080/graphql',
      zkAppAddress: MINA_ZKAPP,
      tokenAddress: MINA_TOKEN_OWNER,
      ...overrides,
    } as ChainProvider;
  }

  it('solana: programId → tokenNetworks, tokenMint → preferredTokens (keyed by chainId)', () => {
    expect(deriveChainSettlementParams([solana()])).toEqual({
      tokenNetworks: { 'solana:devnet': SOL_PROGRAM },
      preferredTokens: { 'solana:devnet': SOL_MINT },
    });
  });

  it('evm: tokenAddress → preferredTokens only (TokenNetwork is a runtime lookup, not config)', () => {
    expect(deriveChainSettlementParams([evm()])).toEqual({
      tokenNetworks: {},
      preferredTokens: { 'evm:31337': EVM_TOKEN },
    });
  });

  it('mina: zkAppAddress → tokenNetworks, token-owner tokenAddress → preferredTokens', () => {
    expect(deriveChainSettlementParams([mina()])).toEqual({
      tokenNetworks: { 'mina:devnet': MINA_ZKAPP },
      preferredTokens: { 'mina:devnet': MINA_TOKEN_OWNER },
    });
  });

  it('multi-chain: merges all families, keys matching the chainProviders chain ids', () => {
    expect(deriveChainSettlementParams([evm(), solana(), mina()])).toEqual({
      tokenNetworks: { 'solana:devnet': SOL_PROGRAM, 'mina:devnet': MINA_ZKAPP },
      preferredTokens: {
        'evm:31337': EVM_TOKEN,
        'solana:devnet': SOL_MINT,
        'mina:devnet': MINA_TOKEN_OWNER,
      },
    });
  });

  it('omits entries the provider does not configure (never emits empty strings)', () => {
    expect(
      deriveChainSettlementParams([
        evm({ tokenAddress: '' }),
        solana({ tokenMint: undefined }),
        mina({ tokenAddress: undefined, zkAppAddress: '' }),
      ])
    ).toEqual({
      tokenNetworks: { 'solana:devnet': SOL_PROGRAM },
      preferredTokens: {},
    });
  });

  it('returns empty maps for undefined / empty chainProviders and skips empty chainIds', () => {
    expect(deriveChainSettlementParams(undefined)).toEqual({
      tokenNetworks: {},
      preferredTokens: {},
    });
    expect(deriveChainSettlementParams([])).toEqual({ tokenNetworks: {}, preferredTokens: {} });
    expect(deriveChainSettlementParams([solana({ chainId: '' })])).toEqual({
      tokenNetworks: {},
      preferredTokens: {},
    });
  });

  it('is wired into buildSelfAnnouncementInfo, alongside the runtime tokenNetworks merge', () => {
    const config = relayConnectorConfig();
    config.chainProviders = [evm(), solana(), mina()];
    const RUNTIME_TN = '0xTokenNetworkResolvedAtRuntime';
    const info = buildSelfAnnouncementInfo(config, baseSelfAnnounce, undefined, {
      'evm:31337': RUNTIME_TN,
    });
    // Config-derived Solana/Mina entries + the runtime-resolved EVM entry.
    expect(info.tokenNetworks).toEqual({
      'evm:31337': RUNTIME_TN,
      'solana:devnet': SOL_PROGRAM,
      'mina:devnet': MINA_ZKAPP,
    });
    expect(info.preferredTokens).toEqual({
      'evm:31337': EVM_TOKEN,
      'solana:devnet': SOL_MINT,
      'mina:devnet': MINA_TOKEN_OWNER,
    });
  });

  it('runtime tokenNetworks win over a config-derived entry for the same chain', () => {
    const config = relayConnectorConfig();
    config.chainProviders = [solana()];
    const info = buildSelfAnnouncementInfo(config, baseSelfAnnounce, undefined, {
      'solana:devnet': 'RuntimeOverride1111111111111111111111111111',
    });
    expect(info.tokenNetworks).toEqual({
      'solana:devnet': 'RuntimeOverride1111111111111111111111111111',
    });
  });

  it('omits both maps entirely when nothing is derivable (no empty objects on the wire)', () => {
    // The default relay fixture's EVM provider has no tokenAddress.
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    expect(info.tokenNetworks).toBeUndefined();
    expect(info.preferredTokens).toBeUndefined();
  });
});

describe('buildSelfAnnouncementInfo — minimal / optional-omitted config', () => {
  it('omits optional fields and uses route prefixes when nothing is set', () => {
    // Forwarding-only routes (no `upstream` → no terminated routes), no
    // chainProviders, no settlementAddresses, no btpEndpoint — exercises every
    // "omitted" branch (supportedChains/settlementAddresses spreads, the
    // `?? prefix`, `?? []`, `?? ''` fallbacks, and the non-terminated source).
    const minimal: ConnectorConfig = {
      nodeId: 'connector',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [{ prefix: 'g.fwd.only', nextHop: 'peer' }],
    };
    const info = buildSelfAnnouncementInfo(minimal, {
      enabled: true,
      announceTo: 'g.fwd.only',
    });
    expect(info.ilpAddress).toBe('g.fwd.only'); // from prefix (no ilpAddress)
    expect(info.btpEndpoint).toBe(''); // omitted → ''
    expect(info.supportedChains).toBeUndefined();
    expect(info.settlementAddresses).toBeUndefined();
    expect(info.ilpAddresses).toBeUndefined();
  });

  it('yields an empty ilpAddress when there are no routes at all', () => {
    const noRoutes: ConnectorConfig = {
      nodeId: 'connector',
      btpServerPort: 3000,
      environment: 'development',
      peers: [],
      routes: [],
    };
    const info = buildSelfAnnouncementInfo(noRoutes, { enabled: true, announceTo: 'g.x' });
    expect(info.ilpAddress).toBe(''); // ilpAddresses[0] ?? ''
  });
});
