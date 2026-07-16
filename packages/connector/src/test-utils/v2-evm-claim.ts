/**
 * Test helpers for RollingSwapChannel v2 EVM claims (connector#329 Phase 4b).
 *
 * The v2 EIP-712 claim digest — domain `EIP712Domain(name="RollingSwapChannel",
 * version="2", chainId, verifyingContract)`, struct `ClaimBalanceProof(bytes32
 * channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)` — is
 * exactly reproducible with ethers' `signTypedData`, because the leaf's
 * `balanceProofHashEvm` equals OpenZeppelin's `_hashTypedDataV4(...)` for that
 * domain (pinned by the golden vector in `eip712-v2-verifier.test.ts`). So a real,
 * leaf-verifiable v2 signature is minted by signing the typed data with any
 * secp256k1 key — no mocking of the crypto required.
 *
 * @module test-utils/v2-evm-claim
 */

import { ethers } from 'ethers';
import type { EVMClaimMessage } from '../btp/btp-claim-types';

/** Hardhat / Anvil account #0 private key (well-known test key). */
export const ANVIL_0_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** Address for {@link ANVIL_0_PK} (checksum). */
export const ANVIL_0_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** Default v2 settlement domain used by the fixtures below. */
export const V2_CHAIN_ID = 8453; // Base mainnet
export const V2_VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** The v2 EIP-712 domain for a given chainId + verifyingContract. */
export function v2Domain(
  chainId: number = V2_CHAIN_ID,
  verifyingContract: string = V2_VERIFYING_CONTRACT
): ethers.TypedDataDomain {
  return { name: 'RollingSwapChannel', version: '2', chainId, verifyingContract };
}

/** The v2 `ClaimBalanceProof` EIP-712 types. */
export const V2_CLAIM_TYPES = {
  ClaimBalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

/** Fields the v2 balance-proof digest is computed over. */
export interface V2ClaimFields {
  channelId: string;
  cumulativeAmount: string | bigint;
  nonce: number;
  recipient: string;
  chainId?: number;
  verifyingContract?: string;
}

/**
 * Produce a real, leaf-verifiable v2 signature over the given claim fields by
 * signing the RollingSwapChannel EIP-712 typed data with `privateKey`.
 * Returns `{ signature, signerAddress }`.
 */
export async function signV2EvmClaim(
  fields: V2ClaimFields,
  privateKey: string = ANVIL_0_PK
): Promise<{ signature: string; signerAddress: string }> {
  const wallet = new ethers.Wallet(privateKey);
  const domain = v2Domain(
    fields.chainId ?? V2_CHAIN_ID,
    fields.verifyingContract ?? V2_VERIFYING_CONTRACT
  );
  const signature = await wallet.signTypedData(
    domain,
    V2_CLAIM_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
    {
      channelId: fields.channelId,
      cumulativeAmount: BigInt(fields.cumulativeAmount),
      nonce: fields.nonce,
      recipient: fields.recipient,
    }
  );
  return { signature, signerAddress: wallet.address };
}

/**
 * Build a complete, validly-signed v2 EVM claim message. Any field can be
 * overridden; the signature is (re)minted over the effective claim fields with
 * `privateKey`, and `signerAddress` is set to that key's address unless overridden.
 */
export async function makeV2EvmClaim(
  overrides: Partial<EVMClaimMessage> = {},
  privateKey: string = ANVIL_0_PK
): Promise<EVMClaimMessage> {
  const channelId = overrides.channelId ?? '0x' + '11'.repeat(32);
  const cumulativeAmount = overrides.cumulativeAmount ?? '1000000';
  const nonce = overrides.nonce ?? 1;
  const recipient = overrides.recipient ?? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const chainId = overrides.chainId ?? V2_CHAIN_ID;
  const verifyingContract = overrides.verifyingContract ?? V2_VERIFYING_CONTRACT;

  const { signature, signerAddress } = await signV2EvmClaim(
    { channelId, cumulativeAmount, nonce, recipient, chainId, verifyingContract },
    privateKey
  );

  return {
    version: '2.0',
    blockchain: 'evm',
    messageId: overrides.messageId ?? `evm-${channelId.slice(0, 10)}-${nonce}`,
    timestamp: overrides.timestamp ?? '2026-07-16T12:00:00.000Z',
    senderId: overrides.senderId ?? 'peer-test',
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    signature: overrides.signature ?? signature,
    signerAddress: overrides.signerAddress ?? signerAddress,
    chainId,
    verifyingContract,
    ...(overrides.tokenAddress !== undefined ? { tokenAddress: overrides.tokenAddress } : {}),
  };
}
