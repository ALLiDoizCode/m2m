/**
 * Constants for the Mina Payment Channel zkApp.
 *
 * Channel state enum and assertion messages for all channel lifecycle operations.
 * Assertion messages for Story 34.2 (claimFromChannel) are defined here up front
 * to maintain a stable error surface across stories.
 *
 * @module constants
 */

import { Field } from 'o1js';

/**
 * Maximum safe amount for deposit and balance values.
 *
 * Field elements are ~254-bit modular integers. Without a range bound,
 * adding two large Fields can silently wrap around the field modulus.
 * We cap amounts at 2^64 - 1 (UInt64 max), which is more than sufficient
 * for any practical token amount while preventing overflow attacks.
 *
 * This matches the practical range used by Mina's native token amounts
 * and is consistent with the UInt64 range noted in the story dev notes.
 */
export const MAX_SAFE_AMOUNT = Field(BigInt('18446744073709551615')); // 2^64 - 1

/**
 * Channel state enum values stored on-chain as Field elements.
 *
 * - UNINITIALIZED (0): Default state before initializeChannel is called
 * - OPEN (1): Channel is active, deposits are accepted
 * - CLOSING (2): Close has been initiated, challenge period is running
 * - SETTLED (3): Challenge period elapsed, funds distributed
 */
export const CHANNEL_STATE = {
  UNINITIALIZED: Field(0),
  OPEN: Field(1),
  CLOSING: Field(2),
  SETTLED: Field(3),
} as const;

/**
 * Assertion messages for all zkApp methods.
 *
 * Includes messages for Story 34.1 (channel lifecycle) and Story 34.2
 * (claim verification) to ensure a stable error surface across stories.
 */
export const ASSERT_MESSAGES = {
  // Story 34.1 -- channel lifecycle
  CHANNEL_MUST_BE_UNINITIALIZED: 'channelState must be UNINITIALIZED',
  CHANNEL_MUST_BE_OPEN: 'channelState must be OPEN',
  CHANNEL_MUST_BE_CLOSING: 'channelState must be CLOSING',
  DEPOSIT_MUST_BE_POSITIVE: 'deposit amount must be greater than zero',
  BALANCE_SUM_MUST_EQUAL_DEPOSIT: 'balanceA + balanceB must equal depositTotal',
  CHALLENGE_PERIOD_NOT_ELAPSED: 'challenge period has not elapsed',
  COMMITMENT_MISMATCH: 'balance commitment does not match revealed balances',
  CHANNEL_HASH_MISMATCH: 'participant keys and nonce do not match stored channelHash',
  AMOUNT_EXCEEDS_SAFE_RANGE: 'amount exceeds safe range (max 2^64 - 1)',
  DEPOSIT_TOTAL_OVERFLOW: 'deposit total would exceed safe range (max 2^64 - 1)',
  BALANCE_EXCEEDS_DEPOSIT: 'individual balance must not exceed depositTotal',

  // Story 34.2 -- claim verification
  NONCE_MUST_INCREASE: 'nonce must be greater than current nonce',
  BALANCE_CONSERVATION_VIOLATED: 'claim violates balance conservation invariant',
  INVALID_SIGNATURE_A: 'participant A signature verification failed',
  INVALID_SIGNATURE_B: 'participant B signature verification failed',
  NONCE_EXCEEDS_SAFE_RANGE: 'nonce exceeds safe range (max 2^64 - 1)',
} as const;
