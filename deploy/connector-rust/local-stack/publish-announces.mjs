// =============================================================================
// publish-announces.mjs -- put the discovery events rig needs onto the local
// relay, so `rig clone` and `rig`'s paid writes can find this stack.
//
// WHY A HARNESS AT ALL
// --------------------
// ADR 0022: the connector never announces itself. "Answering is not
// announcing" -- discovery is the controller's business and lives outside the
// connector (ADR 0006). That is not a gap to be worked around: an OPERATOR
// publishing an announce that describes their own connector is exactly the
// mechanism, and this script is that operator. Nothing here belongs in the
// connector, and nothing here runs on devnet.
//
// The other candidate publisher -- core's `BootstrapService.announceViaIlp`,
// which would push an announce through ILP -- is currently broken
// (toon-protocol/toon#143: no execution condition, plaintext payload), so it
// cannot talk to a Rust connector at all. This script sidesteps it.
//
// WHY IT PAYS
// -----------
// Not by choice. The relay REFUSES free WebSocket writes:
//
//   > ["EVENT", <signed event>]
//   < ["OK","<id>",false,"restricted: writes require ILP payment"]
//
// (`packages/relay/src/websocket/ConnectionHandler.ts` -- `handleEvent`
// declines unconditionally, regardless of TOON_OBLIVIOUS_MODE or TOON_CHAIN.)
// Reads are free; every write, discovery events included, goes in through the
// connector as a paid, sealed packet. So this harness is also a second,
// independent demonstration of the paid write path -- this time driven by the
// TypeScript client rather than the Rust probe.
//
// LOCAL / DEV ONLY. Every key below is a published test fixture.
//
// It borrows toon-client's built workspace rather than vendoring any of it --
// `@toon-protocol/client` for the sealed wire (#450) and `@toon-protocol/core`
// for the canonical kind:10032 builder, so the announce is byte-shaped by the
// same code that parses it, not by this file's idea of the schema:
//
//   cd <toon-client> && pnpm install && pnpm -r build
//   TOON_CLIENT=<toon-client> node .../local-stack/publish-announces.mjs
// =============================================================================

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TOON_CLIENT = process.env.TOON_CLIENT;
if (!TOON_CLIENT || !existsSync(join(TOON_CLIENT, 'packages/client/dist/index.js'))) {
  console.error(
    'Set TOON_CLIENT to a BUILT toon-client checkout ' +
      '(pnpm install && pnpm -r build); packages/client/dist/index.js must exist.'
  );
  process.exit(2);
}
// pnpm's store leaves some of these ESM-only with no `require` condition, so
// resolve each package's own entry point off disk rather than through
// `require.resolve`.
const require = createRequire(join(TOON_CLIENT, 'packages/client/package.json'));
function importFrom(pkg, subpath = '.') {
  for (const scope of ['packages/client', 'packages/rig', '.']) {
    const dir = join(TOON_CLIENT, scope, 'node_modules', pkg);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const manifest = require(join(dir, 'package.json'));
    const entry = manifest.exports?.[subpath] ?? manifest.exports?.['.'];
    const file =
      (typeof entry === 'string' ? entry : (entry?.import ?? entry?.default)) ??
      manifest.module ??
      manifest.main;
    return import(join(dir, typeof file === 'string' ? file : file.default));
  }
  throw new Error(`cannot resolve ${pkg} under ${TOON_CLIENT}`);
}

const { ToonClient, HttpIlpClient } = await import(
  join(TOON_CLIENT, 'packages/client/dist/index.js')
);
const { buildIlpPeerInfoEvent } = await importFrom('@toon-protocol/core');
const { finalizeEvent, getPublicKey } = await importFrom('nostr-tools', './pure');
const { privateKeyToAccount } = await importFrom('viem', './accounts');

const EDGE = process.env.EDGE ?? 'http://127.0.0.1:3000';
const DEST = process.env.DEST ?? 'g.local.relay';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://127.0.0.1:7100';
const REPO_ID = process.env.REPO_ID ?? 'local-rehearsal';

