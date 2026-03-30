/**
 * Privacy module for settlement transport layer.
 *
 * Provides NIP-59-inspired three-layer encryption wrapping for BTP claim messages,
 * ensuring transport-layer privacy alongside on-chain privacy mechanisms.
 *
 * @module settlement/privacy
 */

export {
  NIP59ClaimWrapper,
  NIP59TransportWrapper,
  NIP59WrapError,
  BTP_WRAPPED_CLAIM_PROTOCOL,
  serializeWrappedClaim,
  deserializeWrappedClaim,
} from './nip59-claim-wrapper';

export type { WrappedClaim, NIP59ClaimWrapperOptions } from './nip59-claim-wrapper';
