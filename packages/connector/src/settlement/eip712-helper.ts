/**
 * EIP-712 Helper Utilities for Payment Channel Balance Proofs
 * Source: Epic 8 Story 8.4 - Balance Proof Verification
 */

/**
 * EIP-712 Domain Separator for TokenNetwork contract
 * Source: Epic 8 Story 8.4 EIP-712 Signature Scheme
 *
 * @param chainId - Blockchain chain ID
 * @param verifyingContract - TokenNetwork contract address
 * @returns EIP-712 domain object for typed data signing
 */
export function getDomainSeparator(
  chainId: number | bigint,
  verifyingContract: string
): {
  name: string;
  version: string;
  chainId: number | bigint;
  verifyingContract: string;
} {
  return {
    name: 'TokenNetwork',
    version: '1',
    chainId,
    verifyingContract,
  };
}

/**
 * EIP-712 Type Hash for Balance Proof structure
 * Source: Epic 8 Story 8.4 Balance Proof Type Hash
 *
 * @returns EIP-712 types object for balance proof signing
 */
export function getBalanceProofTypes(): {
  BalanceProof: Array<{ name: string; type: string }>;
} {
  return {
    BalanceProof: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
      { name: 'lockedAmount', type: 'uint256' },
      { name: 'locksRoot', type: 'bytes32' },
    ],
  };
}