// Operator notice (toon#183's IlpPeerInfo.notice) — configuration only, never
// composed here. Absent unless NOTICE_ID/NOTICE_SUMMARY/NOTICE_URL are ALL
// set, matching the common case: no key, no default on the announce.
function resolveNotice() {
  const id = process.env.NOTICE_ID;
  const summary = process.env.NOTICE_SUMMARY;
  const url = process.env.NOTICE_URL;
  const severity = process.env.NOTICE_SEVERITY;
  if (id === undefined && summary === undefined && url === undefined && severity === undefined) {
    return undefined;
  }
  if (id === undefined || summary === undefined || url === undefined) {
    throw new Error(
      'NOTICE_ID, NOTICE_SUMMARY and NOTICE_URL must all be set together (or none at all); ' +
        'NOTICE_SEVERITY is optional and defaults to "info"'
    );
  }
  const resolvedSeverity = severity ?? 'info';
  if (resolvedSeverity !== 'info' && resolvedSeverity !== 'action-required') {
    throw new Error(
      `NOTICE_SEVERITY must be "info" or "action-required", got "${resolvedSeverity}"`
    );
  }
  return { id, severity: resolvedSeverity, summary, url };
}
const NOTICE = resolveNotice();

// The local anvil settlement topology (see docker-compose.local.yml).
const CHAIN = 'evm:31337';
const CHAIN_ID = 31337;
const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Fixed local identities so a rerun replaces its own announces rather than
// piling up new authors on the relay. Test fixtures, worth nothing.
const OPERATOR_SK = new Uint8Array(32).fill(0x2a); // publishes the kind:10032
const OWNER_SK = new Uint8Array(32).fill(0x3b); // owns the demo repository
// anvil account #0 -- the payer whose claims buy these writes.
const PAYER = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);

// ── the paid publish path ────────────────────────────────────────────────────

const price = await (
  await fetch(`${EDGE}/ilp/routes/price?destination=${encodeURIComponent(DEST)}`)
).json();
console.log(`route ${DEST} costs ${price.price} per write`);

const client = new ToonClient({
  secretKey: OPERATOR_SK,
  connectorUrl: EDGE,
  destinationAddress: DEST,
  ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.local.harness' },
  toonEncoder: (e) => new TextEncoder().encode(JSON.stringify(e)),
  toonDecoder: (t) => JSON.parse(t),
});
// Straight to the one-shot HTTP transport: this harness is about the events,
// not about discovering the connector it is announcing.
client.state = {
  bootstrapService: {},
  discoveryTracker: {},
  runtimeClient: new HttpIlpClient({ httpEndpoint: `${EDGE}/ilp` }),
  peersDiscovered: 0,
};

let nonce = Number(process.env.NONCE ?? Date.now() % 1_000_000);

/** A balance-proof claim for one write, advancing the channel each time. */
async function claimFor(amount) {
  nonce += 1;
  const claim = {
    channelId: '0x' + '11'.repeat(32),
    nonce,
    transferredAmount: BigInt(amount) * BigInt(nonce),
    lockedAmount: 0n,
    locksRoot: '0x' + '00'.repeat(32),
    chainId: CHAIN_ID,
    tokenNetworkAddress: TOKEN_NETWORK,
  };
  claim.signature = await PAYER.signTypedData({
    domain: {
      name: 'TokenNetwork',
      version: '1',
      chainId: claim.chainId,
      verifyingContract: claim.tokenNetworkAddress,
    },
    types: {
      BalanceProof: [
        { name: 'channelId', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'transferredAmount', type: 'uint256' },
        { name: 'lockedAmount', type: 'uint256' },
        { name: 'locksRoot', type: 'bytes32' },
      ],
    },
    primaryType: 'BalanceProof',
    message: {
      channelId: claim.channelId,
      nonce: BigInt(claim.nonce),
      transferredAmount: claim.transferredAmount,
      lockedAmount: 0n,
      locksRoot: claim.locksRoot,
    },
  });
  claim.signerAddress = PAYER.address;
  return claim;
}

