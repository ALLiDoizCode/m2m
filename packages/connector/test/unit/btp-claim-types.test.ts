import { validateClaimMessage, type MinaClaimMessage } from '../../src/btp/btp-claim-types';

/**
 * A valid single-party (unidirectional) Mina claim used as the baseline for the
 * dual-party (#84) optional-field tests. Spread + override per-case.
 */
function baseMinaClaim(): MinaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'mina',
    messageId: 'claim-mina-001',
    timestamp: '2026-06-03T12:00:00.000Z',
    senderId: 'peer-bob',
    zkAppAddress: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyRvQs5uvfdj9c',
    tokenId: '1',
    balanceCommitment: '1000000',
    nonce: 1,
    proof: 'AAEC',
    salt: 'deadbeef',
  };
}

describe('validateMinaClaim (via validateClaimMessage)', () => {
  it('accepts a single-party claim with no dual-party fields (regression)', () => {
    expect(() => validateClaimMessage(baseMinaClaim())).not.toThrow();
  });

  it('accepts a claim with valid optional dual-party fields', () => {
    const claim: MinaClaimMessage = {
      ...baseMinaClaim(),
      transferredAmount: '1000000',
      balanceB: '500000',
      signatureB: 'sigB-base58-or-hex',
    };
    expect(() => validateClaimMessage(claim)).not.toThrow();
  });

  it('rejects a claim with a non-numeric balanceB', () => {
    const claim = { ...baseMinaClaim(), balanceB: 'abc' };
    expect(() => validateClaimMessage(claim)).toThrow(/balanceB/);
  });

  it('rejects a claim with a non-numeric transferredAmount', () => {
    const claim = { ...baseMinaClaim(), transferredAmount: 'not-a-number' };
    expect(() => validateClaimMessage(claim)).toThrow(/transferredAmount/);
  });

  it('rejects a claim with an empty signatureB', () => {
    const claim = { ...baseMinaClaim(), signatureB: '' };
    expect(() => validateClaimMessage(claim)).toThrow(/signatureB/);
  });
});
