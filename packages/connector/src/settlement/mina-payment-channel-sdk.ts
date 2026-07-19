/**
 * Mina Payment Channel SDK
 *
 * Provides a TypeScript abstraction over the Mina zkApp payment channel contract.
 * All o1js interactions are encapsulated here so the connector package does NOT
 * import o1js directly.
 *
 * Epic 34 Story 34.4: MinaPaymentChannelSDK
 *
 * @remarks
 * This SDK uses dynamic imports to load o1js and the mina-zkapp package at
 * runtime. If o1js is not installed, a descriptive MinaChannelError (code 9999)
 * is thrown on first use, not on import.
 *
 * o1js is a DUAL CJS/ESM package whose proof-system worker pool is
 * per-module-instance state; loading it as both a CJS `require` and an ESM
 * `import` produces two instances and breaks settlement PROVING with
 * "workersReadyResolve is not a function". To keep o1js a SINGLE instance the
 * loaders below force GENUINE ESM imports of o1js and the mina-zkapp `dist-esm/`
 * build — see {@link esmDynamicImport} and issue #368.
 *
 * @module mina-payment-channel-sdk
 */

import type { Logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Channel State
// ---------------------------------------------------------------------------

/**
 * Mina channel state as read from the zkApp on-chain state.
 *
 * Field names match the zkApp's `PaymentChannel` state fields.
 */
export interface MinaChannelState {
  /** Base58 public key of participant A */
  participantA: string;
  /** Base58 public key of participant B */
  participantB: string;
  /** Channel state enum: 0=UNINITIALIZED, 1=OPEN, 2=CLOSING, 3=SETTLED */
  channelState: number;
  /** Total deposit amount in the channel */
  depositTotal: bigint;
  /** Poseidon hash of the balance commitment */
  balanceCommitment: string;
  /** Monotonic claim nonce */
  nonceField: bigint;
  /** Slot at which the channel was closed (0 if not closed) */
  closedAtSlot: bigint;
  /** Settlement timeout in slots */
  settlementTimeout: bigint;
  /** Token identifier */
  tokenId: string;
  /** Poseidon hash of channel parameters */
  channelHash: string;
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

/** Error codes for MinaChannelError */
export const MINA_ERROR_CODES = {
  COMPILE_FAILED: 1001,
  TRANSACTION_FAILED: 1002,
  PROOF_GENERATION_FAILED: 1003,
  INVALID_CHANNEL_STATE: 1004,
  ACCOUNT_NOT_FOUND: 1005,
  INVALID_PROOF: 1006,
  ARCHIVE_NODE_ERROR: 1007,
  INVALID_PARAMETERS: 1008,
  O1JS_NOT_AVAILABLE: 9999,
} as const;

/**
 * Custom error type for Mina payment channel SDK operations.
 */
export class MinaChannelError extends Error {
  readonly code: number;
  readonly errorName: string;

  constructor(message: string, code: number, errorName: string) {
    super(message);
    this.name = 'MinaChannelError';
    this.code = code;
    this.errorName = errorName;
    Error.captureStackTrace(this, MinaChannelError);
  }
}

// ---------------------------------------------------------------------------
// SDK Open Channel Result
// ---------------------------------------------------------------------------

/** Result of opening a Mina payment channel. */
export interface MinaOpenChannelResult {
  /** zkApp address for the newly created channel */
  zkAppAddress: string;
  /** Transaction hash */
  txHash: string;
}

/** Generic Mina transaction result. */
export interface MinaTxResult {
  /** Transaction hash */
  txHash: string;
}

/** Event subscription handle. */
export interface MinaSubscription {
  /** Stop receiving events and clean up resources */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Dynamic Import Helpers (o1js and mina-zkapp)
// ---------------------------------------------------------------------------

/**
 * GENUINE ESM dynamic import — bypasses tsc's `module: commonjs` downleveling of
 * `import()` to `require()`.
 *
 * Why this exists (the Mina zkApp worker-init bug — "workersReadyResolve is not
 * a function", issue #368): o1js is a DUAL CJS/ESM package. `require('o1js')`
 * resolves the CJS build (`dist/node/index.cjs`) while `import 'o1js'` resolves
 * the ESM build (`dist/node/index.js`) — two SEPARATE module instances, each
 * with its own Snarky bindings AND its own worker-pool state. The proof-system
 * worker pool wires a single `globalThis.startWorkers`; whichever instance loads
 * last wins that slot. `mina-fungible-token` is ESM-only, so the moment the
 * mina-zkapp package graph loads it, a SECOND (ESM) o1js instance's
 * `startWorkers` clobbers the global — and when `.compile()` on the FIRST (CJS)
 * instance calls `initThreadPool`, the wasm invokes the OTHER instance's
 * `startWorkers`, whose `workersReadyResolve` was never assigned. Result:
 * `TypeError: workersReadyResolve is not a function` at `node-backend.js`, i.e.
 * settlement PROVING (`claimFromChannel` etc.) can never run. (Claim VERIFY —
 * signature + nonce — never compiles a circuit, so it is unaffected; matching
 * the field observation on ghcr.io/toon-protocol/connector:3.35.0.)
 *
 * The deploy tooling already solved this (#352) by running the proving path as
 * pure ESM against the mina-zkapp `dist-esm/` build; the faucet mint path does
 * the same. The connector runtime is CJS, so it must force GENUINE ESM imports
 * of BOTH o1js and the mina-zkapp classes — one shared ESM o1js instance across
 * o1js + mina-zkapp + mina-fungible-token. `tsc` would otherwise rewrite our
 * `import()` back into `require()` (re-splitting the instance), so we go through
 * a `Function` indirection it does not transform. Verified VK-stable: the
 * PaymentChannel / UsdcChannel token verification keys are byte-identical to the
 * CJS-compiled ones (o1js compilation is deterministic across module systems).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const esmDynamicImport: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier);'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) as (specifier: string) => Promise<any>;

/**
 * The mina-zkapp package's parallel pure-ESM build (`dist-esm/`, produced by
 * `packages/mina-zkapp/scripts/build-esm.mjs`). Importing these ESM entrypoints
 * (rather than the package's default CJS `dist/`) is what keeps o1js a SINGLE
 * instance — see {@link esmDynamicImport}. There is no `dist-esm/index.js`
 * barrel, so each class is imported from its own module.
 */
const MINA_ZKAPP_ESM_PAYMENT_CHANNEL = '@toon-protocol/mina-zkapp/dist-esm/PaymentChannel.js';
const MINA_ZKAPP_ESM_USDC_CHANNEL_TOKEN =
  '@toon-protocol/mina-zkapp/dist-esm/usdc-channel-token.js';

/**
 * True inside the jest runner. The genuine ESM import above cannot be
 * intercepted by `jest.mock('o1js' | '@toon-protocol/mina-zkapp')` (which hooks
 * `require`), and jest's VM provides no dynamic-import callback, so under jest
 * the loaders fall back to a plain `import()` — which tsc downlevels to
 * `require`, keeping the existing mocked SDK unit suite working. The REAL
 * single-instance compile/prove path (genuine ESM, no mocks) is exercised by the
 * mina-zkapp connector-runtime compile guard (#368) and the e2e settlement flow,
 * not by these mocked unit tests. In production `JEST_WORKER_ID` is unset, so the
 * genuine ESM import always runs.
 */
const IS_JEST = typeof process !== 'undefined' && !!process.env.JEST_WORKER_ID;

/** Cached o1js module */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let o1jsModule: any = null;

/**
 * Lazily load the o1js module. Throws MinaChannelError (code 9999) if not installed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getO1js(): Promise<any> {
  if (!o1jsModule) {
    try {
      // GENUINE ESM import (single-instance requirement) — see esmDynamicImport.
      // Under jest, a plain (mockable) import().
      o1jsModule = IS_JEST ? await import('o1js') : await esmDynamicImport('o1js');
    } catch {
      throw new MinaChannelError(
        'o1js is required for Mina payment channels but is not installed. ' +
          'Install it with: npm install o1js',
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );
    }
  }
  return o1jsModule;
}

/** Cached PaymentChannel class */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PaymentChannelContract: any = null;

/**
 * Lazily load the PaymentChannel class from @toon-protocol/mina-zkapp.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPaymentChannelContract(): Promise<any> {
  if (!PaymentChannelContract) {
    try {
      // GENUINE ESM import of the pure-ESM build (single-o1js-instance
      // requirement) — see esmDynamicImport for the worker-init bug this avoids.
      // Under jest, a plain (mockable) import() of the package.
      const mod = IS_JEST
        ? await import('@toon-protocol/mina-zkapp')
        : await esmDynamicImport(MINA_ZKAPP_ESM_PAYMENT_CHANNEL);
      PaymentChannelContract = mod.PaymentChannel;
    } catch (err) {
      // Surface the REAL underlying error. A blanket "not installed" masks the
      // actual failure: e.g. a ts-jest decorator-compile error (TS1240) when the
      // module resolves to mina-zkapp's TS `src` under the wrong tsconfig, or an
      // `ERR_REQUIRE_ESM` from its ESM-only `mina-fungible-token` dep on a Node
      // runtime without `require(esm)` — neither of which is "not installed".
      const reason = err instanceof Error ? err.message : String(err);
      throw new MinaChannelError(
        '@toon-protocol/mina-zkapp could not be loaded for Mina payment channels. ' +
          `Underlying error: ${reason}`,
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );
    }
  }
  return PaymentChannelContract;
}

/** Cached `UsdcChannelToken` class from `@toon-protocol/mina-zkapp`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UsdcChannelTokenContract: any = null;

/**
 * Lazily load the in-proof-enforcing `UsdcChannelToken` owner class from
 * `@toon-protocol/mina-zkapp`.
 *
 * USDC across all chains: the Mina `PaymentChannel` zkApp is accounting-only —
 * it CANNOT move the USDC custom token (o1js rejects a channel-proof-authored
 * custom-token balance change with `Token_owner_not_caller`). `UsdcChannelToken`
 * (a `FungibleToken` subclass) is the custom token OWNER, and the only actor
 * that can move USDC. Unlike the merged #191/#192 design — where the SDK built
 * raw `token.transfer(...)` updates and was solely responsible for matching the
 * escrow move to the channel accounting — `UsdcChannelToken` binds payouts to
 * the channel's on-chain commitment IN THE PROOF via `depositToChannel` /
 * `settleFromChannel`. The SDK therefore only has to compose those methods in
 * the right tx shape; the contract enforces correctness (matching EVM/Solana).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getUsdcChannelTokenContract(): Promise<any> {
  if (!UsdcChannelTokenContract) {
    try {
      // GENUINE ESM import of the pure-ESM build (single-o1js-instance
      // requirement) — see esmDynamicImport for the worker-init bug this avoids.
      // Under jest, a plain (mockable) import() of the package.
      const mod = IS_JEST
        ? await import('@toon-protocol/mina-zkapp')
        : await esmDynamicImport(MINA_ZKAPP_ESM_USDC_CHANNEL_TOKEN);
      UsdcChannelTokenContract = mod.UsdcChannelToken;
    } catch (err) {
      // Surface the REAL underlying error instead of a misleading "not
      // installed" (see getPaymentChannelContract for the failure modes this
      // masks).
      const reason = err instanceof Error ? err.message : String(err);
      throw new MinaChannelError(
        '@toon-protocol/mina-zkapp (UsdcChannelToken) could not be loaded for USDC-token ' +
          `Mina payment channels. Underlying error: ${reason}`,
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );
    }
  }
  return UsdcChannelTokenContract;
}

/**
 * USDC token decimals expected by the cross-chain settlement design.
 *
 * USDC is configured at 6 decimals on every chain (EVM MockERC20, Solana SPL
 * mint, and the Mina `FungibleToken`) so a claim's base-unit amount means the
 * same thing everywhere (1 USDC = 1_000_000 base units) — no cross-chain decimal
 * normalization. The SDK asserts the configured token reports exactly 6 decimals
 * so a misconfigured token fails loud instead of mis-settling.
 */
export const EXPECTED_USDC_DECIMALS = 6;

/** Default polling interval for channel subscriptions (30 seconds) */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Default transaction fee for zkApp transactions, in nanomina (0.1 MINA).
 *
 * o1js builds a fee payer with a zero fee unless one is supplied, and real
 * Mina networks (devnet/mainnet/lightnet) reject zero-fee zkApp transactions
 * with "Insufficient fee". 0.1 MINA is the conventional zkApp fee and is
 * applied to every state-changing transaction the SDK submits (Issue #126).
 */
export const DEFAULT_MINA_TX_FEE_NANOMINA = 100_000_000n;

/**
 * How long `openChannel` waits for a freshly-deployed zkApp account to become
 * observable on-chain before giving up, in milliseconds (Issue #128).
 *
 * The zkApp account is created by the deploy transaction; `initializeChannel`
 * must run in a *separate* transaction once that account exists, otherwise its
 * `getAndRequireEquals()` state precondition cannot be satisfied (o1js throws
 * "Could not find account"). 5 minutes covers lightnet/devnet block inclusion.
 */
const DEFAULT_DEPLOY_CONFIRMATION_TIMEOUT_MS = 300_000;

/** Poll interval while waiting for the deployed zkApp account (Issue #128). */
const DEPLOY_CONFIRMATION_POLL_INTERVAL_MS = 3_000;

/**
 * Reset the module-level caches for o1js and PaymentChannel.
 *
 * This is intended for testing only -- it allows test suites to simulate
 * the "o1js not installed" scenario by clearing the cached modules.
 *
 * @internal
 */
export function _resetModuleCaches(): void {
  o1jsModule = null;
  PaymentChannelContract = null;
  UsdcChannelTokenContract = null;
}

// ---------------------------------------------------------------------------
// SDK Class
// ---------------------------------------------------------------------------

/**
 * TypeScript wrapper for the Mina zkApp payment channel contract.
 *
 * All o1js-dependent operations (Poseidon hashing, proof generation,
 * circuit compilation) are encapsulated here.
 *
 * @remarks
 * The `_signerPrivateKey` parameter is optional. Methods that require signing
 * (openChannel, deposit, claimFromChannel, closeChannel, settleChannel,
 * signBalanceProof) throw MinaChannelError with code 1008 if no signer key
 * was provided at construction.
 */
export class MinaPaymentChannelSDK {
  /** Mina GraphQL endpoint for RPC communication */
  readonly graphqlUrl: string;

  /** Whether the zkApp circuit has been compiled */
  private _compiled = false;

  /** Cached verification key from compilation (used by future proof verification) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _verificationKey: any = null;

  /**
   * The verification key from circuit compilation.
   * Returns `null` if `compileContract()` has not been called yet.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get verificationKey(): any {
    return this._verificationKey;
  }

  /** Whether the Mina network instance has been set */
  private _networkInitialized = false;

  /** Cached participant keys from openChannel calls (keyed by zkApp address) */
  private readonly _participantCache = new Map<
    string,
    { participantA: string; participantB: string }
  >();

  /**
   * Cached on-chain `channelHash` per zkApp address.
   *
   * The channelHash (`Poseidon(participantA.x, participantB.x, channelNonce)`) is
   * immutable for the lifetime of a channel, so it is safe to memoize. It is the
   * canonical channel-identity field bound by the on-chain `claimFromChannel`
   * method, so the off-chain proof message must bind the same value (Issue #114).
   */
  private readonly _channelHashCache = new Map<string, string>();

  /**
   * Cached channel (zkApp) private keys per zkApp address, base58-encoded.
   *
   * In-proof enforcement: SETTLE no longer needs the channel key — the escrow
   * payouts are authorized purely by the `UsdcChannelToken` owner's proof plus
   * the escrow's custodial `send: none` permission. The channel key is, however,
   * required for the ONE-TIME {@link enableChannelEscrow} setup (setting the
   * escrow account's permissions needs the escrow/channel account's signature).
   * The key is generated in {@link openChannel} (it signs the deploy) and retained
   * here so the same SDK instance can sign that one-time escrow-enable tx. Only
   * channels opened by this SDK instance carry a cached key; an externally-opened
   * channel must supply `channelPrivateKey` to `enableChannelEscrow`.
   */
  private readonly _channelKeyCache = new Map<string, string>();

  /**
   * Set of zkApp addresses whose escrow token account this SDK instance has
   * already made custodial via {@link enableChannelEscrow}. Memoizes the
   * one-time escrow setup so {@link deposit} can run it on the channel's first
   * deposit and skip it thereafter.
   */
  private readonly _escrowEnabled = new Set<string>();

  /**
   * Cached USDC `UsdcChannelToken` owner contract instance and its derived
   * tokenId.
   *
   * Instantiated lazily from {@link _tokenAddress}. The same instance is reused
   * to compose the in-proof `enableChannelEscrow` / `depositToChannel` /
   * `settleFromChannel` methods on open/deposit/settle and to derive the
   * channel's tokenId on open.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _tokenContext: { token: any; tokenId: string } | null = null;

  /**
   * Fee applied to every state-changing zkApp transaction, in nanomina.
   *
   * Real Mina networks reject zero-fee zkApp transactions with "Insufficient
   * fee"; o1js does not set a fee unless one is supplied. Defaults to
   * {@link DEFAULT_MINA_TX_FEE_NANOMINA} (0.1 MINA) (Issue #126).
   */
  private readonly _txFee: bigint;

  /**
   * Base58 address of the USDC token-owner (`UsdcChannelToken`) zkApp, or
   * undefined for legacy native-MINA channels. When set, deposit/settle compose
   * the in-proof `depositToChannel` / `settleFromChannel` owner methods and
   * `openChannel` uses the real `token.deriveTokenId()` as the channel tokenId.
   */
  private readonly _tokenAddress?: string;

  /**
   * Configured USDC tokenId (decimal Field string), if provided. When set, the
   * SDK asserts it matches the token derived from {@link _tokenAddress} and that
   * inbound claim tokenIds match it.
   */
  private readonly _configuredTokenId?: string;

  constructor(
    graphqlUrl: string,
    private readonly _zkAppAddress: string,
    private readonly _logger: Logger,
    private readonly _signerPrivateKey?: string,
    txFeeNanomina: bigint = DEFAULT_MINA_TX_FEE_NANOMINA,
    tokenConfig?: { tokenAddress?: string; tokenId?: string }
  ) {
    this.graphqlUrl = graphqlUrl;
    this._txFee = txFeeNanomina;
    this._tokenAddress = tokenConfig?.tokenAddress;
    this._configuredTokenId = tokenConfig?.tokenId;
  }

  /**
   * Whether this SDK instance custodies a USDC custom token (vs. legacy native
   * MINA). True iff a token-owner address was configured.
   */
  get isUsdcToken(): boolean {
    return this._tokenAddress !== undefined && this._tokenAddress !== '';
  }

  /**
   * Build the o1js fee-payer spec for {@link Mina.transaction}.
   *
   * Always sets an explicit fee so transactions are not rejected for
   * "Insufficient fee" on real networks. The fee is passed as a decimal
   * string of nanomina; o1js converts it to `UInt64` internally, so the SDK
   * does not need to import the `UInt64` type (Issue #126).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _feePayer(sender: any): { sender: any; fee: string } {
    return { sender, fee: this._txFee.toString() };
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure the signer private key is available. Throws MinaChannelError (1008)
   * if not configured. Returns the verified signer key for use in callers.
   */
  private _requireSignerKey(): string {
    if (!this._signerPrivateKey) {
      throw new MinaChannelError(
        'signer private key required for this operation',
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }
    return this._signerPrivateKey;
  }

  /**
   * Set the Mina active instance to the configured network.
   * Caches the network initialization to avoid redundant global state mutations.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _setNetwork(): Promise<any> {
    const { Mina } = await getO1js();
    if (!this._networkInitialized) {
      const Network = Mina.Network(this.graphqlUrl);
      Mina.setActiveInstance(Network);
      this._networkInitialized = true;
    }
    return Mina;
  }

  /**
   * Read the LIVE network global slot off-chain (#202).
   *
   * `initiateClose` takes the current slot as a `currentSlot` witness and pins it
   * with a range precondition; the SDK must therefore read the genuinely-current
   * slot from the node before building the close tx. `fetchLastBlock` queries the
   * configured GraphQL endpoint for the best tip's `globalSlotSinceGenesis` (and
   * also refreshes o1js's cached network state). Callers must have bound the
   * network via `_setNetwork()` first.
   *
   * @returns the current global slot as a UInt32
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _currentGlobalSlot(): Promise<any> {
    const { fetchLastBlock } = await getO1js();
    const block = await fetchLastBlock(this.graphqlUrl);
    return block.globalSlotSinceGenesis;
  }

  /**
   * Create a zkApp instance at the given address.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _getZkApp(channelAddress: string): Promise<any> {
    const { PublicKey, fetchAccount } = await getO1js();
    const Contract = await getPaymentChannelContract();

    // Bind the active Mina instance before fetching/constructing the contract so
    // that any `<field>.get()` read on the returned instance resolves against the
    // configured network rather than an empty active-instance ledger (Issue #95).
    // The `_networkInitialized` guard makes this idempotent for callers (settle
    // paths) that already bound the network.
    await this._setNetwork();

    const zkAppPublicKey = PublicKey.fromBase58(channelAddress);

    const result = await fetchAccount({ publicKey: zkAppPublicKey });
    if (result.error) {
      throw new MinaChannelError(
        `Failed to fetch account at ${channelAddress}: ${String(result.error)}`,
        MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
        'ACCOUNT_NOT_FOUND'
      );
    }

    return new Contract(zkAppPublicKey);
  }

  /**
   * Poll until an account is observable on-chain, refreshing the o1js cache.
   *
   * Used after a deploy to confirm the new zkApp account exists before a
   * follow-up method (e.g. `initializeChannel`) binds a precondition to its
   * on-chain state (Issue #128). Each successful `fetchAccount` also primes the
   * cache the next transaction reads from.
   *
   * @param channelAddress - Base58 address to wait for
   * @param timeoutMs - Maximum time to wait
   * @throws {MinaChannelError} code 1005 if the account never appears in time
   */
  private async _waitForAccount(
    channelAddress: string,
    timeoutMs: number = DEFAULT_DEPLOY_CONFIRMATION_TIMEOUT_MS
  ): Promise<void> {
    const { PublicKey, fetchAccount } = await getO1js();
    await this._setNetwork();
    const zkAppPublicKey = PublicKey.fromBase58(channelAddress);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const result = await fetchAccount({ publicKey: zkAppPublicKey });
      if (!result.error) return;
      if (Date.now() >= deadline) {
        throw new MinaChannelError(
          `Deployed zkApp account ${channelAddress} did not appear on-chain within ` +
            `${timeoutMs}ms: ${String(result.error)}`,
          MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
          'ACCOUNT_NOT_FOUND'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, DEPLOY_CONFIRMATION_POLL_INTERVAL_MS));
    }
  }

  /**
   * Resolve the on-chain `channelHash` for a channel, memoizing the result.
   *
   * The channelHash is `Poseidon(participantA.x, participantB.x, channelNonce)` and
   * is written once at `initializeChannel` time, so it never changes for a given
   * channel. It is the exact channel-identity field the on-chain `claimFromChannel`
   * method signs over (`storedChannelHash`), so off-chain proof construction and
   * verification must bind this same value rather than `Poseidon([zkApp.x])`
   * (Issue #114, Bug B).
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @returns The on-chain channelHash as a decimal Field string
   */
  private async _resolveChannelHash(channelAddress: string): Promise<string> {
    const cached = this._channelHashCache.get(channelAddress);
    if (cached) {
      return cached;
    }
    const zkApp = await this._getZkApp(channelAddress);
    const channelHash = zkApp.channelHash.get().toString();
    this._channelHashCache.set(channelAddress, channelHash);
    return channelHash;
  }

  /**
   * Instantiate the USDC token-owner (`UsdcChannelToken`) contract and resolve
   * its tokenId, memoizing the result.
   *
   * The token-owner contract is required to compose the in-proof
   * `depositToChannel` / `settleFromChannel` / `enableChannelEscrow` owner
   * methods (only the owner may move its custom token). The derived tokenId is
   * the channel's tokenId — it is what `openChannel` writes into `tokenId_` and
   * what inbound claims must match.
   *
   * Enforcement: when a tokenId was configured (`MinaProviderConfig.tokenId`),
   * this asserts the on-chain token derives the SAME tokenId, so a
   * tokenAddress/tokenId misconfiguration fails loud instead of silently
   * escrowing/distributing a different token than the claim accounting assumes.
   *
   * @throws {MinaChannelError} code 1008 if no token-owner address was configured
   *   or the configured tokenId does not match the derived tokenId
   */
  private async _getTokenContext(): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: any;
    tokenId: string;
  }> {
    if (!this.isUsdcToken || !this._tokenAddress) {
      throw new MinaChannelError(
        'USDC token operations require a configured token-owner address ' +
          '(MinaProviderConfig.tokenAddress), but none was provided.',
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }
    if (this._tokenContext) {
      return this._tokenContext;
    }

    const { PublicKey } = await getO1js();
    const UsdcChannelToken = await getUsdcChannelTokenContract();
    await this._setNetwork();

    const tokenOwnerKey = PublicKey.fromBase58(this._tokenAddress);
    const token = new UsdcChannelToken(tokenOwnerKey);
    const tokenId = token.deriveTokenId().toString();

    // Enforcement: the configured tokenId (if any) must match the token the
    // owner address actually derives. A mismatch means the SDK would escrow /
    // distribute a different token than the channel/claims assume.
    if (this._configuredTokenId !== undefined && this._configuredTokenId !== tokenId) {
      throw new MinaChannelError(
        `Configured Mina tokenId (${this._configuredTokenId}) does not match the tokenId derived ` +
          `from the configured token-owner address ${this._tokenAddress} (${tokenId}). ` +
          'Check MinaProviderConfig.tokenAddress / tokenId.',
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }

    this._tokenContext = { token, tokenId };
    return this._tokenContext;
  }

  /**
   * Assert the configured USDC token reports exactly 6 decimals on-chain (#192).
   *
   * USDC is 6 decimals on every chain so a claim's base-unit amount is identical
   * everywhere. The decimals live in the token-owner's on-chain `decimals` state;
   * we read it via `fetchAccount` + the contract's `decimals` getter. A token
   * that reports anything other than 6 is a misconfiguration and must fail loud
   * before any settlement is attempted.
   *
   * Best-effort: if the decimals cannot be read (e.g. the getter is unavailable
   * in a given o1js/lib version), this logs a warning rather than blocking the
   * tx — the tokenId-match assertion remains the primary correctness gate.
   */
  private async _assertTokenDecimals(): Promise<void> {
    const { token } = await this._getTokenContext();
    const { fetchAccount, PublicKey } = await getO1js();
    try {
      // Refresh the token-owner account so its `decimals` state is readable.
      await fetchAccount({ publicKey: PublicKey.fromBase58(this._tokenAddress as string) });
      // `mina-fungible-token` exposes decimals via `getDecimals()` (a UInt8).
      // Fall back to a `decimals` state getter if present.
      let decimals: number | undefined;
      if (typeof token.getDecimals === 'function') {
        decimals = Number(token.getDecimals().toString());
      } else if (token.decimals && typeof token.decimals.get === 'function') {
        decimals = Number(token.decimals.get().toString());
      }
      if (decimals === undefined) {
        this._logger.warn(
          { event: 'token_decimals_unreadable', tokenAddress: this._tokenAddress },
          'Could not read USDC token decimals; skipping the decimals==6 assertion'
        );
        return;
      }
      if (decimals !== EXPECTED_USDC_DECIMALS) {
        throw new MinaChannelError(
          `Configured Mina USDC token reports ${decimals} decimals, but ${EXPECTED_USDC_DECIMALS} ` +
            'are required for cross-chain base-unit parity (#192). Refusing to settle.',
          MINA_ERROR_CODES.INVALID_PARAMETERS,
          'INVALID_PARAMETERS'
        );
      }
    } catch (err: unknown) {
      if (err instanceof MinaChannelError) throw err;
      // A read failure (network / version) is non-fatal; the tokenId assertion
      // is the load-bearing check.
      this._logger.warn(
        {
          event: 'token_decimals_check_failed',
          tokenAddress: this._tokenAddress,
          error: err instanceof Error ? err.message : String(err),
        },
        'USDC token decimals check failed to read; proceeding (tokenId match still enforced)'
      );
    }
  }

  /**
   * Assert an inbound claim's tokenId matches the configured channel token (#192).
   *
   * The channel proof no longer binds token amounts, so the SDK is the
   * enforcement point: a claim carrying a different tokenId than this channel
   * custodies must be rejected before any on-chain settlement.
   *
   * @param claimTokenId - tokenId carried by the inbound `MinaClaimMessage`
   * @throws {MinaChannelError} code 1008 on mismatch
   */
  async assertClaimTokenId(claimTokenId: string): Promise<void> {
    if (!this.isUsdcToken) {
      // Legacy native-MINA channels: nothing to enforce.
      return;
    }
    const { tokenId } = await this._getTokenContext();
    if (claimTokenId !== tokenId) {
      throw new MinaChannelError(
        `Inbound Mina claim tokenId (${claimTokenId}) does not match this channel's configured ` +
          `USDC tokenId (${tokenId}). The claim is for a different token (#192).`,
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }
  }

  /**
   * Wrap errors from o1js operations as MinaChannelError.
   */
  private _wrapError(err: unknown, code: number, errorName: string): MinaChannelError {
    if (err instanceof MinaChannelError) {
      return err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return new MinaChannelError(message, code, errorName);
  }

  /**
   * Safely deserialize a JSON signature string into an o1js Signature object.
   *
   * Validates the parsed shape before passing to `Signature.fromJSON()` to
   * prevent injection or malformed data from reaching o1js internals.
   *
   * Accepts two serializations (Issue #121):
   *   1. The bare signature `{ r: string, s: string }` — what dual-party
   *      `signatureB`, internal callers, and the `closeChannel` defaults pass.
   *   2. The full `signBalanceProof` wrapper
   *      `{ commitment, signature: { r, s }, nonce, signerPublicKey }` — what the
   *      inbound per-packet claim carries in its `proof` field and what the
   *      settlement executor forwards verbatim as `signatureA`.
   * `signBalanceProof` nests `{r,s}` under `.signature`; without this the wrapper
   * parses fine but has no top-level `r`/`s`, so on-chain `claimFromChannel`
   * aborted at parameter construction.
   *
   * @param signatureStr - JSON string: a bare `{ r, s }` or a `signBalanceProof`
   *   wrapper carrying `{ r, s }` under `.signature`
   * @param fieldName - Human-readable field name for error messages
   * @returns o1js Signature object
   * @throws {MinaChannelError} code 1008 if the signature string is malformed
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _deserializeSignature(signatureStr: string, fieldName: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(this._normalizeSerializedProof(signatureStr));
    } catch {
      throw new MinaChannelError(
        `Invalid ${fieldName}: expected a JSON string with { r, s } fields, received malformed JSON`,
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }

    // Unwrap the `signBalanceProof` wrapper: when `{r,s}` is not at the top level
    // but is nested under `.signature`, use the inner object (Issue #121).
    const candidate =
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.r !== 'string' &&
      typeof parsed.signature === 'object' &&
      parsed.signature !== null
        ? parsed.signature
        : parsed;

    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.r !== 'string' ||
      typeof candidate.s !== 'string'
    ) {
      throw new MinaChannelError(
        `Invalid ${fieldName}: expected an object with string 'r' and 's' fields`,
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }

    // Import Signature from the cached o1js module (caller must have loaded o1js already)
    const { Signature } = o1jsModule;
    return Signature.fromJSON({ r: candidate.r, s: candidate.s });
  }

  /**
   * Normalize a serialized proof/signature string to its raw-JSON form.
   *
   * The canonical wire encoding for a Mina claim `proof` is base64-encoded JSON
   * (Issue #90): {@link validateMinaClaim} gates inbound claims on a base64
   * regex, and the per-packet claim producer base64-encodes the proof it emits.
   * The settlement side must therefore base64-decode before `JSON.parse`.
   *
   * Raw-JSON inputs (internal callers, dual-party `signatureB`, and pre-#90
   * claims) remain accepted: a JSON payload begins with `{` or `[`, characters
   * that never appear in base64, so the two encodings are distinguishable
   * without ambiguity. Anything that is neither is returned unchanged so the
   * caller's own `JSON.parse` surfaces a precise error.
   *
   * @param input - A serialized proof/signature: base64(JSON) or raw JSON
   * @returns The raw JSON string
   */
  private _normalizeSerializedProof(input: string): string {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Already raw JSON — no decode needed.
      return input;
    }
    try {
      const decoded = Buffer.from(input, 'base64').toString('utf8');
      // Only accept the decode if it actually yields JSON; otherwise fall
      // through to returning the original input.
      JSON.parse(decoded);
      return decoded;
    } catch {
      return input;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Derive the signer's public key (base58) from the configured private key.
   *
   * @returns Base58-encoded public key corresponding to the signer's private key
   * @throws {MinaChannelError} code 1008 if no signer key is configured
   */
  async getSignerPublicKey(): Promise<string> {
    const signerKeyBase58 = this._requireSignerKey();
    try {
      const { PrivateKey } = await getO1js();
      const privateKey = PrivateKey.fromBase58(signerKeyBase58);
      return privateKey.toPublicKey().toBase58();
    } catch (err: unknown) {
      if (err instanceof MinaChannelError) throw err;
      throw this._wrapError(err, MINA_ERROR_CODES.INVALID_PARAMETERS, 'INVALID_PARAMETERS');
    }
  }

  /**
   * Pre-compile the zkApp proof circuit.
   * Must be called before any proof-generating operations.
   *
   * Compilation is cached -- subsequent calls are no-ops.
   */
  async compileContract(): Promise<void> {
    if (this._compiled) {
      this._logger.debug(
        { event: 'compile_contract_cached', zkAppAddress: this._zkAppAddress },
        'Mina zkApp circuit already compiled, skipping'
      );
      return;
    }

    this._logger.info(
      { event: 'compile_contract', zkAppAddress: this._zkAppAddress },
      'Compiling Mina zkApp circuit'
    );

    const startTime = Date.now();
    try {
      const Contract = await getPaymentChannelContract();
      const result = await Contract.compile();
      this._verificationKey = result?.verificationKey ?? null;

      // USDC channels: the `UsdcChannelToken` owner authorizes escrow moves with
      // its OWN proof (depositToChannel / settleFromChannel / enableChannelEscrow),
      // so its circuit must be compiled before any deposit/settle/escrow tx can be
      // proven. Native-MINA channels skip this.
      if (this.isUsdcToken) {
        const UsdcChannelToken = await getUsdcChannelTokenContract();
        await UsdcChannelToken.compile();
      }

      this._compiled = true;

      const durationMs = Date.now() - startTime;
      this._logger.info(
        { event: 'compile_contract_complete', zkAppAddress: this._zkAppAddress, durationMs },
        `Mina zkApp circuit compiled in ${durationMs}ms`
      );
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.COMPILE_FAILED, 'COMPILE_FAILED');
    }
  }

  /**
   * Open a new payment channel.
   *
   * Generates a new zkApp key pair, deploys the PaymentChannel contract,
   * and calls initializeChannel with the provided parameters.
   *
   * @param participantA - Base58 public key of participant A
   * @param participantB - Base58 public key of participant B
   * @param timeout - Settlement timeout in slots
   * @param tokenId - Optional token ID string (defaults to '1')
   * @returns The new zkApp address and transaction hash
   */
  async openChannel(
    participantA: string,
    participantB: string,
    timeout: number,
    tokenId?: string
  ): Promise<MinaOpenChannelResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, PublicKey, Field, AccountUpdate, fetchAccount } = await getO1js();
      const Contract = await getPaymentChannelContract();
      const Mina = await this._setNetwork();

      // Generate a new key pair for the zkApp
      const zkAppPrivateKey = PrivateKey.random();
      const zkAppPublicKey = zkAppPrivateKey.toPublicKey();
      const zkAppAddress = zkAppPublicKey.toBase58();

      // Get signer keys
      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      // Fetch the sender account
      await fetchAccount({ publicKey: signerPublicKey });

      // Create the zkApp instance
      const zkApp = new Contract(zkAppPublicKey);

      // Convert parameters
      const pubA = PublicKey.fromBase58(participantA);
      const pubB = PublicKey.fromBase58(participantB);
      const nonce = Field(0);
      const timeoutField = Field(timeout);

      // Resolve the channel's tokenId. For USDC channels (#192) this is the real
      // `token.deriveTokenId()` of the configured token-owner — NOT a placeholder
      // — so the channel's `tokenId_` matches the token the deposit/settle
      // transfers move and the tokenId inbound claims must carry. A
      // configured/derived mismatch is caught inside `_getTokenContext`. Legacy
      // native-MINA channels keep the `tokenId ?? '1'` behaviour.
      let resolvedTokenId: string;
      if (this.isUsdcToken) {
        const ctx = await this._getTokenContext();
        resolvedTokenId = ctx.tokenId;
        // Fail loud on a decimals misconfig before opening a USDC channel.
        await this._assertTokenDecimals();
      } else {
        resolvedTokenId = tokenId ?? '1';
      }
      const tokenIdField = Field(resolvedTokenId);

      // Deploy and initialize MUST be separate transactions (Issue #128).
      // `initializeChannel` opens with `this.channelState.getAndRequireEquals()`,
      // a precondition on the zkApp's on-chain state. The zkApp account is
      // created by the deploy AccountUpdate, so if both run in one transaction
      // the account does not exist on-chain when o1js tries to satisfy that
      // precondition (its second, `fetchMode: 'cached'` pass), and proving
      // fails with "Could not find account". We therefore (1) deploy, (2) wait
      // until the account is observable, then (3) initialize in a second tx.
      // The contract uses the default `SmartContract.init()`, which sets all
      // state to 0 (= UNINITIALIZED) on deploy, so step 3's precondition holds.

      // 1. Deploy the zkApp.
      const deployTxn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        AccountUpdate.fundNewAccount(signerPublicKey);
        await zkApp.deploy();
      });
      await deployTxn.prove();
      const deployTx = await deployTxn.sign([signerPrivateKey, zkAppPrivateKey]).send();
      const deployTxHash = deployTx.hash ?? '';

      this._logger.info(
        { event: 'open_channel_deployed', zkAppAddress, txHash: deployTxHash },
        'Mina payment channel zkApp deployed; awaiting account before initialize'
      );

      // 2. Wait for the deployed account to be observable on-chain.
      await this._waitForAccount(zkAppAddress);

      // 3. Initialize the channel in a separate transaction.
      await fetchAccount({ publicKey: signerPublicKey });
      const initTxn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        await zkApp.initializeChannel(pubA, pubB, nonce, timeoutField, tokenIdField);
      });
      await initTxn.prove();
      const initTx = await initTxn.sign([signerPrivateKey]).send();
      const txHash = initTx.hash ?? '';

      // Cache participant keys
      this._participantCache.set(zkAppAddress, { participantA, participantB });

      // Retain the channel (zkApp) private key so this SDK instance can later
      // sign the ONE-TIME `enableChannelEscrow` setup tx (making the escrow token
      // account custodial requires the escrow/channel account's signature). After
      // that one-time setup, settle needs NO channel key — the escrow payouts are
      // authorized by the `UsdcChannelToken` owner's proof alone.
      this._channelKeyCache.set(zkAppAddress, zkAppPrivateKey.toBase58());

      this._logger.info(
        { event: 'open_channel', zkAppAddress, deployTxHash, txHash },
        'Mina payment channel opened'
      );

      return { zkAppAddress, txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * One-time: make a channel's escrow USDC token account CUSTODIAL via the
   * in-proof token owner.
   *
   * Composes `token.enableChannelEscrow(channelAddress)`, which sets the channel's
   * token account permissions to `send: none` + `setPermissions: impossible` so
   * the `UsdcChannelToken` owner's PROOF can later author settle payouts out of it
   * with NO escrow/channel signature. Setting permissions on the (fresh) escrow
   * account requires the escrow/channel account's SIGNATURE, so the CHANNEL KEY
   * must sign THIS tx — the only place in the deposit/settle lifecycle a channel
   * key is needed. Pays the escrow token account's new-account fee.
   *
   * Idempotent per SDK instance: tracked in {@link _escrowEnabled}, so a repeat
   * call is a no-op. Run once per channel at open / first deposit; {@link deposit}
   * calls it automatically on the channel's first deposit.
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param channelPrivateKey - base58 channel/zkApp key to sign the setup, for
   *   channels not opened by this SDK instance. Defaults to the key cached at
   *   {@link openChannel}.
   * @returns Transaction hash (or an empty hash if already enabled)
   */
  async enableChannelEscrow(
    channelAddress: string,
    channelPrivateKey?: string
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    if (this._escrowEnabled.has(channelAddress)) {
      return { txHash: '' };
    }

    try {
      const { PrivateKey, PublicKey, AccountUpdate, fetchAccount } = await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      await fetchAccount({ publicKey: signerPublicKey });

      // Resolve the token context + channel key BEFORE building the tx so config
      // errors fail fast.
      await this._assertTokenDecimals();
      const { token } = await this._getTokenContext();

      const channelKeyBase58 = channelPrivateKey ?? this._channelKeyCache.get(channelAddress);
      if (!channelKeyBase58) {
        throw new MinaChannelError(
          `Cannot enable the escrow for channel ${channelAddress}: the channel/zkApp private key ` +
            'is required to sign the one-time escrow-permission setup but is not available. The ' +
            'channel must have been opened by this SDK instance, or channelPrivateKey must be supplied.',
          MINA_ERROR_CODES.INVALID_PARAMETERS,
          'INVALID_PARAMETERS'
        );
      }
      const channelKey = PrivateKey.fromBase58(channelKeyBase58);
      const channelPublicKey = PublicKey.fromBase58(channelAddress);

      const txn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        // The escrow token account is created here; pay its new-account fee.
        AccountUpdate.fundNewAccount(signerPublicKey, 1);
        await token.enableChannelEscrow(channelPublicKey);
      });
      await txn.prove();
      // Fee payer + channel key (authorizes the escrow account permission change).
      const sentTx = await txn.sign([signerPrivateKey, channelKey]).send();
      const txHash = sentTx.hash ?? '';

      this._escrowEnabled.add(channelAddress);

      this._logger.info(
        { event: 'enable_channel_escrow', channelAddress, txHash },
        'Mina channel escrow token account made custodial (one-time)'
      );

      return { txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * Deposit funds into a channel.
   *
   * In-proof enforcement: for USDC channels the channel zkApp is accounting-only,
   * so the USDC custody move is composed via the token owner's in-proof
   * `depositToChannel(channelAddress, amount, depositor, expectedDepositTotalAfter)`
   * — bound in the SAME proof to the channel being OPEN and to the channel's
   * resulting `depositTotal`. The reference tx ORDER is critical: the channel's
   * accounting `channel.deposit(amount, depositor)` AU is added FIRST, then
   * `token.depositToChannel(...)`, because o1js evaluates the token method's
   * post-deposit `depositTotal` precondition against the ledger state as updates
   * apply IN ORDER. `expectedDepositTotalAfter` = the channel's CURRENT on-chain
   * `depositTotal + amount`. The depositor (this SDK's signer) signs, authorizing
   * both the USDC outflow and the channel's depositor-binding AU.
   *
   * On the channel's first-ever deposit the escrow token account must first be
   * made custodial; this auto-runs {@link enableChannelEscrow} (which itself pays
   * the escrow account's new-account fee and is a no-op if already enabled).
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param amount - Amount to deposit (bigint)
   * @param fundChannelTokenAccount - Whether the escrow token account still needs
   *   to be created (true on the channel's first-ever deposit). When true, this
   *   ensures the one-time `enableChannelEscrow` setup has run first. Ignored for
   *   legacy native-MINA channels. Defaults to `true`.
   * @returns Transaction hash
   */
  async deposit(
    channelAddress: string,
    amount: bigint,
    fundChannelTokenAccount = true
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, PublicKey, Field, UInt64, fetchAccount } = await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      // Resolve the USDC token-owner context (if any) once, outside the tx
      // builder, so config/derivation errors surface before tx construction.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let token: any = null;
      if (this.isUsdcToken) {
        await this._assertTokenDecimals();
        ({ token } = await this._getTokenContext());

        // The escrow token account must be custodial before any deposit. On the
        // first deposit (or whenever not yet enabled this instance), run the
        // one-time setup in its OWN tx — it needs the channel key's signature,
        // which a deposit tx (depositor-signed only) cannot carry. This also
        // funds the escrow token account, so the deposit tx funds nothing.
        if (fundChannelTokenAccount || !this._escrowEnabled.has(channelAddress)) {
          await this.enableChannelEscrow(channelAddress);
        }
      }

      await fetchAccount({ publicKey: signerPublicKey });

      const zkApp = await this._getZkApp(channelAddress);
      const amountField = Field(amount);
      const channelPublicKey = PublicKey.fromBase58(channelAddress);

      // For USDC channels the token method pins a precondition on the channel's
      // depositTotal AFTER this deposit. Read the CURRENT on-chain depositTotal
      // (`_getZkApp` just refreshed the account) and add `amount`.
      let expectedDepositTotalAfter: bigint | null = null;
      if (token) {
        const currentDepositTotal = (zkApp.depositTotal.get() as { toBigInt(): bigint }).toBigInt();
        expectedDepositTotalAfter = currentDepositTotal + amount;
      }

      const txn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        // ORDER MATTERS: the channel's accounting `deposit` AU must precede the
        // token's `depositToChannel` AU, whose post-deposit `depositTotal`
        // precondition is evaluated against the ledger state as updates apply in
        // order. This pins the ESCROWED amount to the ACCOUNTED total in-proof.
        await zkApp.deposit(amountField, signerPublicKey);
        if (token) {
          await token.depositToChannel(
            channelPublicKey,
            UInt64.Unsafe.fromField(amountField),
            signerPublicKey,
            Field(expectedDepositTotalAfter as bigint)
          );
        }
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        {
          event: 'deposit',
          channelAddress,
          amount: amount.toString(),
          usdc: this.isUsdcToken,
          txHash,
        },
        'Deposited into Mina payment channel'
      );

      return { txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * Submit a claim with a balance proof to update the channel's balance commitment.
   *
   * Generates a zk-SNARK proof during `txn.prove()` (async, 30-120s).
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param newBalanceA - New balance for participant A
   * @param newBalanceB - New balance for participant B
   * @param salt - Salt for the Poseidon commitment
   * @param nonce - New channel nonce (must be greater than current)
   * @param signatureA - Serialized signature from participant A (JSON with r/s fields)
   * @param signatureB - Serialized signature from participant B (JSON with r/s fields)
   * @param participantKeys - Optional explicit participant pubkeys (base58) for
   *   channels not opened by this SDK instance (inbound/externally-opened, Issue
   *   #114, Bug A). Order is irrelevant -- the SDK assigns A/B to match the
   *   on-chain `channelHash`. When omitted, keys are read from `_participantCache`.
   * @returns Transaction hash
   */
  async claimFromChannel(
    channelAddress: string,
    newBalanceA: bigint,
    newBalanceB: bigint,
    salt: bigint,
    nonce: bigint,
    signatureA: string,
    signatureB: string,
    participantKeys?: { participant1: string; participant2: string }
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, PublicKey, Field, Poseidon, fetchAccount } = await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      await fetchAccount({ publicKey: signerPublicKey });

      const zkApp = await this._getZkApp(channelAddress);

      // Convert parameters to o1js types
      const balA = Field(newBalanceA);
      const balB = Field(newBalanceB);
      const saltField = Field(salt);
      const newNonce = Field(nonce);

      // Compute Poseidon commitment
      const newBalanceCommitment = Poseidon.hash([balA, balB, saltField]);

      // Deserialize and validate signatures
      const sigA = this._deserializeSignature(signatureA, 'signatureA');
      const sigB = this._deserializeSignature(signatureB, 'signatureB');

      // Read channelHash nonce (used Field(0) when opening)
      const channelNonce = Field(0);

      // Resolve participant keys. Channels opened by this SDK instance are in the
      // cache; inbound/externally-opened channels supply keys explicitly (Issue
      // #114, Bug A). For explicit keys we don't know the A/B assignment, so we
      // order them to reproduce the on-chain `channelHash` =
      // Poseidon(participantA.x, participantB.x, channelNonce).
      let participantA: ReturnType<typeof PublicKey.fromBase58>;
      let participantB: ReturnType<typeof PublicKey.fromBase58>;
      const cached = this._participantCache.get(channelAddress);
      if (cached) {
        participantA = PublicKey.fromBase58(cached.participantA);
        participantB = PublicKey.fromBase58(cached.participantB);
      } else if (participantKeys) {
        const key1 = PublicKey.fromBase58(participantKeys.participant1);
        const key2 = PublicKey.fromBase58(participantKeys.participant2);
        const onChainChannelHash = await this._resolveChannelHash(channelAddress);
        const hash12 = Poseidon.hash([key1.x, key2.x, channelNonce]).toString();
        const hash21 = Poseidon.hash([key2.x, key1.x, channelNonce]).toString();
        if (hash12 === onChainChannelHash) {
          participantA = key1;
          participantB = key2;
        } else if (hash21 === onChainChannelHash) {
          participantA = key2;
          participantB = key1;
        } else {
          throw new MinaChannelError(
            `Supplied participant keys do not match the on-chain channelHash for ${channelAddress}. ` +
              'Neither ordering of the provided pubkeys reproduces the stored channel identity.',
            MINA_ERROR_CODES.INVALID_PARAMETERS,
            'INVALID_PARAMETERS'
          );
        }
      } else {
        throw new MinaChannelError(
          'Participant keys not found in cache and none were supplied. The channel must have been ' +
            'opened by this SDK instance, or participant pubkeys must be passed for inbound channels.',
          MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
          'ACCOUNT_NOT_FOUND'
        );
      }

      // Bind the proof's `depositTotal` precondition to the *current* on-chain
      // value (Issue #126). The on-chain `claimFromChannel` asserts
      // `newBalanceA + newBalanceB == depositTotal` via
      // `this.depositTotal.getAndRequireEquals()`. That precondition is
      // satisfied from o1js's account cache, so a deposit that landed after the
      // channel was opened (e.g. the client deposits at open time, before this
      // connector ever claims) must be reflected in the cache or the circuit
      // binds a stale `depositTotal` (observed as `0`) and proof generation
      // fails with "balance conservation invariant" *before* the transaction is
      // ever submitted. `_getZkApp()` re-fetched the account immediately above,
      // so reading `depositTotal` here both (a) confirms the cache is fresh and
      // (b) lets us fail fast with an actionable error instead of a cryptic
      // in-circuit `Field.assertEquals()` failure.
      const onChainDeposit = (zkApp.depositTotal.get() as { toBigInt(): bigint }).toBigInt();
      if (newBalanceA + newBalanceB !== onChainDeposit) {
        throw new MinaChannelError(
          `Claim violates balance conservation for ${channelAddress}: ` +
            `newBalanceA (${newBalanceA.toString()}) + newBalanceB (${newBalanceB.toString()}) = ` +
            `${(newBalanceA + newBalanceB).toString()} but the on-chain depositTotal is ` +
            `${onChainDeposit.toString()}. The balances in the signed claim must sum to the ` +
            'channel deposit (Issue #126).',
          MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
          'PROOF_GENERATION_FAILED'
        );
      }

      const txn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        await zkApp.claimFromChannel(
          balA,
          balB,
          saltField,
          sigA,
          sigB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce
        );
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        { event: 'claim_from_channel', channelAddress, nonce: nonce.toString(), txHash },
        'Claim submitted to Mina payment channel'
      );

      return { txHash };
    } catch (err: unknown) {
      if (err instanceof MinaChannelError) throw err;
      throw this._wrapError(
        err,
        MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
        'PROOF_GENERATION_FAILED'
      );
    }
  }

  /**
   * Initiate channel closure with final balance commitment.
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param finalBalanceA - Final balance for participant A
   * @param finalBalanceB - Final balance for participant B
   * @param salt - Salt for the Poseidon commitment
   * @param nonce - Close nonce
   * @param signatureA - Serialized signature from participant A (JSON with r/s fields)
   * @param signatureB - Serialized signature from participant B (JSON with r/s fields)
   * @returns Transaction hash
   */
  async closeChannel(
    channelAddress: string,
    finalBalanceA: bigint,
    finalBalanceB: bigint,
    salt: bigint,
    nonce: bigint,
    signatureA: string,
    signatureB: string
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, Field, fetchAccount } = await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      await fetchAccount({ publicKey: signerPublicKey });

      const zkApp = await this._getZkApp(channelAddress);

      const balA = Field(finalBalanceA);
      const balB = Field(finalBalanceB);
      const saltField = Field(salt);
      const nonceField = Field(nonce);

      // Deserialize and validate signatures
      const sigA = this._deserializeSignature(signatureA, 'signatureA');
      const sigB = this._deserializeSignature(signatureB, 'signatureB');

      // #202: read the LIVE network global slot off-chain and pass it as the
      // `initiateClose` `currentSlot` witness. The contract pins it with a range
      // precondition (`globalSlotSinceGenesis ∈ [currentSlot, currentSlot+SLOT_WINDOW]`),
      // so it must be genuinely current. The previous design read the exact
      // on-chain slot inside the proof, which is unsatisfiable on a real chain
      // (the slot advances between prove and inclusion →
      // `Protocol_state_precondition_unsatisfied`). `_setNetwork()` already bound
      // the active instance to the configured GraphQL endpoint, so the network
      // state reflects the live chain.
      const currentSlot = await this._currentGlobalSlot();

      const txn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        await zkApp.initiateClose(balA, balB, saltField, nonceField, sigA, sigB, currentSlot);
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        { event: 'close_channel', channelAddress, txHash },
        'Mina payment channel close initiated'
      );

      return { txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * Settle a closed channel after the challenge period.
   *
   * In-proof enforcement: for USDC channels the escrow payouts are composed via
   * the token owner's in-proof `settleFromChannel(channelAddress, balanceA,
   * balanceB, salt, A, B, nonce, closedAtSlot, settlementTimeout)`, run in the
   * SAME tx as `channel.settle(balanceA, balanceB, salt, A, B, nonce)`. The token
   * method binds the payouts to the channel's on-chain pre-settle commitment
   * (`balanceCommitment`, `depositTotal`, `channelState == CLOSING`, `channelHash`,
   * and the elapsed challenge period) via account preconditions, so the LEDGER
   * rejects any mismatch — the payouts are FORCED equal to the committed balances
   * by the proof, and zero-amount payouts are skipped inside the contract.
   *
   * SIGNERS = fee payer ONLY. Unlike the merged #191/#192 design, NO channel/escrow
   * signature is needed for settle: the escrow moves are authorized purely by the
   * `UsdcChannelToken` owner's proof plus the escrow's custodial `send: none`
   * permission (set once at first deposit via `enableChannelEscrow`).
   *
   * The witnesses `closedAtSlot` / `settlementTimeout` are read off-chain from the
   * channel account and passed in; the token method pins them with slot
   * preconditions, so a wrong witness is rejected (the deadline cannot be forged).
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param balanceA - Revealed balance for participant A
   * @param balanceB - Revealed balance for participant B
   * @param salt - Salt used in the balance commitment
   * @param participantA - Base58 public key of participant A
   * @param participantB - Base58 public key of participant B
   * @param nonce - Channel nonce (used in channelHash)
   * @param options - USDC distribution tuning. `fundParticipantTokenAccounts` is
   *   the number of new participant USDC token accounts (0, 1, or 2) whose
   *   creation fee this tx pays — pass the count of NON-zero payouts whose
   *   recipient does not yet hold the token.
   * @returns Transaction hash
   */
  async settleChannel(
    channelAddress: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint,
    participantA: string,
    participantB: string,
    nonce: bigint,
    options?: { fundParticipantTokenAccounts?: number }
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, PublicKey, Field, UInt32, UInt64, AccountUpdate, fetchAccount } =
        await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      await fetchAccount({ publicKey: signerPublicKey });

      const zkApp = await this._getZkApp(channelAddress);

      const balA = Field(balanceA);
      const balB = Field(balanceB);
      const saltField = Field(salt);
      const pubA = PublicKey.fromBase58(participantA);
      const pubB = PublicKey.fromBase58(participantB);
      const channelPublicKey = PublicKey.fromBase58(channelAddress);
      const nonceField = Field(nonce);

      // Resolve the USDC token-owner context (if any) BEFORE building the tx so
      // config errors fail fast. The token method also needs the channel's
      // on-chain closedAtSlot / settlementTimeout as witnesses (it pins them with
      // preconditions, so a wrong value is rejected and the deadline can't be
      // forged). `_getZkApp` just refreshed the channel account.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let token: any = null;
      let closedAtSlot = 0n;
      let settlementTimeout = 0n;
      if (this.isUsdcToken) {
        await this._assertTokenDecimals();
        ({ token } = await this._getTokenContext());
        closedAtSlot = (zkApp.closedAtSlot.get() as { toBigInt(): bigint }).toBigInt();
        settlementTimeout = (zkApp.settlementTimeout.get() as { toBigInt(): bigint }).toBigInt();
      }

      const fundCount = options?.fundParticipantTokenAccounts ?? 0;

      const txn = await Mina.transaction(this._feePayer(signerPublicKey), async () => {
        if (token) {
          if (fundCount > 0) {
            AccountUpdate.fundNewAccount(signerPublicKey, fundCount);
          }
          // In-proof escrow payouts: bound to the channel's pre-settle commitment.
          // Reference composition (test-helpers `settleFromChannelInProof`): the
          // token method is added BEFORE `channel.settle`. The contract forces the
          // payouts == committed balances and skips zero amounts internally.
          await token.settleFromChannel(
            channelPublicKey,
            UInt64.Unsafe.fromField(balA),
            UInt64.Unsafe.fromField(balB),
            saltField,
            pubA,
            pubB,
            nonceField,
            UInt32.from(closedAtSlot),
            UInt32.from(settlementTimeout)
          );
        }
        await zkApp.settle(balA, balB, saltField, pubA, pubB, nonceField);
      });
      await txn.prove();

      // Signers = fee payer ONLY. No channel/escrow key — the escrow moves are
      // authorized by the token owner's proof + the custodial `send: none`
      // permission. (The merged #191/#192 channel-key settle signature is gone.)
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        { event: 'settle_channel', channelAddress, usdc: this.isUsdcToken, txHash },
        'Mina payment channel settled'
      );

      return { txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * Query the current on-chain state of a channel.
   *
   * Reads all 8 on-chain state fields from the zkApp and converts them
   * to TypeScript-friendly types.
   *
   * @remarks
   * `participantA` and `participantB` are NOT stored on-chain -- only their
   * Poseidon hash (`channelHash`) is. The SDK returns participant keys from
   * an internal cache if the channel was opened by this SDK instance.
   * Otherwise, empty strings are returned. Callers (e.g., the provider) must
   * track participant keys separately.
   *
   * TODO: Implement event-based participant key resolution from archive node.
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @returns MinaChannelState with all fields populated
   */
  async getChannelState(channelAddress: string): Promise<MinaChannelState> {
    try {
      const { PublicKey, fetchAccount } = await getO1js();
      const Contract = await getPaymentChannelContract();

      // Bind the active Mina instance to the configured GraphQL endpoint before
      // reading on-chain state. Without this, `<field>.get()` reads against an
      // empty active-instance ledger and throws "can't find this zkapp account"
      // (Issue #95). getChannelState is the first Mina operation on the claim
      // verification path, so no prior settle call has bound the network yet.
      await this._setNetwork();

      const zkAppPublicKey = PublicKey.fromBase58(channelAddress);

      const result = await fetchAccount({ publicKey: zkAppPublicKey });
      if (result.error) {
        throw new MinaChannelError(
          `Failed to fetch account at ${channelAddress}: ${String(result.error)}`,
          MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
          'ACCOUNT_NOT_FOUND'
        );
      }

      const zkApp = new Contract(zkAppPublicKey);

      // Read all 8 on-chain state fields
      const channelHash = zkApp.channelHash.get();
      const balanceCommitment = zkApp.balanceCommitment.get();
      const nonceField = zkApp.nonceField.get();
      const channelState = zkApp.channelState.get();
      const depositTotal = zkApp.depositTotal.get();
      const closedAtSlot = zkApp.closedAtSlot.get();
      const settlementTimeout = zkApp.settlementTimeout.get();
      const tokenIdField = zkApp.tokenId_.get();

      // Resolve participant keys from cache if available
      const cached = this._participantCache.get(channelAddress);

      return {
        participantA: cached?.participantA ?? '',
        participantB: cached?.participantB ?? '',
        channelState: Number(channelState.toBigInt()),
        depositTotal: depositTotal.toBigInt(),
        balanceCommitment: balanceCommitment.toString(),
        nonceField: nonceField.toBigInt(),
        closedAtSlot: closedAtSlot.toBigInt(),
        settlementTimeout: settlementTimeout.toBigInt(),
        tokenId: tokenIdField.toString(),
        channelHash: channelHash.toString(),
      };
    } catch (err: unknown) {
      if (err instanceof MinaChannelError) throw err;
      throw this._wrapError(err, MINA_ERROR_CODES.ACCOUNT_NOT_FOUND, 'ACCOUNT_NOT_FOUND');
    }
  }

  /**
   * Get channel events from the archive node.
   *
   * Queries the Mina GraphQL endpoint for zkApp actions/events related
   * to the given channel address.
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @returns Events in chronological order as typed event objects
   */
  async getChannelEvents(
    channelAddress: string
  ): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
    try {
      const zkApp = await this._getZkApp(channelAddress);

      // Attempt to fetch events via the zkApp's fetchEvents method
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let events: any[] = [];
      if (typeof zkApp.fetchEvents === 'function') {
        events = await zkApp.fetchEvents();
      }

      // Map events to the typed format
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return events.map((event: any) => ({
        type: String(event.type ?? 'unknown'),
        data: (event.event?.data ?? event.data ?? {}) as Record<string, unknown>,
      }));
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.ARCHIVE_NODE_ERROR, 'ARCHIVE_NODE_ERROR');
    }
  }

  /**
   * Sign a balance proof using Poseidon commitment.
   *
   * Computes `Poseidon.hash([balanceA, balanceB, salt])` and signs the
   * commitment with the SDK's private key. The channel address is included
   * in the signing context via Poseidon hash to bind the proof to a specific channel.
   *
   * @param channelAddress - zkApp address (used for channel binding in signing context)
   * @param balanceA - Balance for participant A
   * @param balanceB - Balance for participant B
   * @param salt - Salt for the commitment
   * @param nonce - Channel nonce
   * @returns Serialized JSON string: `{ commitment, signature: { r, s }, nonce }`
   * @throws {MinaChannelError} code 1008 if no signer key is configured
   */
  async signBalanceProof(
    channelAddress: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint,
    nonce: bigint
  ): Promise<string> {
    if (!this._signerPrivateKey) {
      throw new MinaChannelError(
        'signer private key required for signBalanceProof',
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }

    try {
      const { PrivateKey, Field, Poseidon, Signature } = await getO1js();

      // Compute Poseidon commitment
      const commitment = Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)]);

      // Bind the proof to the on-chain `channelHash` — the same channel-identity
      // field the on-chain `claimFromChannel` method signs over (Issue #114, Bug
      // B). This makes the off-chain signature directly forwardable into the
      // on-chain method instead of using a separate `Poseidon([zkApp.x])` digest
      // that the contract rejects.
      const channelHashField = Field(await this._resolveChannelHash(channelAddress));

      // Sign [commitment, nonce, channelHash]
      const privateKey = PrivateKey.fromBase58(this._signerPrivateKey);
      const signature = Signature.create(privateKey, [commitment, Field(nonce), channelHashField]);

      const sigJson = signature.toJSON();

      // Embed the signer's public key so the peer side can verify the signature
      // against the correct key instead of falling back to its own signer key
      // (the two parties hold different keys). Mirrors the Solana claim, which
      // carries `signerPublicKey`.
      const signerPublicKey = privateKey.toPublicKey().toBase58();

      return JSON.stringify({
        commitment: commitment.toString(),
        signature: { r: sigJson.r, s: sigJson.s },
        nonce: nonce.toString(),
        signerPublicKey,
      });
    } catch (err: unknown) {
      if (err instanceof MinaChannelError) throw err;
      throw this._wrapError(
        err,
        MINA_ERROR_CODES.PROOF_GENERATION_FAILED,
        'PROOF_GENERATION_FAILED'
      );
    }
  }

  /**
   * Verify a balance proof / zk-SNARK proof.
   *
   * Deserializes the proof string and verifies the signature against the
   * commitment. Optionally enforces internal consistency (the proof's embedded
   * commitment/nonce match the values declared alongside it) and that the claim
   * *advances* past the current on-chain nonce.
   *
   * Issue #118 — verify-vs-advance contradiction: previously this method
   * required the proof's commitment to **equal** the current on-chain
   * commitment (the provider sourced `balanceCommitment` from on-chain state).
   * That is contradictory with the on-chain `claimFromChannel`, which asserts
   * `newNonce > currentNonce` and is *designed to advance* state:
   *   - A claim representing a NEW balance has a NEW commitment, so the equality
   *     check rejected it and settlement never even attempted.
   *   - A claim whose commitment matched on-chain necessarily carried a
   *     non-advancing nonce, so the on-chain tx reverted as a replay/no-op.
   * Either way the on-chain settle could never progress through a normal claim
   * sequence. We now mirror the on-chain semantics off-chain: accept claims that
   * ADVANCE past the current on-chain nonce (via `onChainNonce`) rather than
   * requiring commitment equality. The signature still cryptographically binds
   * the commitment, and the on-chain `claimFromChannel` remains the authoritative
   * check (dual-party signatures, conservation, monotonic nonce).
   *
   * @param channelAddress - zkApp address (used for channel binding in verification)
   * @param balanceCommitment - Optional commitment to assert the proof's embedded
   *   commitment against (internal consistency). Pass an empty string to skip —
   *   the Mina provider does, because the on-chain commitment is a Poseidon hash
   *   that an *advancing* claim is expected to differ from (Issue #118).
   * @param proof - Serialized proof string (from signBalanceProof)
   * @param nonce - Expected nonce (must match the nonce embedded in the proof)
   * @param channelHash - Optional on-chain channelHash (decimal Field string). When
   *   supplied (the provider already reads it via `getChannelState`), the proof is
   *   verified against the canonical `channelHash`-bound message (Issue #114, Bug
   *   B). The legacy `Poseidon([zkApp.x])` message is also accepted as a fallback
   *   during the wire-format rollout.
   * @param onChainNonce - Optional current on-chain nonce. When supplied, the
   *   proof's nonce must be strictly greater (it must advance past on-chain state,
   *   mirroring the on-chain `claimFromChannel` assertion). Omit to skip the
   *   advance check (Issue #118).
   * @returns `true` if the proof is valid, `false` otherwise
   */
  async verifyBalanceProof(
    channelAddress: string,
    balanceCommitment: string,
    proof: string,
    nonce: bigint,
    channelHash?: string,
    onChainNonce?: bigint
  ): Promise<boolean> {
    try {
      const { Field, Poseidon, Signature, PublicKey, PrivateKey } = await getO1js();

      // Deserialize and validate the proof structure
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let proofData: any;
      try {
        // The canonical wire encoding is base64(JSON) (Issue #90); decode it
        // before parsing. Raw-JSON proofs are still accepted for backward
        // compatibility (see _normalizeSerializedProof).
        proofData = JSON.parse(this._normalizeSerializedProof(proof));
      } catch {
        this._logger.warn(
          { event: 'verify_balance_proof_parse_error', channelAddress },
          'Balance proof is not valid JSON'
        );
        return false;
      }

      if (
        typeof proofData !== 'object' ||
        proofData === null ||
        typeof proofData.commitment !== 'string' ||
        typeof proofData.nonce !== 'string' ||
        typeof proofData.signature !== 'object' ||
        proofData.signature === null ||
        typeof proofData.signature.r !== 'string' ||
        typeof proofData.signature.s !== 'string'
      ) {
        this._logger.warn(
          { event: 'verify_balance_proof_invalid_structure', channelAddress },
          'Balance proof has invalid structure: expected { commitment, signature: { r, s }, nonce }'
        );
        return false;
      }

      // Validate that the proof's commitment matches the expected on-chain commitment
      if (balanceCommitment && proofData.commitment !== balanceCommitment) {
        this._logger.warn(
          {
            event: 'verify_balance_proof_commitment_mismatch',
            channelAddress,
            expected: balanceCommitment,
            actual: proofData.commitment,
          },
          'Balance proof commitment does not match expected on-chain commitment'
        );
        return false;
      }

      // Validate that the proof's nonce matches the expected nonce
      if (BigInt(proofData.nonce) !== nonce) {
        this._logger.warn(
          {
            event: 'verify_balance_proof_nonce_mismatch',
            channelAddress,
            expected: nonce.toString(),
            actual: proofData.nonce,
          },
          'Balance proof nonce does not match expected nonce'
        );
        return false;
      }

      // Issue #118: a claim can only settle on-chain if it ADVANCES past the
      // current on-chain nonce — `claimFromChannel` asserts `newNonce >
      // currentNonce`. Mirror that here so a claim that verifies off-chain can
      // actually be submitted on-chain. A claim at or below the on-chain nonce
      // is stale (already settled / a replay) and is rejected. When the caller
      // does not supply `onChainNonce` the advance check is skipped.
      if (onChainNonce !== undefined && BigInt(proofData.nonce) <= onChainNonce) {
        this._logger.warn(
          {
            event: 'verify_balance_proof_stale_nonce',
            channelAddress,
            onChainNonce: onChainNonce.toString(),
            proofNonce: proofData.nonce,
          },
          'Balance proof nonce does not advance past the current on-chain nonce'
        );
        return false;
      }

      // Reconstruct the commitment field
      const commitment = Field(proofData.commitment);
      const nonceField = Field(proofData.nonce);

      // Build the candidate signed messages. The canonical message binds the
      // on-chain `channelHash` (Issue #114, Bug B) — the same field the on-chain
      // `claimFromChannel` method signs over. The legacy message binds
      // `Poseidon([zkApp.x])` and is still accepted during the wire-format
      // rollout so pre-#114 signers interoperate.
      const messages: Array<ReturnType<typeof Field>[]> = [];

      // Canonical: prefer the supplied channelHash, else read it on-chain.
      let resolvedChannelHash = channelHash;
      if (resolvedChannelHash === undefined) {
        try {
          resolvedChannelHash = await this._resolveChannelHash(channelAddress);
        } catch (hashErr: unknown) {
          this._logger.debug(
            {
              event: 'verify_balance_proof_channelhash_unavailable',
              channelAddress,
              error: hashErr instanceof Error ? hashErr.message : String(hashErr),
            },
            'Could not resolve on-chain channelHash; verifying against legacy message only'
          );
        }
      }
      if (resolvedChannelHash !== undefined) {
        messages.push([commitment, nonceField, Field(resolvedChannelHash)]);
      }

      // Legacy fallback: Poseidon([zkApp.x]).
      const channelPubKey = PublicKey.fromBase58(channelAddress);
      messages.push([commitment, nonceField, Poseidon.hash([channelPubKey.x])]);

      // Reconstruct the signature
      const signature = Signature.fromJSON({
        r: proofData.signature.r,
        s: proofData.signature.s,
      });

      // Resolve the verification public key: prefer the signer pubkey carried in
      // the proof (the counterparty's key for inbound claims), else fall back to
      // this SDK's own signer key.
      let verifyKey: ReturnType<typeof PublicKey.fromBase58> | undefined;
      if (proofData.signerPublicKey) {
        verifyKey = PublicKey.fromBase58(proofData.signerPublicKey);
      } else if (this._signerPrivateKey) {
        verifyKey = PrivateKey.fromBase58(this._signerPrivateKey).toPublicKey();
      }

      if (!verifyKey) {
        this._logger.warn(
          { event: 'verify_balance_proof_no_key', channelAddress },
          'Cannot verify balance proof: no signer key or public key available'
        );
        return false;
      }

      const resolvedKey = verifyKey;
      return messages.some((message) => signature.verify(resolvedKey, message).toBoolean());
    } catch (err: unknown) {
      this._logger.warn(
        {
          event: 'verify_balance_proof_error',
          channelAddress,
          error: err instanceof Error ? err.message : String(err),
        },
        'Balance proof verification failed'
      );
      return false;
    }
  }

  /**
   * Open a claim's plaintext balance preimage against the commitment embedded
   * in its signed proof — the connector-gate half of Option B for issue #359
   * (design toon-meta#168).
   *
   * Recomputes `Poseidon.hash([balanceA, balanceB, salt])` — the SAME hash
   * {@link signBalanceProof} (see the `commitment` computed above) and the
   * on-chain `PaymentChannel.claimFromChannel` use — and compares it to the
   * `commitment` field carried inside the proof. That `commitment` is the exact
   * value the Pallas-Schnorr signature is verified over in
   * {@link verifyBalanceProof} (`signature.verify(key, [commitment, nonce,
   * channelHash])`). So a `'match'` means the plaintext balances are the true
   * preimage of the *signature-bound* commitment: because Poseidon is
   * collision-resistant, a payer cannot present plaintext balances that open to
   * a commitment other than the one they signed. This lets the inbound gate
   * treat `balanceA` (the claim's `transferredAmount`) as trusted plaintext and
   * bind the claim's VALUE to the route PRICE, exactly as #360 does for the
   * EVM/Solana plaintext `transferredAmount`.
   *
   * RPC-FREE and proof-free: this parses only the supplied `proof` string and
   * runs one Poseidon hash. It does NOT verify the signature (that remains
   * {@link verifyBalanceProof}'s job, run by the gate's crypto step) and reads
   * no chain state — so it is safe on the per-packet hot path.
   *
   * @param proof - Serialized proof string (base64(JSON) or raw JSON) carrying
   *   `{ commitment, ... }`, as produced by {@link signBalanceProof}.
   * @param balanceA - Plaintext participant-A cumulative balance (the claim's
   *   `transferredAmount`).
   * @param balanceB - Plaintext participant-B balance (`0` for the
   *   unidirectional per-packet case).
   * @param salt - Plaintext commitment salt (the claim's `salt`).
   * @returns
   *   - `'match'`      the plaintext opens the signed commitment → trust it;
   *   - `'mismatch'`   the plaintext does NOT open it (tampered/malformed
   *                    preimage) → the caller MUST reject;
   *   - `'unopenable'` the proof carries no parseable `commitment` (or o1js is
   *                    unavailable) → the caller's migration policy decides.
   */
  async openBalanceCommitment(
    proof: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint
  ): Promise<'match' | 'mismatch' | 'unopenable'> {
    // Parse the proof first (no o1js needed): extract the commitment the
    // signature is bound over. A proof we cannot parse — or one carrying no
    // commitment — is a structural gap (old/garbled wire), not a value tamper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let proofData: any;
    try {
      proofData = JSON.parse(this._normalizeSerializedProof(proof));
    } catch {
      return 'unopenable';
    }
    if (
      typeof proofData !== 'object' ||
      proofData === null ||
      typeof proofData.commitment !== 'string' ||
      proofData.commitment.length === 0
    ) {
      return 'unopenable';
    }

    let o1js: Awaited<ReturnType<typeof getO1js>>;
    try {
      o1js = await getO1js();
    } catch (err: unknown) {
      // o1js failed to load: an infrastructure fault, not a bad claim. Signal
      // 'unopenable' so the gate can fall back per its migration policy rather
      // than mis-rejecting a possibly-honest claim.
      this._logger.warn(
        {
          event: 'open_balance_commitment_o1js_unavailable',
          error: err instanceof Error ? err.message : String(err),
        },
        'Cannot open balance commitment: o1js unavailable'
      );
      return 'unopenable';
    }

    try {
      const { Field, Poseidon } = o1js;
      const recomputed = Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)]).toString();
      return recomputed === proofData.commitment ? 'match' : 'mismatch';
    } catch {
      // A plaintext value that is not a valid field element (e.g. ≥ the field
      // modulus) can never be the preimage of a legitimately-signed commitment
      // → treat as a mismatch (reject), NOT a fail-open.
      return 'mismatch';
    }
  }

  /**
   * Subscribe to channel state changes via polling.
   *
   * Polls `getChannelState()` at a configurable interval (default 30s).
   * The callback is invoked only when state changes are detected.
   *
   * @param channelAddress - zkApp address to monitor
   * @param callback - Function called with updated state on each change
   * @param pollIntervalMs - Polling interval in milliseconds (default: 30000)
   * @returns Subscription handle with `unsubscribe()` method
   */
  subscribeToChannel(
    channelAddress: string,
    callback: (state: MinaChannelState) => void,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
  ): MinaSubscription {
    let disposed = false;
    let pollInFlight = false;
    let previousState: MinaChannelState | undefined;

    const poll = async (): Promise<void> => {
      if (disposed || pollInFlight) return;
      pollInFlight = true;
      try {
        const currentState = await this.getChannelState(channelAddress);

        if (disposed) return;

        // Compare with previous state to detect changes
        const changed =
          !previousState ||
          previousState.channelState !== currentState.channelState ||
          previousState.nonceField !== currentState.nonceField ||
          previousState.balanceCommitment !== currentState.balanceCommitment ||
          previousState.depositTotal !== currentState.depositTotal;

        if (changed) {
          previousState = currentState;
          callback(currentState);
        }
      } catch (err: unknown) {
        // Resilient to transient network failures -- log but don't propagate
        this._logger.warn(
          {
            event: 'subscription_poll_error',
            channelAddress,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to poll channel state'
        );
      } finally {
        pollInFlight = false;
      }
    };

    // Fire the first poll immediately
    void poll();

    const intervalId = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    return {
      unsubscribe: (): void => {
        disposed = true;
        clearInterval(intervalId);
      },
    };
  }
}