/** Publish one signed Nostr event through the connector, paying for it. */
async function publish(label, event) {
  const result = await client.publishEvent(event, {
    destination: DEST,
    claim: await claimFor(price.price),
    ilpAmount: BigInt(price.price),
    // The relay serves only POST /write. The route's handler_url already ends
    // in /write, but `HttpAppClient::deliver` JOINS this target onto it and an
    // absolute path replaces the base's -- so "/" would land on `/` and 404.
    proxyPath: '/write',
  });
  const body = result.response ? new TextDecoder().decode(result.response.body) : '';
  console.log(
    `${result.success ? 'PUBLISHED' : 'FAILED   '} kind:${event.kind} ${label} ` +
      `id=${event.id.slice(0, 16)}… ${body || result.error || ''}`
  );
  if (!result.success) process.exitCode = 1;
  return result.success;
}

// ── 1. kind:10032 -- who the connector is, so a paid write can find it ───────
// Everything `resolveNetworkTopology` (rig, cli/standalone-mode.ts) reads:
//   info.httpEndpoint    → the uplink; `proxyBaseOf` strips a trailing /ilp
//   info.ilpAddress      → the channel anchor and, with no `routes`, the
//                          publish destination too (deriveRouteDestinations
//                          passes a non-`<base>.relay.store` anchor through)
//   info.supportedChains → the exact strings chain negotiation intersects
//   info.tokenNetworks / preferredTokens / settlementAddresses → per-chain
//                          settlement parameters, preferred over presets
//   content.capabilities → the FLAT per-packet price floor for a route
//   content.chainRpcUrls → the RPC this deployment KNOWS works
// `pubkey` is the announcing author, and it is what `knownPeers` carries.
const announce = buildIlpPeerInfoEvent(
  {
    pubkey: getPublicKey(OPERATOR_SK),
    ilpAddress: DEST,
    btpEndpoint: `ws://127.0.0.1:3000`,
    httpEndpoint: `${EDGE}/ilp`,
    relayUrl: RELAY_WS,
    assetCode: 'USDC',
    assetScale: 6,
    supportedChains: [CHAIN],
    settlementAddresses: { [CHAIN]: PAYER.address },
    preferredTokens: { [CHAIN]: USDC },
    tokenNetworks: { [CHAIN]: TOKEN_NETWORK },
    // A real schema field (toon#183), not a content ride-along — set here,
    // never merged into the `announce.content = {...}` block below.
    ...(NOTICE ? { notice: NOTICE } : {}),
  },
  OPERATOR_SK
);
// The out-of-band content ride-alongs core's wire schema has no field for.
announce.content = JSON.stringify({
  ...JSON.parse(announce.content),
  routes: { publish: DEST, store: DEST },
  capabilities: [{ capability: 'os.publish', address: DEST, price: String(price.price) }],
  chainRpcUrls: { [CHAIN]: process.env.RPC_URL ?? 'http://127.0.0.1:8545' },
});
await publish(
  'connector announce',
  finalizeEvent(
    {
      kind: announce.kind,
      created_at: announce.created_at,
      tags: announce.tags,
      content: announce.content,
    },
    OPERATOR_SK
  )
);

// ── 2. kind:30617 -- a repository, so `rig clone` has something to clone ─────
// Announcement only, no kind:30618 state: an announced-but-never-pushed repo
// clones to an empty git repository with `origin` preconfigured, and needs no
// Arweave object at all -- which keeps this whole rehearsal on one machine.
const repo = finalizeEvent(
  {
    kind: 30617,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', REPO_ID],
      ['name', REPO_ID],
      ['description', 'a repository that exists only on the local relay'],
    ],
    content: '',
  },
  OWNER_SK
);
await publish('repository announcement', repo);

console.log(`\nrepo owner (hex): ${getPublicKey(OWNER_SK)}`);
console.log(`rig clone ${RELAY_WS} ${getPublicKey(OWNER_SK)}/${REPO_ID} <dir>`);
