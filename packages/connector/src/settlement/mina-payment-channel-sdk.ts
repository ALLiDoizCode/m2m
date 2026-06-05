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
      o1jsModule = await import('o1js');
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
      const mod = await import('@toon-protocol/mina-zkapp');
      PaymentChannelContract = mod.PaymentChannel;
    } catch {
      throw new MinaChannelError(
        '@toon-protocol/mina-zkapp is required for Mina payment channels but is not installed.',
        MINA_ERROR_CODES.O1JS_NOT_AVAILABLE,
        'O1JS_NOT_AVAILABLE'
      );
    }
  }
  return PaymentChannelContract;
}

/** Default polling interval for channel subscriptions (30 seconds) */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

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

  constructor(
    graphqlUrl: string,
    private readonly _zkAppAddress: string,
    private readonly _logger: Logger,
    private readonly _signerPrivateKey?: string
  ) {
    this.graphqlUrl = graphqlUrl;
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
   * Create a zkApp instance at the given address.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _getZkApp(channelAddress: string): Promise<any> {
    const { PublicKey, fetchAccount } = await getO1js();
    const Contract = await getPaymentChannelContract();

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
   * @param signatureStr - JSON string with `{ r: string, s: string }` shape
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

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.r !== 'string' ||
      typeof parsed.s !== 'string'
    ) {
      throw new MinaChannelError(
        `Invalid ${fieldName}: expected an object with string 'r' and 's' fields`,
        MINA_ERROR_CODES.INVALID_PARAMETERS,
        'INVALID_PARAMETERS'
      );
    }

    // Import Signature from the cached o1js module (caller must have loaded o1js already)
    const { Signature } = o1jsModule;
    return Signature.fromJSON({ r: parsed.r, s: parsed.s });
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
      const tokenIdField = Field(tokenId ?? '1');

      // Build deploy + initialize transaction
      const txn = await Mina.transaction(signerPublicKey, async () => {
        AccountUpdate.fundNewAccount(signerPublicKey);
        await zkApp.deploy();
        await zkApp.initializeChannel(pubA, pubB, nonce, timeoutField, tokenIdField);
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey, zkAppPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      // Cache participant keys
      this._participantCache.set(zkAppAddress, { participantA, participantB });

      this._logger.info(
        { event: 'open_channel', zkAppAddress, txHash },
        'Mina payment channel opened'
      );

      return { zkAppAddress, txHash };
    } catch (err: unknown) {
      throw this._wrapError(err, MINA_ERROR_CODES.TRANSACTION_FAILED, 'TRANSACTION_FAILED');
    }
  }

  /**
   * Deposit funds into a channel.
   *
   * @param channelAddress - Base58 zkApp address of the channel
   * @param amount - Amount to deposit (bigint)
   * @returns Transaction hash
   */
  async deposit(channelAddress: string, amount: bigint): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, Field, fetchAccount } = await getO1js();
      const Mina = await this._setNetwork();

      const signerPrivateKey = PrivateKey.fromBase58(signerKeyBase58);
      const signerPublicKey = signerPrivateKey.toPublicKey();

      await fetchAccount({ publicKey: signerPublicKey });

      const zkApp = await this._getZkApp(channelAddress);
      const amountField = Field(amount);

      const txn = await Mina.transaction(signerPublicKey, async () => {
        await zkApp.deposit(amountField, signerPublicKey);
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        { event: 'deposit', channelAddress, amount: amount.toString(), txHash },
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
   * @returns Transaction hash
   */
  async claimFromChannel(
    channelAddress: string,
    newBalanceA: bigint,
    newBalanceB: bigint,
    salt: bigint,
    nonce: bigint,
    signatureA: string,
    signatureB: string
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

      // Resolve participant keys -- require them from cache
      const cached = this._participantCache.get(channelAddress);
      if (!cached) {
        throw new MinaChannelError(
          'Participant keys not found in cache. The channel must have been opened by this SDK instance, ' +
            'or participant keys must be provided via openChannel().',
          MINA_ERROR_CODES.ACCOUNT_NOT_FOUND,
          'ACCOUNT_NOT_FOUND'
        );
      }

      const participantA = PublicKey.fromBase58(cached.participantA);
      const participantB = PublicKey.fromBase58(cached.participantB);

      // Read channelHash nonce (used Field(0) when opening)
      const channelNonce = Field(0);

      const txn = await Mina.transaction(signerPublicKey, async () => {
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

      const txn = await Mina.transaction(signerPublicKey, async () => {
        await zkApp.initiateClose(balA, balB, saltField, nonceField, sigA, sigB);
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
   * @param channelAddress - Base58 zkApp address of the channel
   * @param balanceA - Revealed balance for participant A
   * @param balanceB - Revealed balance for participant B
   * @param salt - Salt used in the balance commitment
   * @param participantA - Base58 public key of participant A
   * @param participantB - Base58 public key of participant B
   * @param nonce - Channel nonce (used in channelHash)
   * @returns Transaction hash
   */
  async settleChannel(
    channelAddress: string,
    balanceA: bigint,
    balanceB: bigint,
    salt: bigint,
    participantA: string,
    participantB: string,
    nonce: bigint
  ): Promise<MinaTxResult> {
    const signerKeyBase58 = this._requireSignerKey();

    try {
      const { PrivateKey, PublicKey, Field, fetchAccount } = await getO1js();
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
      const nonceField = Field(nonce);

      const txn = await Mina.transaction(signerPublicKey, async () => {
        await zkApp.settle(balA, balB, saltField, pubA, pubB, nonceField);
      });
      await txn.prove();
      const sentTx = await txn.sign([signerPrivateKey]).send();
      const txHash = sentTx.hash ?? '';

      this._logger.info(
        { event: 'settle_channel', channelAddress, txHash },
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
      const { PrivateKey, PublicKey, Field, Poseidon, Signature } = await getO1js();

      // Compute Poseidon commitment
      const commitment = Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)]);

      // Derive channel hash field for signing context by hashing the channel's
      // public key x-coordinate. This binds the proof to the specific channel
      // address, preventing cross-channel replay attacks.
      const channelPubKey = PublicKey.fromBase58(channelAddress);
      const channelHashField = Poseidon.hash([channelPubKey.x]);

      // Sign [commitment, nonce, channelHashField]
      const privateKey = PrivateKey.fromBase58(this._signerPrivateKey);
      const signature = Signature.create(privateKey, [commitment, Field(nonce), channelHashField]);

      const sigJson = signature.toJSON();

      return JSON.stringify({
        commitment: commitment.toString(),
        signature: { r: sigJson.r, s: sigJson.s },
        nonce: nonce.toString(),
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
   * Deserializes the proof string and verifies the signature against
   * the commitment. Also validates that the proof's commitment matches the
   * expected on-chain commitment and that the proof's nonce matches the
   * expected nonce.
   *
   * @param channelAddress - zkApp address (used for channel binding in verification)
   * @param balanceCommitment - Expected balance commitment string (from on-chain state)
   * @param proof - Serialized proof string (from signBalanceProof)
   * @param nonce - Expected nonce (must match the nonce in the proof)
   * @returns `true` if the proof is valid, `false` otherwise
   */
  async verifyBalanceProof(
    channelAddress: string,
    balanceCommitment: string,
    proof: string,
    nonce: bigint
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

      // Reconstruct the commitment field
      const commitment = Field(proofData.commitment);

      // Derive channel hash field (same derivation as signBalanceProof)
      const channelPubKey = PublicKey.fromBase58(channelAddress);
      const channelHashField = Poseidon.hash([channelPubKey.x]);

      // Reconstruct the message that was signed
      const message = [commitment, Field(proofData.nonce), channelHashField];

      // Reconstruct the signature
      const signature = Signature.fromJSON({
        r: proofData.signature.r,
        s: proofData.signature.s,
      });

      // If signer public key is provided in the proof, use it for verification
      if (proofData.signerPublicKey) {
        const signerPubKey = PublicKey.fromBase58(proofData.signerPublicKey);
        const isValid = signature.verify(signerPubKey, message);
        return isValid.toBoolean();
      }

      // If we have a signer key, derive the public key and verify
      if (this._signerPrivateKey) {
        const privateKey = PrivateKey.fromBase58(this._signerPrivateKey);
        const publicKey = privateKey.toPublicKey();
        const isValid = signature.verify(publicKey, message);
        return isValid.toBoolean();
      }

      // Cannot verify without a public key
      this._logger.warn(
        { event: 'verify_balance_proof_no_key', channelAddress },
        'Cannot verify balance proof: no signer key or public key available'
      );
      return false;
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
