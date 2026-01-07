// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TokenNetwork
 * @notice Manages payment channel lifecycle for a single ERC20 token
 * @dev Implements channel opening, deposits, and state tracking for two-party payment channels
 *
 * Channel Lifecycle:
 * NonExistent -> openChannel() -> Opened -> setTotalDeposit() -> Opened
 * Opened -> closeChannel() -> Closed -> settleChannel() -> Settled
 *
 * Story 8.3: Implements opening and deposit management
 * Story 8.4: Implements closure and settlement
 * Story 8.5: Adds security hardening (pausable, limits, cooperative settlement, withdrawal)
 */
contract TokenNetwork is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Channel states for lifecycle management
    enum ChannelState {
        NonExistent, // Channel not created
        Opened, // Channel active, deposits allowed
        Closed, // Channel closing, challenge period active (Story 8.4)
        Settled // Channel finalized, funds distributed (Story 8.4)
    }

    /**
     * @notice Balance proof structure for off-chain state commitments
     * @dev Signed by participants to commit to channel state
     * Each participant signs balance proofs showing how much they have sent to the counterparty
     */
    struct BalanceProof {
        bytes32 channelId; // Channel identifier
        uint256 nonce; // Monotonically increasing state counter
        uint256 transferredAmount; // Cumulative amount sent to counterparty
        uint256 lockedAmount; // Amount in pending conditional transfers (Story 8.5)
        bytes32 locksRoot; // Merkle root of hash-locked transfers (Story 8.5)
    }

    /**
     * @notice Withdrawal proof structure for removing funds during channel lifetime
     * @dev Signed by counterparty to authorize participant withdrawal
     * Allows reducing locked capital without full settlement
     */
    struct WithdrawProof {
        bytes32 channelId; // Channel identifier
        address participant; // Who is withdrawing (NOT the signer)
        uint256 amount; // Amount to withdraw
        uint256 nonce; // Monotonically increasing withdrawal counter
        uint256 expiry; // Withdrawal proof expires after this timestamp
    }

    /**
     * @notice Per-participant state within a channel
     * @dev Tracks deposits, withdrawals, and off-chain state commitments
     */
    struct ParticipantState {
        uint256 deposit; // Total deposited by participant (cumulative)
        uint256 withdrawnAmount; // Withdrawn during channel lifetime (Story 8.5)
        bool isCloser; // True if this participant initiated close (Story 8.4)
        uint256 nonce; // Monotonically increasing state counter (Story 8.4)
        bytes32 balanceHash; // Hash of transferred/locked amounts (Story 8.4)
        uint256 transferredAmount; // Amount transferred to counterparty (from balance proof)
    }

    /**
     * @notice Channel data structure
     * @dev Stores channel state and participant data
     */
    struct Channel {
        address participant1; // First participant (ordered, min address)
        address participant2; // Second participant (ordered, max address)
        uint256 settlementTimeout; // Challenge period duration (seconds)
        ChannelState state; // Current channel status
        uint256 closedAt; // Block timestamp when closed (Story 8.4)
        uint256 openedAt; // Block timestamp when opened (Story 8.5)
        mapping(address => ParticipantState) participants; // Participant data
    }

    // Custom errors for gas efficiency
    error InvalidParticipant();
    error InvalidSettlementTimeout();
    error ChannelNotFound();
    error ChannelAlreadyExists();
    error InvalidChannelState();
    error InvalidDeposit();
    error DepositFailed();
    error UnauthorizedDeposit();
    error InvalidBalanceProof(); // Signature verification failed
    error StaleBalanceProof(); // Balance proof nonce not greater than current
    error InvalidTransferredAmount(); // Transferred amount exceeds deposit
    error ChallengeExpired(); // Challenge period already passed
    error OnlyNonCloser(); // Only non-closing participant can update
    error ChallengeNotExpired(); // Settlement attempted before challenge period ends
    error ChannelAlreadySettled(); // Channel already in Settled state
    error DepositExceedsMaximum(uint256 requested, uint256 maximum); // Deposit exceeds maxDeposit limit
    error TokenNotWhitelisted(address token); // Token not in whitelist (Story 8.5)
    error ContractPaused(); // Operation attempted while paused (Story 8.5)
    error InsufficientBalanceChange(); // Actual received less than expected (Story 8.5)
    error SettlementTimeoutTooShort(uint256 provided, uint256 minimum); // Timeout below minimum (Story 8.5)
    error ChannelNotExpired(uint256 expiryTime); // Channel expiry not reached (Story 8.5)
    error NonceMismatch(uint256 nonce1, uint256 nonce2); // Cooperative settlement nonce mismatch (Story 8.5)
    error CooperativeSettlementFailed(); // Cooperative settlement validation failed (Story 8.5)
    error WithdrawalProofExpired(); // Withdrawal proof expired (Story 8.5)
    error InsufficientDepositForWithdrawal(); // Withdrawal exceeds available balance (Story 8.5)
    error InvalidWithdrawalProof(); // Withdrawal proof verification failed (Story 8.5)
    error RecoveryNotAllowedWhenActive(); // Emergency recovery when not paused (Story 8.5)

    // Events
    /**
     * @notice Emitted when a new channel is opened
     * @param channelId Unique channel identifier
     * @param participant1 First participant (ordered, min address)
     * @param participant2 Second participant (ordered, max address)
     * @param settlementTimeout Challenge period duration in seconds
     */
    event ChannelOpened(
        bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout
    );

    /**
     * @notice Emitted when a participant deposits tokens
     * @param channelId Channel identifier
     * @param participant Address of depositing participant
     * @param totalDeposit New total deposit amount
     * @param depositIncrease Amount added in this transaction
     */
    event ChannelDeposit(
        bytes32 indexed channelId, address indexed participant, uint256 totalDeposit, uint256 depositIncrease
    );

    /**
     * @notice Emitted when a channel is closed
     * @param channelId Unique channel identifier
     * @param closingParticipant Address of participant who closed the channel
     * @param nonce Balance proof nonce
     * @param balanceHash Hash of balance proof details
     */
    event ChannelClosed(
        bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce, bytes32 balanceHash
    );

    /**
     * @notice Emitted when non-closing participant updates their balance proof during challenge
     * @param channelId Unique channel identifier
     * @param participant Address of participant updating balance proof
     * @param nonce Updated balance proof nonce
     * @param balanceHash Updated balance hash
     */
    event NonClosingBalanceProofUpdated(
        bytes32 indexed channelId, address indexed participant, uint256 nonce, bytes32 balanceHash
    );

    /**
     * @notice Emitted when a channel is settled
     * @param channelId Unique channel identifier
     * @param participant1Amount Final amount transferred to participant1
     * @param participant2Amount Final amount transferred to participant2
     */
    event ChannelSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    /**
     * @notice Emitted when maximum deposit limit is updated
     * @param oldMax Previous maximum deposit limit
     * @param newMax New maximum deposit limit
     */
    event MaxDepositUpdated(uint256 oldMax, uint256 newMax);

    /**
     * @notice Emitted when channel expires and is force-closed
     * @param channelId Unique channel identifier
     * @param openedAt Timestamp when channel was opened
     * @param closedAt Timestamp when channel was force-closed
     */
    event ChannelExpired(bytes32 indexed channelId, uint256 openedAt, uint256 closedAt);

    /**
     * @notice Emitted when channel is cooperatively settled
     * @param channelId Unique channel identifier
     * @param participant1Amount Final amount transferred to participant1
     * @param participant2Amount Final amount transferred to participant2
     */
    event CooperativeSettlement(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    /**
     * @notice Emitted when participant withdraws funds during channel lifetime
     * @param channelId Unique channel identifier
     * @param participant Address of withdrawing participant
     * @param amount Amount withdrawn
     * @param nonce Withdrawal proof nonce
     */
    event Withdrawal(bytes32 indexed channelId, address indexed participant, uint256 amount, uint256 nonce);

    /**
     * @notice Emitted when owner recovers tokens in emergency
     * @param token Token address
     * @param recipient Recipient of recovered tokens
     * @param amount Amount recovered
     */
    event EmergencyTokenRecovery(address indexed token, address indexed recipient, uint256 amount);

    /**
     * @notice Emitted when token is added to whitelist
     * @param token Token address added to whitelist
     */
    event TokenWhitelisted(address indexed token);

    /**
     * @notice Emitted when token is removed from whitelist
     * @param token Token address removed from whitelist
     */
    event TokenRemovedFromWhitelist(address indexed token);

    // State variables
    /// @notice The ERC20 token this TokenNetwork manages
    address public immutable token;

    /// @notice EIP-712 domain separator for signature verification
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice EIP-712 type hash for BalanceProof struct
    bytes32 public constant BALANCE_PROOF_TYPEHASH = keccak256(
        "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
    );

    /// @notice EIP-712 type hash for WithdrawProof struct (Story 8.5)
    bytes32 public constant WITHDRAW_PROOF_TYPEHASH =
        keccak256("WithdrawProof(bytes32 channelId,address participant,uint256 amount,uint256 nonce,uint256 expiry)");

    /// @notice Mapping from channel ID to Channel struct
    mapping(bytes32 => Channel) public channels;

    /// @notice Global channel counter for unique channel IDs
    uint256 public channelCounter;

    /// @notice Minimum settlement timeout (1 hour)
    uint256 public constant MIN_SETTLEMENT_TIMEOUT = 1 hours;

    /// @notice Maximum settlement timeout (30 days)
    uint256 public constant MAX_SETTLEMENT_TIMEOUT = 30 days;

    /// @notice Maximum channel lifetime (1 year) - channels can be force-closed after this (Story 8.5)
    uint256 public constant MAX_CHANNEL_LIFETIME = 365 days;

    /// @notice Maximum deposit limit per channel (default: 1M tokens with 18 decimals)
    /// @dev Configurable by owner to prevent griefing attacks
    uint256 public maxDeposit = 1_000_000 * 10 ** 18;

    /**
     * @notice Creates a new TokenNetwork for a specific ERC20 token
     * @param _token The address of the ERC20 token
     */
    constructor(address _token) Ownable(msg.sender) {
        if (_token == address(0)) revert InvalidParticipant();
        token = _token;

        // Compute EIP-712 domain separator
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("PaymentChannel")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Mapping to track active channels per participant pair (prevents duplicates)
    mapping(bytes32 => bool) public hasActiveChannel;

    /**
     * @notice Opens a new payment channel between two participants
     * @dev Participants are ordered deterministically (min, max) to prevent duplicate channels
     * @param participant2 The address of the second participant
     * @param settlementTimeout Challenge period duration in seconds
     * @return channelId The unique identifier for the created channel
     */
    function openChannel(address participant2, uint256 settlementTimeout) external whenNotPaused returns (bytes32) {
        // Validate participant2
        if (participant2 == address(0)) revert InvalidParticipant();
        if (participant2 == msg.sender) revert InvalidParticipant();

        // Validate settlement timeout
        if (settlementTimeout < MIN_SETTLEMENT_TIMEOUT || settlementTimeout > MAX_SETTLEMENT_TIMEOUT) {
            revert InvalidSettlementTimeout();
        }

        // Order participants deterministically
        address participant1 = msg.sender;
        if (participant1 > participant2) {
            (participant1, participant2) = (participant2, participant1);
        }

        // Compute participant pair key (without counter)
        bytes32 pairKey = keccak256(abi.encodePacked(participant1, participant2));

        // Verify no active channel exists for this pair
        if (hasActiveChannel[pairKey]) {
            revert ChannelAlreadyExists();
        }

        // Compute deterministic channel ID
        bytes32 channelId = keccak256(abi.encodePacked(participant1, participant2, channelCounter));

        // Increment global counter
        channelCounter++;

        // Mark pair as having active channel
        hasActiveChannel[pairKey] = true;

        // Initialize channel
        Channel storage channel = channels[channelId];
        channel.participant1 = participant1;
        channel.participant2 = participant2;
        channel.settlementTimeout = settlementTimeout;
        channel.state = ChannelState.Opened;
        channel.closedAt = 0;
        channel.openedAt = block.timestamp; // Story 8.5: track when channel was opened

        // Initialize participant states (defaults to zero)
        // ParticipantState is already zero-initialized by default

        // Emit event
        emit ChannelOpened(channelId, participant1, participant2, settlementTimeout);

        return channelId;
    }

    /**
     * @notice Deposits tokens into a channel for a specific participant
     * @dev Uses SafeERC20 to handle non-standard tokens and measures actual balance change for fee-on-transfer tokens
     * @dev Only the participant themselves can deposit (msg.sender must equal participant)
     * @param channelId The channel identifier
     * @param participant The participant address to deposit for
     * @param totalDeposit The new total deposit amount (must be >= current deposit)
     */
    function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel exists and is opened using helper
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Opened);

        // Validate caller is the participant (prevent third-party deposits without authorization)
        if (msg.sender != participant) {
            revert UnauthorizedDeposit();
        }

        // Validate participant is actually in this channel
        Channel storage channel = channels[channelId];
        if (participant != channel.participant1 && participant != channel.participant2) {
            revert InvalidParticipant();
        }

        // Get current deposit
        uint256 currentDeposit = channel.participants[participant].deposit;

        // Validate totalDeposit >= currentDeposit (can only increase)
        if (totalDeposit < currentDeposit) {
            revert InvalidDeposit();
        }

        // Validate totalDeposit does not exceed maximum deposit limit
        if (totalDeposit > maxDeposit) {
            revert DepositExceedsMaximum(totalDeposit, maxDeposit);
        }

        // Calculate deposit increase
        uint256 depositIncrease = totalDeposit - currentDeposit;

        // Measure balance before transfer
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));

        // Transfer tokens from participant
        IERC20(token).safeTransferFrom(participant, address(this), depositIncrease);

        // Measure balance after transfer
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));

        // Calculate actual received amount (handles fee-on-transfer tokens)
        uint256 actualReceived = balanceAfter - balanceBefore;

        // Update participant deposit with actual received amount
        channel.participants[participant].deposit = currentDeposit + actualReceived;

        // Emit event with actual values
        emit ChannelDeposit(channelId, participant, currentDeposit + actualReceived, actualReceived);
    }

    /**
     * @notice Closes a payment channel with balance proof from non-closing participant
     * @dev Initiates challenge period, allowing counterparty to submit newer state
     * @param channelId The channel identifier
     * @param balanceProof Balance proof from non-closing participant
     * @param signature EIP-712 signature of the balance proof
     */
    function closeChannel(bytes32 channelId, BalanceProof memory balanceProof, bytes memory signature)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel exists and is opened
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Opened);

        Channel storage channel = channels[channelId];

        // Validate msg.sender is one of the two participants
        if (msg.sender != channel.participant1 && msg.sender != channel.participant2) {
            revert InvalidParticipant();
        }

        // Identify closing and non-closing participants
        address closingParticipant = msg.sender;
        address nonClosingParticipant =
            (closingParticipant == channel.participant1) ? channel.participant2 : channel.participant1;

        // Validate balance proof channelId matches function parameter
        if (balanceProof.channelId != channelId) {
            revert InvalidBalanceProof();
        }

        // Verify balance proof signature from non-closing participant
        if (!_verifyBalanceProof(balanceProof, signature, nonClosingParticipant)) {
            revert InvalidBalanceProof();
        }

        // Validate balance proof nonce is greater than current nonce (prevent stale state)
        uint256 currentNonce = channel.participants[closingParticipant].nonce;
        if (balanceProof.nonce <= currentNonce) {
            revert StaleBalanceProof();
        }

        // Validate transferredAmount doesn't exceed non-closing participant's deposit
        uint256 nonClosingDeposit = channel.participants[nonClosingParticipant].deposit;
        if (balanceProof.transferredAmount > nonClosingDeposit) {
            revert InvalidTransferredAmount();
        }

        // Update closing participant state
        channel.participants[closingParticipant].isCloser = true;
        channel.participants[closingParticipant].nonce = balanceProof.nonce;
        channel.participants[closingParticipant].transferredAmount = balanceProof.transferredAmount;
        channel.participants[closingParticipant].balanceHash = keccak256(
            abi.encodePacked(balanceProof.transferredAmount, balanceProof.lockedAmount, balanceProof.locksRoot)
        );

        // Update channel state
        channel.state = ChannelState.Closed;
        channel.closedAt = block.timestamp;

        // Emit event
        emit ChannelClosed(
            channelId, closingParticipant, balanceProof.nonce, channel.participants[closingParticipant].balanceHash
        );
    }

    /**
     * @notice Updates balance proof from non-closing participant during challenge period
     * @dev Allows counterparty to submit newer state to prevent fraud
     * @param channelId The channel identifier
     * @param balanceProof Balance proof from closing participant
     * @param signature EIP-712 signature of the balance proof
     */
    function updateNonClosingBalanceProof(bytes32 channelId, BalanceProof memory balanceProof, bytes memory signature)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel exists and is closed (can only update during challenge period)
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Closed);

        Channel storage channel = channels[channelId];

        // Validate challenge period has not expired
        if (block.timestamp > channel.closedAt + channel.settlementTimeout) {
            revert ChallengeExpired();
        }

        // Identify closing and non-closing participants
        address closingParticipant =
            channel.participants[channel.participant1].isCloser ? channel.participant1 : channel.participant2;
        address nonClosingParticipant =
            (closingParticipant == channel.participant1) ? channel.participant2 : channel.participant1;

        // Validate msg.sender is non-closing participant
        if (msg.sender != nonClosingParticipant) {
            revert OnlyNonCloser();
        }

        // Validate balance proof channelId matches function parameter
        if (balanceProof.channelId != channelId) {
            revert InvalidBalanceProof();
        }

        // Verify balance proof signature from closing participant
        if (!_verifyBalanceProof(balanceProof, signature, closingParticipant)) {
            revert InvalidBalanceProof();
        }

        // Validate balance proof nonce is strictly greater than current closing participant nonce
        uint256 currentNonce = channel.participants[closingParticipant].nonce;
        if (balanceProof.nonce <= currentNonce) {
            revert StaleBalanceProof();
        }

        // Validate transferredAmount doesn't exceed closing participant's deposit
        uint256 closingDeposit = channel.participants[closingParticipant].deposit;
        if (balanceProof.transferredAmount > closingDeposit) {
            revert InvalidTransferredAmount();
        }

        // Update non-closing participant state
        channel.participants[nonClosingParticipant].nonce = balanceProof.nonce;
        channel.participants[nonClosingParticipant].transferredAmount = balanceProof.transferredAmount;
        channel.participants[nonClosingParticipant].balanceHash = keccak256(
            abi.encodePacked(balanceProof.transferredAmount, balanceProof.lockedAmount, balanceProof.locksRoot)
        );

        // Emit event
        emit NonClosingBalanceProofUpdated(
            channelId,
            nonClosingParticipant,
            balanceProof.nonce,
            channel.participants[nonClosingParticipant].balanceHash
        );
    }

    /**
     * @notice Settles a closed channel and distributes final balances
     * @dev Can only be called after challenge period expires
     * @param channelId The channel identifier
     */
    function settleChannel(bytes32 channelId) external nonReentrant whenNotPaused {
        // Validate channel exists and is closed
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Closed);

        Channel storage channel = channels[channelId];

        // Validate challenge period has expired
        if (block.timestamp <= channel.closedAt + channel.settlementTimeout) {
            revert ChallengeNotExpired();
        }

        // Get participant addresses
        address participant1 = channel.participant1;
        address participant2 = channel.participant2;

        // Get deposits
        uint256 deposit1 = channel.participants[participant1].deposit;
        uint256 deposit2 = channel.participants[participant2].deposit;

        // Get transferred amounts from balance proofs
        // CRITICAL: Storage semantics are:
        // participants[closer].transferredAmount = what non-closer sent TO closer
        // participants[non-closer].transferredAmount = what closer sent TO non-closer (from updateNonClosingBalanceProof)
        //
        // In other words: participants[X].transferredAmount = amount X RECEIVED from counterparty
        uint256 participant1Received = channel.participants[participant1].transferredAmount;
        uint256 participant2Received = channel.participants[participant2].transferredAmount;

        // Get withdrawn amounts
        uint256 participant1Withdrawn = channel.participants[participant1].withdrawnAmount;
        uint256 participant2Withdrawn = channel.participants[participant2].withdrawnAmount;

        // Calculate final balances
        // Each participant gets: their deposit + what they received - what they sent - what they withdrew
        // Since participants[X].transferredAmount = what X received:
        // - participant1 sent = what participant2 received
        // - participant2 sent = what participant1 received
        //
        // participant1Final = deposit1 - sent + received - withdrawn
        //                   = deposit1 - participant2Received + participant1Received - participant1Withdrawn
        uint256 participant1Final = deposit1 + participant1Received - participant2Received - participant1Withdrawn;
        uint256 participant2Final = deposit2 + participant2Received - participant1Received - participant2Withdrawn;

        // Update channel state to Settled
        channel.state = ChannelState.Settled;

        // Clear active channel mapping (allow new channel for this pair)
        bytes32 pairKey = keccak256(abi.encodePacked(participant1, participant2));
        hasActiveChannel[pairKey] = false;

        // Transfer tokens to participants
        if (participant1Final > 0) {
            IERC20(token).safeTransfer(participant1, participant1Final);
        }
        if (participant2Final > 0) {
            IERC20(token).safeTransfer(participant2, participant2Final);
        }

        // Emit event
        emit ChannelSettled(channelId, participant1Final, participant2Final);
    }

    /**
     * @notice Force-closes an expired channel after MAX_CHANNEL_LIFETIME
     * @dev Anyone can call this function to clean up old channels
     * @dev Prevents indefinite fund locking if one participant disappears
     * @param channelId The channel identifier
     */
    function forceCloseExpiredChannel(bytes32 channelId) external whenNotPaused {
        // Validate channel exists and is opened
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Opened);

        Channel storage channel = channels[channelId];

        // Validate channel has expired
        uint256 expiryTime = channel.openedAt + MAX_CHANNEL_LIFETIME;
        if (block.timestamp <= expiryTime) {
            revert ChannelNotExpired(expiryTime);
        }

        // Close channel with empty balance proofs (assume no transfers)
        channel.state = ChannelState.Closed;
        channel.closedAt = block.timestamp;

        // Emit event
        emit ChannelExpired(channelId, channel.openedAt, block.timestamp);
    }

    /**
     * @notice Cooperatively settles channel bypassing challenge period
     * @dev Requires matching balance proofs from both participants
     * @dev Both participants must sign proofs with same nonce (mutual agreement)
     * @param channelId The channel identifier
     * @param proof1 Balance proof from participant1
     * @param sig1 Signature from participant1
     * @param proof2 Balance proof from participant2
     * @param sig2 Signature from participant2
     */
    function cooperativeSettle(
        bytes32 channelId,
        BalanceProof memory proof1,
        bytes memory sig1,
        BalanceProof memory proof2,
        bytes memory sig2
    ) external nonReentrant whenNotPaused {
        // Validate channel exists and is opened
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Opened);

        Channel storage channel = channels[channelId];
        address participant1 = channel.participant1;
        address participant2 = channel.participant2;

        // Verify both proofs are for this channel
        if (proof1.channelId != channelId || proof2.channelId != channelId) {
            revert InvalidBalanceProof();
        }

        // Verify signatures
        if (!_verifyBalanceProof(proof1, sig1, participant1)) {
            revert InvalidBalanceProof();
        }
        if (!_verifyBalanceProof(proof2, sig2, participant2)) {
            revert InvalidBalanceProof();
        }

        // Verify nonces match (mutual agreement on final state)
        if (proof1.nonce != proof2.nonce) {
            revert NonceMismatch(proof1.nonce, proof2.nonce);
        }

        // Get deposits and withdrawn amounts
        uint256 deposit1 = channel.participants[participant1].deposit;
        uint256 deposit2 = channel.participants[participant2].deposit;
        uint256 withdrawn1 = channel.participants[participant1].withdrawnAmount;
        uint256 withdrawn2 = channel.participants[participant2].withdrawnAmount;

        // Calculate final balances
        // proof1.transferredAmount = what participant1 sent to participant2
        // proof2.transferredAmount = what participant2 sent to participant1
        uint256 participant1Final = deposit1 - withdrawn1 - proof1.transferredAmount + proof2.transferredAmount;
        uint256 participant2Final = deposit2 - withdrawn2 - proof2.transferredAmount + proof1.transferredAmount;

        // Update channel state directly to Settled (bypass Closed state)
        channel.state = ChannelState.Settled;

        // Clear active channel mapping
        bytes32 pairKey = keccak256(abi.encodePacked(participant1, participant2));
        hasActiveChannel[pairKey] = false;

        // Transfer tokens to participants
        if (participant1Final > 0) {
            IERC20(token).safeTransfer(participant1, participant1Final);
        }
        if (participant2Final > 0) {
            IERC20(token).safeTransfer(participant2, participant2Final);
        }

        // Emit event
        emit CooperativeSettlement(channelId, participant1Final, participant2Final);
    }

    /**
     * @notice Withdraw funds during channel lifetime with counterparty signature
     * @dev Allows reducing locked capital without full settlement
     * @param channelId The channel identifier
     * @param proof Withdrawal proof signed by counterparty
     * @param counterpartySignature EIP-712 signature from counterparty
     */
    function withdraw(bytes32 channelId, WithdrawProof memory proof, bytes memory counterpartySignature)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel exists and is opened
        _requireChannelExists(channelId);
        _requireChannelState(channelId, ChannelState.Opened);

        Channel storage channel = channels[channelId];

        // Validate msg.sender is the participant withdrawing
        if (msg.sender != proof.participant) {
            revert InvalidParticipant();
        }

        // Validate participant is in this channel
        if (proof.participant != channel.participant1 && proof.participant != channel.participant2) {
            revert InvalidParticipant();
        }

        // Validate proof is for this channel
        if (proof.channelId != channelId) {
            revert InvalidWithdrawalProof();
        }

        // Validate proof not expired
        if (block.timestamp > proof.expiry) {
            revert WithdrawalProofExpired();
        }

        // Identify counterparty
        address counterparty = (proof.participant == channel.participant1) ? channel.participant2 : channel.participant1;

        // Verify counterparty signature
        if (!_verifyWithdrawProof(proof, counterpartySignature, counterparty)) {
            revert InvalidWithdrawalProof();
        }

        // Validate nonce is strictly greater (prevent replay)
        uint256 currentNonce = channel.participants[proof.participant].nonce;
        if (proof.nonce <= currentNonce) {
            revert StaleBalanceProof();
        }

        // Validate withdrawal amount doesn't exceed available balance
        uint256 deposit = channel.participants[proof.participant].deposit;
        uint256 withdrawnAmount = channel.participants[proof.participant].withdrawnAmount;
        uint256 available = deposit - withdrawnAmount;

        if (proof.amount > available) {
            revert InsufficientDepositForWithdrawal();
        }

        // Update participant state
        channel.participants[proof.participant].withdrawnAmount += proof.amount;
        channel.participants[proof.participant].nonce = proof.nonce;

        // Transfer tokens to participant
        IERC20(token).safeTransfer(proof.participant, proof.amount);

        // Emit event
        emit Withdrawal(channelId, proof.participant, proof.amount, proof.nonce);
    }

    /**
     * @notice Emergency function to recover tokens stuck in contract
     * @dev ONLY use if channel in invalid state and participants cannot withdraw
     * @dev Contract MUST be paused before calling this function
     * @dev Intended for exceptional circumstances only (e.g., contract upgrade)
     * @param _token The token address to recover
     * @param recipient The recipient of recovered tokens
     * @param amount The amount to recover
     */
    function emergencyTokenRecovery(address _token, address recipient, uint256 amount) external onlyOwner whenPaused {
        // Validate recipient
        if (recipient == address(0)) {
            revert InvalidParticipant();
        }

        // Transfer tokens to recipient
        IERC20(_token).safeTransfer(recipient, amount);

        // Emit event
        emit EmergencyTokenRecovery(_token, recipient, amount);
    }

    /**
     * @notice Pauses all channel operations in case of emergency
     * @dev Can only be called by contract owner. Prevents all state-changing functions.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses channel operations after emergency is resolved
     * @dev Can only be called by contract owner. Restores normal functionality.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Updates the maximum deposit limit per channel
     * @dev Can only be called by contract owner. Used to prevent griefing attacks.
     * @param newMax New maximum deposit limit
     */
    function setMaxDeposit(uint256 newMax) external onlyOwner {
        uint256 oldMax = maxDeposit;
        maxDeposit = newMax;
        emit MaxDepositUpdated(oldMax, newMax);
    }

    /**
     * @notice Get the current state of a channel
     * @param channelId The channel identifier
     * @return The current channel state
     */
    function getChannelState(bytes32 channelId) external view returns (ChannelState) {
        return channels[channelId].state;
    }

    /**
     * @notice Get the participants of a channel
     * @dev Returns participants in ordered form (min, max)
     * @param channelId The channel identifier
     * @return participant1 First participant address
     * @return participant2 Second participant address
     */
    function getChannelParticipants(bytes32 channelId)
        external
        view
        returns (address participant1, address participant2)
    {
        Channel storage channel = channels[channelId];
        return (channel.participant1, channel.participant2);
    }

    /**
     * @notice Get the deposit amount for a participant in a channel
     * @param channelId The channel identifier
     * @param participant The participant address
     * @return The participant's total deposit
     */
    function getChannelDeposit(bytes32 channelId, address participant) external view returns (uint256) {
        return channels[channelId].participants[participant].deposit;
    }

    /**
     * @notice Internal helper to require channel exists
     * @param channelId The channel identifier
     */
    function _requireChannelExists(bytes32 channelId) internal view {
        if (channels[channelId].state == ChannelState.NonExistent) {
            revert ChannelNotFound();
        }
    }

    /**
     * @notice Internal helper to require specific channel state
     * @param channelId The channel identifier
     * @param expectedState The expected channel state
     */
    function _requireChannelState(bytes32 channelId, ChannelState expectedState) internal view {
        if (channels[channelId].state != expectedState) {
            revert InvalidChannelState();
        }
    }

    /**
     * @notice Verifies an EIP-712 balance proof signature
     * @dev Recovers signer from signature and validates against expected signer
     * @param proof The balance proof structure
     * @param signature The signature bytes
     * @param expectedSigner The expected signer address
     * @return True if signature is valid and from expected signer
     */
    function _verifyBalanceProof(BalanceProof memory proof, bytes memory signature, address expectedSigner)
        internal
        view
        returns (bool)
    {
        // Compute EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                BALANCE_PROOF_TYPEHASH,
                proof.channelId,
                proof.nonce,
                proof.transferredAmount,
                proof.lockedAmount,
                proof.locksRoot
            )
        );

        // Compute EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        // Recover signer from signature
        address recovered = ECDSA.recover(digest, signature);

        // Validate recovered address is not zero (invalid signature returns address(0))
        // and matches expected signer
        return recovered != address(0) && recovered == expectedSigner;
    }

    /**
     * @notice Verifies an EIP-712 withdrawal proof signature
     * @dev Recovers signer from signature and validates against expected signer
     * @param proof The withdrawal proof structure
     * @param signature The signature bytes
     * @param expectedSigner The expected signer address
     * @return True if signature is valid and from expected signer
     */
    function _verifyWithdrawProof(WithdrawProof memory proof, bytes memory signature, address expectedSigner)
        internal
        view
        returns (bool)
    {
        // Compute EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAW_PROOF_TYPEHASH, proof.channelId, proof.participant, proof.amount, proof.nonce, proof.expiry
            )
        );

        // Compute EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        // Recover signer from signature
        address recovered = ECDSA.recover(digest, signature);

        // Validate recovered address matches expected signer
        return recovered != address(0) && recovered == expectedSigner;
    }
}
