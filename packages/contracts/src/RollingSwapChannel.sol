// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title RollingSwapChannel
/// @notice Production chain-B settlement contract for the TOON rolling-swap
///         receive side (rolling-swap epic — toon-protocol/toon-meta#145,
///         connector#315).
///
/// @dev THE CLAIM WIRE FORMAT IS ABI-LOCKED. The `updateBalance(...)` entrypoint
///      and the `SettlementSucceeded(...)` event are byte-for-byte what the
///      shipped the toon-protocol/sdk `buildSettlementTx()` /
///      the toon-protocol/client `submitEvmSettlement()` produce and expect
///      (proven end-to-end by toon-protocol/swap#59). Redeeming a cumulative
///      balance proof verifies the swap node's raw-secp256k1 signature over
///
///          keccak256( channelId(32) || cumulativeAmount(32BE)
///                      || nonce(32BE) || recipient(20) )
///
///      signed with NO EIP-191 / NO EIP-712 prefix as a 65-byte `r || s || v`
///      blob (v = 27 + recovery). This is the exact digest emitted by
///      the toon-protocol/core `balanceProofHashEvm` and the swap node's
///      `EvmPaymentChannelSigner.signBalanceProof`. Changing any of the
///      `updateBalance` arity/types, the digest preimage, or the event shape
///      requires a coordinated change to the sdk, the client, and the swap
///      signer — DO NOT drift it here.
///
///      Differences vs the swap#59 test fixture (`RollingSwapChannel.sol` in
///      the swap repo's integration suite), all of which are INTERNAL to the
///      contract and invisible to the ABI-locked surface:
///        1. Settles an ERC20 (SafeERC20), not native ETH — the connector's
///           production settlement asset is USDC. One token per contract
///           instance (constructor-bound), mirroring TokenNetwork.
///        2. Full channel lifecycle: cooperative close (dual-signed, the EVM
///           analog of the Mina co-sign) and unilateral / challenge-timeout
///           close, so a funder can recover unspent deposit.
///        3. Re-entrancy guard on every value-moving path.
///
///      This contract is deliberately ownerless and non-pausable: it custodies
///      settlement funds, and a global admin/freeze key would be a rug/censor
///      vector against a recipient's already-earned, already-signed balance.
///      The only privileged role is per-channel (`funder`), scoped to
///      reclaiming that channel's own unspent deposit.
contract RollingSwapChannel is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Immutable config
    // -----------------------------------------------------------------------

    /// @notice The ERC20 token this contract settles (constructor-bound).
    address public immutable token;

    /// @notice Challenge-window duration for a unilateral close, during which
    ///         the recipient can still redeem the final signed watermark before
    ///         the funder reclaims the remaining deposit.
    uint256 public immutable challengePeriod;

    /// @notice Minimum permitted challenge period. Floored at 1 day so a
    ///         recipient always has a realistic window to observe a unilateral
    ///         close and redeem their final signed watermark before the funder
    ///         reclaims the remainder (1 hour was too short for safe operation).
    uint256 public constant MIN_CHALLENGE_PERIOD = 1 days;

    // -----------------------------------------------------------------------
    // Domain-separation tag for the recipient's cooperative-close signature.
    // The claim digest is ABI-locked and NOT domain-separated (it must match
    // the swap signer). The close-acknowledgement digest is NEW surface under
    // our control, so we tag it to domain-separate a close-acknowledgement from
    // a claim and to version the message (V1). NOTE: this tag does NOT bind
    // chainId or address(this), so it does NOT by itself prevent cross-contract
    // or cross-chain replay of a close-ack — it only guarantees a close-ack can
    // never be misread as a balance-proof claim (or vice versa) and carries an
    // explicit version. Cross-deployment domain separation is tracked
    // separately (finding #1).
    // -----------------------------------------------------------------------
    bytes32 private constant COOP_CLOSE_TAG = keccak256("TOON_ROLLING_SWAP_COOP_CLOSE_V1");

    // -----------------------------------------------------------------------
    // Channel state
    // -----------------------------------------------------------------------

    enum ChannelState {
        NonExistent,
        Open, // active, updateBalance + close paths available
        Closing, // unilateral close initiated; challenge window running
        Closed // remainder withdrawn / cooperatively settled; terminal
    }

    struct Channel {
        address signer; // the swap node's chain-B claim signer (recovers claims)
        address funder; // who funded the deposit and may reclaim the remainder
        uint256 nonce; // last settled balance-proof nonce (monotone)
        uint256 cumulativePaid; // cumulative amount already paid out
        uint256 deposit; // remaining (un-paid-out) deposit
        uint64 closingAt; // timestamp unilateral close began (0 while Open)
        ChannelState state;
    }

    /// @notice channelId => channel. channelId is caller-chosen at open, mirroring
    ///         the swap node's provisioned channel ids.
    mapping(bytes32 => Channel) public channels;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event ChannelOpened(bytes32 indexed channelId, address indexed signer, address indexed funder, uint256 deposit);
    event ChannelDeposit(bytes32 indexed channelId, address indexed from, uint256 amount, uint256 totalDeposit);

    /// @dev ABI-LOCKED. `SettlementSucceeded(bytes32,uint256,uint256,address)`;
    ///      `channelId` and `recipient` indexed; the two non-indexed data words
    ///      are `cumulativeAmount` then `nonce`, in that order. The client reads
    ///      this exact layout.
    event SettlementSucceeded(
        bytes32 indexed channelId, uint256 cumulativeAmount, uint256 nonce, address indexed recipient
    );

    event ChannelClosing(bytes32 indexed channelId, uint256 closingAt, uint256 challengeEndsAt);
    event ChannelClosed(bytes32 indexed channelId, address indexed funder, uint256 remainderReturned, bool cooperative);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error InvalidToken();
    error InvalidChallengePeriod();
    error ChannelExists();
    error UnknownChannel();
    error InvalidSigner();
    error ZeroDeposit();
    error InvalidChannelState();
    error StaleNonce();
    error StaleCumulativeAmount();
    error BadSignatureLength();
    error BadSignature();
    error InsufficientDeposit();
    error NotFunder();
    error ChallengeNotExpired();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /// @param _token The ERC20 token this contract settles.
    /// @param _challengePeriod Unilateral-close challenge window (>= 1 day).
    constructor(address _token, uint256 _challengePeriod) {
        if (_token == address(0)) revert InvalidToken();
        if (_challengePeriod < MIN_CHALLENGE_PERIOD) revert InvalidChallengePeriod();
        token = _token;
        challengePeriod = _challengePeriod;
    }

    // -----------------------------------------------------------------------
    // Open / fund
    // -----------------------------------------------------------------------

    /// @notice Open and fund a channel for a swap-node signer. The caller
    ///         (`msg.sender`) becomes the channel's funder and must have
    ///         approved this contract for `depositAmount` of `token`.
    /// @param channelId Caller-chosen id (mirrors the swap node's provisioned id).
    /// @param signer The swap node's chain-B claim-signing address.
    /// @param depositAmount Initial deposit (must be > 0).
    /// @dev Fee-on-transfer safe: credits the actual received balance delta.
    function openChannel(bytes32 channelId, address signer, uint256 depositAmount) external nonReentrant {
        if (channels[channelId].state != ChannelState.NonExistent) revert ChannelExists();
        if (signer == address(0)) revert InvalidSigner();
        if (depositAmount == 0) revert ZeroDeposit();

        uint256 received = _pullToken(msg.sender, depositAmount);

        channels[channelId] = Channel({
            signer: signer,
            funder: msg.sender,
            nonce: 0,
            cumulativePaid: 0,
            deposit: received,
            closingAt: 0,
            state: ChannelState.Open
        });

        emit ChannelOpened(channelId, signer, msg.sender, received);
    }

    /// @notice Top up an open channel's deposit. Restricted to the original
    ///         funder: the remainder is always returned to `ch.funder` on close,
    ///         so allowing a third party to top up would let them fund a channel
    ///         whose unspent balance can only ever be reclaimed by the funder
    ///         (a fund-donation / theft trap). The connector funds and tops up
    ///         each channel from the same funder account, so this guard does not
    ///         restrict any legitimate flow.
    function deposit(bytes32 channelId, uint256 amount) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Open) revert InvalidChannelState();
        if (msg.sender != ch.funder) revert NotFunder();
        if (amount == 0) revert ZeroDeposit();

        uint256 received = _pullToken(msg.sender, amount);
        ch.deposit += received;

        emit ChannelDeposit(channelId, msg.sender, received, ch.deposit);
    }

    // -----------------------------------------------------------------------
    // Redeem — ABI-LOCKED entrypoint
    // -----------------------------------------------------------------------

    /// @notice Redeem a cumulative balance proof signed by the channel's swap
    ///         signer, paying the recipient the delta above the last settled
    ///         cumulative. Callable while the channel is Open OR Closing (so a
    ///         recipient can always redeem the final watermark during a
    ///         unilateral-close challenge window).
    ///
    /// @dev ABI-LOCKED: selector, arity, types, digest preimage, and the
    ///      emitted event are the exact contract the sdk/client depend on.
    ///      Highest-nonce-wins: N cumulative claims net to one payout no matter
    ///      how many are submitted — only the delta over `cumulativePaid` moves.
    ///
    /// @param channelId The channel id.
    /// @param cumulativeAmount Cumulative amount owed to `recipient` (monotone).
    /// @param nonce Monotone balance-proof nonce (strictly greater than stored).
    /// @param recipient Address to receive the delta (bound into the signature).
    /// @param signature 65-byte `r || s || v` over the raw balance-proof digest.
    function updateBalance(
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 nonce,
        address recipient,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Open && ch.state != ChannelState.Closing) revert InvalidChannelState();
        if (nonce <= ch.nonce) revert StaleNonce();
        if (cumulativeAmount <= ch.cumulativePaid) revert StaleCumulativeAmount();
        if (signature.length != 65) revert BadSignatureLength();

        // Raw balance-proof digest — MUST match balanceProofHashEvm / the swap
        // node's EvmPaymentChannelSigner byte-for-byte. No EIP-191/712 prefix.
        // Built via _claimDigest (single source of truth shared with
        // cooperativeClose and the claimDigest view).
        bytes32 digest = _claimDigest(channelId, cumulativeAmount, nonce, recipient);
        // OZ ECDSA.recover rejects malleable (high-s) signatures and invalid v,
        // and reverts on address(0) recovery — strictly safer than bare ecrecover.
        if (ECDSA.recover(digest, signature) != ch.signer) revert BadSignature();

        uint256 delta = cumulativeAmount - ch.cumulativePaid;
        if (delta > ch.deposit) revert InsufficientDeposit();

        // Effects before interaction (CEI) — nonReentrant is belt-and-suspenders.
        ch.nonce = nonce;
        ch.cumulativePaid = cumulativeAmount;
        ch.deposit -= delta;

        IERC20(token).safeTransfer(recipient, delta);

        emit SettlementSucceeded(channelId, cumulativeAmount, nonce, recipient);
    }

    // -----------------------------------------------------------------------
    // Cooperative close — the EVM analog of the Mina B-leg co-sign
    // -----------------------------------------------------------------------

    /// @notice Cooperatively settle and close in one transaction: pay the
    ///         recipient the final signed watermark (swap-signer claim) and
    ///         immediately return the remaining deposit to the funder,
    ///         authorized by the recipient's co-signature — skipping the
    ///         unilateral challenge window entirely.
    ///
    /// @dev Two signatures are required, mirroring a Mina channel's dual-sign
    ///      redemption:
    ///        - `signerSig`: the swap signer's balance proof over the SAME
    ///          ABI-locked digest as `updateBalance` (channelId, cumulative,
    ///          nonce, recipient). Pays the recipient the delta.
    ///        - `recipientCloseSig`: the recipient's acknowledgement that this
    ///          is the final state, over a domain-tagged digest
    ///          `keccak256(COOP_CLOSE_TAG || channelId || cumulative || nonce)`.
    ///          This authorizes early release of the remainder to the funder.
    ///      Callable from Open or Closing. If `cumulativeAmount` merely equals
    ///      the already-settled cumulative (no new delta), only the funder's
    ///      remainder is released — a pure cooperative teardown.
    function cooperativeClose(
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 nonce,
        address recipient,
        bytes calldata signerSig,
        bytes calldata recipientCloseSig
    ) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Open && ch.state != ChannelState.Closing) revert InvalidChannelState();
        if (signerSig.length != 65 || recipientCloseSig.length != 65) revert BadSignatureLength();
        if (cumulativeAmount < ch.cumulativePaid) revert StaleCumulativeAmount();
        if (nonce < ch.nonce) revert StaleNonce();

        // 1. Verify the swap signer's claim over the ABI-locked digest.
        //    Same _claimDigest single source of truth as updateBalance.
        bytes32 claimHash = _claimDigest(channelId, cumulativeAmount, nonce, recipient);
        if (ECDSA.recover(claimHash, signerSig) != ch.signer) revert BadSignature();

        // 2. Verify the recipient's cooperative-close acknowledgement over the
        //    domain-tagged digest.
        bytes32 closeDigest = keccak256(abi.encodePacked(COOP_CLOSE_TAG, channelId, cumulativeAmount, nonce));
        if (ECDSA.recover(closeDigest, recipientCloseSig) != recipient) revert BadSignature();

        // 3. Pay the recipient any new delta.
        uint256 delta = cumulativeAmount - ch.cumulativePaid;
        if (delta > ch.deposit) revert InsufficientDeposit();

        ch.nonce = nonce;
        ch.cumulativePaid = cumulativeAmount;
        ch.deposit -= delta;
        uint256 remainder = ch.deposit;
        ch.deposit = 0;
        ch.state = ChannelState.Closed;

        if (delta > 0) {
            IERC20(token).safeTransfer(recipient, delta);
            emit SettlementSucceeded(channelId, cumulativeAmount, nonce, recipient);
        }
        if (remainder > 0) {
            IERC20(token).safeTransfer(ch.funder, remainder);
        }

        emit ChannelClosed(channelId, ch.funder, remainder, true);
    }

    // -----------------------------------------------------------------------
    // Unilateral / challenge-timeout close
    // -----------------------------------------------------------------------

    /// @notice Begin a unilateral close. Only the funder may call. Starts the
    ///         challenge window; the recipient can still `updateBalance` to
    ///         redeem the final signed watermark until it expires.
    function initiateClose(bytes32 channelId) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Open) revert InvalidChannelState();
        if (msg.sender != ch.funder) revert NotFunder();

        ch.state = ChannelState.Closing;
        ch.closingAt = uint64(block.timestamp);

        emit ChannelClosing(channelId, block.timestamp, block.timestamp + challengePeriod);
    }

    /// @notice After the challenge window expires, return the unspent deposit to
    ///         the funder and finalize the channel. Callable by anyone (the
    ///         funds go to the funder regardless), so a keeper can finalize.
    function withdrawRemainder(bytes32 channelId) external nonReentrant {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Closing) revert InvalidChannelState();
        if (block.timestamp < uint256(ch.closingAt) + challengePeriod) revert ChallengeNotExpired();

        uint256 remainder = ch.deposit;
        ch.deposit = 0;
        ch.state = ChannelState.Closed;

        address funder = ch.funder;
        if (remainder > 0) {
            IERC20(token).safeTransfer(funder, remainder);
        }

        emit ChannelClosed(channelId, funder, remainder, false);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Timestamp at which a Closing channel's challenge window expires
    ///         (0 for channels not in Closing).
    function challengeEndsAt(bytes32 channelId) external view returns (uint256) {
        Channel storage ch = channels[channelId];
        if (ch.state != ChannelState.Closing) return 0;
        return uint256(ch.closingAt) + challengePeriod;
    }

    /// @notice The exact digest the swap signer must sign for `updateBalance` /
    ///         the claim leg of `cooperativeClose`. Exposed for off-chain
    ///         tooling and tests; equals `balanceProofHashEvm(...)`.
    function claimDigest(bytes32 channelId, uint256 cumulativeAmount, uint256 nonce, address recipient)
        external
        pure
        returns (bytes32)
    {
        return _claimDigest(channelId, cumulativeAmount, nonce, recipient);
    }

    /// @notice The domain-tagged digest the recipient must sign to authorize a
    ///         cooperative close.
    function cooperativeCloseDigest(bytes32 channelId, uint256 cumulativeAmount, uint256 nonce)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(COOP_CLOSE_TAG, channelId, cumulativeAmount, nonce));
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /// @dev SINGLE SOURCE OF TRUTH for the ABI-locked claim (balance-proof)
    ///      digest. Used by `updateBalance`, the claim leg of `cooperativeClose`,
    ///      and the `claimDigest` view so the preimage exists in exactly one
    ///      place and cannot drift between call sites. MUST remain byte-for-byte
    ///      `keccak256(channelId(32) || cumulativeAmount(32BE) || nonce(32BE) ||
    ///      recipient(20))` — matching balanceProofHashEvm / the swap node's
    ///      EvmPaymentChannelSigner. No EIP-191/712 prefix.
    function _claimDigest(bytes32 channelId, uint256 cumulativeAmount, uint256 nonce, address recipient)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(channelId, cumulativeAmount, nonce, recipient));
    }

    /// @dev Pull `amount` of `token` from `from`, returning the actual balance
    ///      delta (fee-on-transfer safe).
    function _pullToken(address from, uint256 amount) internal returns (uint256) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - before;
    }
}
