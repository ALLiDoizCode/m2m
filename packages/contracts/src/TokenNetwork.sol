// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title TokenNetwork
/// @notice Manages payment channels for a specific ERC20 token
/// @dev Deployed by TokenNetworkRegistry for each token. Supports channel opening, deposits, closure, and settlement.
contract TokenNetwork is ReentrancyGuard, EIP712, Pausable, Ownable {
    using SafeERC20 for IERC20;

    /// @notice The ERC20 token address this TokenNetwork manages
    address public immutable token;

    /// @notice Maximum deposit per participant per channel
    uint256 public immutable maxChannelDeposit;

    /// @notice Maximum channel lifetime before force-close allowed
    uint256 public immutable maxChannelLifetime;

    /// @notice Monotonically increasing counter for unique channel IDs
    uint256 public channelCounter;

    /// @notice Minimum settlement timeout (1 hour)
    uint256 public constant MIN_SETTLEMENT_TIMEOUT = 1 hours;

    /// @notice EIP-712 type hash for balance proof verification
    bytes32 private constant BALANCE_PROOF_TYPEHASH = keccak256(
        "BalanceProof(bytes32 channelId,uint256 nonce,uint256 transferredAmount,uint256 lockedAmount,bytes32 locksRoot)"
    );

    /// @notice EIP-712 type hash for withdrawal proof verification
    bytes32 private constant WITHDRAWAL_PROOF_TYPEHASH = keccak256(
        "WithdrawalProof(bytes32 channelId,address participant,uint256 withdrawnAmount,uint256 nonce)"
    );

    /// @notice Channel lifecycle states
    enum ChannelState {
        NonExistent, /// Channel doesn't exist
        Opened, /// Channel active, deposits allowed
        Closed, /// Channel closed, challenge period active
        Settled /// Channel settled, funds distributed
    }

    /// @notice Off-chain state representation for channel closure
    struct BalanceProof {
        bytes32 channelId; /// Channel identifier
        uint256 nonce; /// Monotonically increasing state counter
        uint256 transferredAmount; /// Cumulative amount sent to counterparty
        uint256 lockedAmount; /// Amount in pending HTLCs (unused in Story 8.4)
        bytes32 locksRoot; /// Merkle root of hash-locked transfers (unused in Story 8.4)
    }

    /// @notice Off-chain withdrawal proof for removing funds while channel is open
    struct WithdrawalProof {
        bytes32 channelId; /// Channel identifier
        address participant; /// Participant withdrawing funds
        uint256 withdrawnAmount; /// Cumulative amount withdrawn (monotonically increasing)
        uint256 nonce; /// Monotonically increasing state counter (prevents replay)
    }

    /// @notice Per-participant channel state
    struct ParticipantState {
        uint256 deposit; /// Total deposited by participant
        uint256 withdrawnAmount; /// Withdrawn during channel lifetime
        bool isCloser; /// True if this participant initiated close
        uint256 nonce; /// Monotonically increasing state counter
        uint256 transferredAmount; /// Cumulative amount sent to counterparty
    }

    /// @notice Channel metadata
    struct Channel {
        uint256 settlementTimeout; /// Challenge period duration in seconds
        ChannelState state; /// Current channel state
        uint256 closedAt; /// Block timestamp when channel closed
        uint256 openedAt; /// Block timestamp when channel opened
        address participant1; /// First channel participant
        address participant2; /// Second channel participant
    }

    /// @notice Mapping of channel IDs to channel data
    mapping(bytes32 => Channel) public channels;

    /// @notice Mapping of channel IDs and participant addresses to participant state
    mapping(bytes32 => mapping(address => ParticipantState)) public participants;

    /// @notice Thrown when participant address is invalid (zero address or same as caller)
    error InvalidParticipant();

    /// @notice Thrown when settlement timeout is below minimum
    error InvalidSettlementTimeout();

    /// @notice Thrown when channel already exists between participants
    error ChannelAlreadyExists();

    /// @notice Thrown when channel doesn't exist
    error ChannelDoesNotExist();

    /// @notice Thrown when operation not allowed in current channel state
    error InvalidChannelState();

    /// @notice Thrown when deposit amount validation fails
    error InsufficientDeposit();

    /// @notice Thrown when balance proof validation fails
    error InvalidBalanceProof();

    /// @notice Thrown when signature recovery fails or wrong signer
    error InvalidSignature();

    /// @notice Thrown when nonce not greater than stored nonce
    error InvalidNonce();

    /// @notice Thrown when updateNonClosingBalanceProof called by closer
    error CallerIsCloser();

    /// @notice Thrown when challenge period has ended
    error ChallengePeriodExpired();

    /// @notice Thrown when settlement called too early
    error SettlementTimeoutNotExpired();

    /// @notice Thrown when deposit exceeds maximum channel deposit limit
    error DepositLimitExceeded();

    /// @notice Thrown when attempting to force-close channel before expiry
    error ChannelNotExpired();

    /// @notice Thrown when cooperative settlement nonces don't match
    error NonceMismatch();

    /// @notice Thrown when withdrawal exceeds participant's deposit
    error WithdrawalExceedsDeposit();

    /// @notice Thrown when withdrawal amount is not increasing (must be cumulative)
    error WithdrawalNotIncreasing();

    /// @notice Thrown when emergency withdraw attempted but contract is not paused
    error ContractNotPaused();

    /// @notice Emitted when a new channel is opened
    /// @param channelId The unique channel identifier
    /// @param participant1 The first channel participant
    /// @param participant2 The second channel participant
    /// @param settlementTimeout The challenge period duration
    event ChannelOpened(
        bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout
    );

    /// @notice Emitted when a participant deposits tokens to a channel
    /// @param channelId The unique channel identifier
    /// @param participant The participant who deposited
    /// @param totalDeposit The new cumulative deposit amount
    event ChannelNewDeposit(bytes32 indexed channelId, address indexed participant, uint256 totalDeposit);

    /// @notice Emitted when a channel is closed
    /// @param channelId The unique channel identifier
    /// @param closingParticipant The participant who closed the channel
    /// @param nonce The nonce of the submitted balance proof
    /// @param balanceHash The hash of the balance proof data
    event ChannelClosed(
        bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce, bytes32 balanceHash
    );

    /// @notice Emitted when non-closing participant submits newer state during challenge
    /// @param channelId The unique channel identifier
    /// @param participant The non-closing participant who challenged
    /// @param nonce The nonce of the newer balance proof
    /// @param balanceHash The hash of the newer balance proof data
    event NonClosingBalanceProofUpdated(
        bytes32 indexed channelId, address indexed participant, uint256 nonce, bytes32 balanceHash
    );

    /// @notice Emitted when a channel is settled and funds distributed
    /// @param channelId The unique channel identifier
    /// @param participant1Amount The final amount transferred to participant1
    /// @param participant2Amount The final amount transferred to participant2
    event ChannelSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    /// @notice Emitted when channel is force-closed after expiry
    /// @param channelId The unique channel identifier
    /// @param timestamp Block timestamp when force-closed
    event ChannelClosedByExpiry(bytes32 indexed channelId, uint256 timestamp);

    /// @notice Emitted when channel is cooperatively settled with mutual consent
    /// @param channelId The unique channel identifier
    /// @param participant1Amount Final amount transferred to participant1
    /// @param participant2Amount Final amount transferred to participant2
    event ChannelCooperativeSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount);

    /// @notice Emitted when tokens are withdrawn from an open channel
    /// @param channelId The unique channel identifier
    /// @param participant The participant withdrawing funds
    /// @param amount The amount withdrawn in this transaction
    /// @param totalWithdrawn The cumulative withdrawn amount
    event ChannelWithdrawal(bytes32 indexed channelId, address indexed participant, uint256 amount, uint256 totalWithdrawn);

    /// @notice Emitted when owner performs emergency token recovery
    /// @param channelId The channel identifier (if applicable)
    /// @param recipient The address receiving the recovered tokens
    /// @param amount The amount of tokens recovered
    event EmergencyWithdrawal(bytes32 indexed channelId, address indexed recipient, uint256 amount);

    /// @notice Deploy a new TokenNetwork for a specific token
    /// @param _token The ERC20 token address
    /// @param _maxChannelDeposit Maximum deposit per participant per channel (default: 1M tokens scaled by decimals)
    /// @param _maxChannelLifetime Maximum channel lifetime before force-close allowed (default: 365 days)
    constructor(address _token, uint256 _maxChannelDeposit, uint256 _maxChannelLifetime) EIP712("TokenNetwork", "1") Ownable(msg.sender) {
        token = _token;
        maxChannelDeposit = _maxChannelDeposit;
        maxChannelLifetime = _maxChannelLifetime;
    }

    /// @notice Open a new payment channel with another participant
    /// @param participant2 The address of the other channel participant
    /// @param settlementTimeout The challenge period duration in seconds (minimum 1 hour)
    /// @return channelId The unique identifier for the created channel
    /// @dev Computes channelId as keccak256(p1, p2, channelCounter). Emits ChannelOpened event.
    function openChannel(address participant2, uint256 settlementTimeout) external nonReentrant whenNotPaused returns (bytes32) {
        // Validate participants
        if (participant2 == address(0)) revert InvalidParticipant();
        if (msg.sender == participant2) revert InvalidParticipant();

        // Validate settlement timeout
        if (settlementTimeout < MIN_SETTLEMENT_TIMEOUT) revert InvalidSettlementTimeout();

        // Normalize participant order (p1 < p2 lexicographically)
        (address p1, address p2) = msg.sender < participant2 ? (msg.sender, participant2) : (participant2, msg.sender);

        // Compute unique channel ID
        bytes32 channelId = keccak256(abi.encodePacked(p1, p2, channelCounter));
        channelCounter++;

        // Check channel doesn't already exist
        if (channels[channelId].state != ChannelState.NonExistent) revert ChannelAlreadyExists();

        // Initialize channel state
        channels[channelId] = Channel({
            settlementTimeout: settlementTimeout,
            state: ChannelState.Opened,
            closedAt: 0,
            openedAt: block.timestamp,
            participant1: p1,
            participant2: p2
        });

        // Emit event
        emit ChannelOpened(channelId, p1, p2, settlementTimeout);

        return channelId;
    }

    /// @notice Deposit tokens to a channel
    /// @param channelId The unique channel identifier
    /// @param participant The participant whose deposit is being increased
    /// @param totalDeposit The new cumulative deposit amount (not incremental)
    /// @dev Uses SafeERC20 for token transfers. Handles fee-on-transfer tokens by measuring actual balance changes.
    function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit) external nonReentrant whenNotPaused {
        // Validate channel exists and is open
        Channel storage channel = channels[channelId];
        if (channel.state != ChannelState.Opened) revert InvalidChannelState();

        // Validate participant
        if (participant != channel.participant1 && participant != channel.participant2) {
            revert InvalidParticipant();
        }

        // Calculate incremental deposit amount
        uint256 currentDeposit = participants[channelId][participant].deposit;
        if (totalDeposit < currentDeposit) revert InsufficientDeposit();
        uint256 depositAmount = totalDeposit - currentDeposit;

        // Transfer tokens using SafeERC20 and measure actual balance change
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), depositAmount);
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        uint256 actualReceived = balanceAfter - balanceBefore;

        // Validate deposit limit
        uint256 newDeposit = currentDeposit + actualReceived;
        if (newDeposit > maxChannelDeposit) revert DepositLimitExceeded();

        // Update participant deposit state
        participants[channelId][participant].deposit = newDeposit;

        // Emit event
        emit ChannelNewDeposit(channelId, participant, participants[channelId][participant].deposit);
    }

    /// @notice Close a payment channel with a balance proof from the counterparty
    /// @param channelId The unique identifier for the channel
    /// @param balanceProof The off-chain balance proof signed by the non-closing participant
    /// @param signature The EIP-712 signature of the balance proof
    /// @dev Validates signature using EIP-712, records closer, starts challenge period
    function closeChannel(bytes32 channelId, BalanceProof memory balanceProof, bytes memory signature)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel exists and is open
        Channel storage channel = channels[channelId];
        if (channel.state != ChannelState.Opened) revert InvalidChannelState();

        // Validate caller is a participant
        if (msg.sender != channel.participant1 && msg.sender != channel.participant2) {
            revert InvalidParticipant();
        }

        // Identify non-closing participant
        address nonClosingParticipant = msg.sender == channel.participant1 ? channel.participant2 : channel.participant1;

        // Validate balance proof channelId matches
        if (balanceProof.channelId != channelId) revert InvalidBalanceProof();

        // Compute EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                BALANCE_PROOF_TYPEHASH,
                balanceProof.channelId,
                balanceProof.nonce,
                balanceProof.transferredAmount,
                balanceProof.lockedAmount,
                balanceProof.locksRoot
            )
        );

        // Compute EIP-712 digest
        bytes32 digest = _hashTypedDataV4(structHash);

        // Recover signer from signature
        address recovered = ECDSA.recover(digest, signature);

        // Validate signer is non-closing participant
        if (recovered != nonClosingParticipant) revert InvalidSignature();

        // Validate nonce is greater than stored nonce
        uint256 storedNonce = participants[channelId][nonClosingParticipant].nonce;
        if (balanceProof.nonce <= storedNonce) revert InvalidNonce();

        // Record closing participant
        participants[channelId][msg.sender].isCloser = true;

        // Update non-closing participant state
        participants[channelId][nonClosingParticipant].nonce = balanceProof.nonce;
        participants[channelId][nonClosingParticipant].transferredAmount = balanceProof.transferredAmount;

        // Compute balance hash for event
        bytes32 balanceHash = keccak256(
            abi.encodePacked(balanceProof.transferredAmount, balanceProof.lockedAmount, balanceProof.locksRoot)
        );

        // Update channel state to Closed and record timestamp
        channel.state = ChannelState.Closed;
        channel.closedAt = block.timestamp;

        // Emit event
        emit ChannelClosed(channelId, msg.sender, balanceProof.nonce, balanceHash);
    }

    /// @notice Update balance proof during challenge period (non-closing participant only)
    /// @param channelId The unique identifier for the channel
    /// @param balanceProof The newer off-chain balance proof signed by the closing participant
    /// @param signature The EIP-712 signature of the balance proof
    /// @dev Allows non-closing participant to submit newer state during challenge period
    function updateNonClosingBalanceProof(bytes32 channelId, BalanceProof memory balanceProof, bytes memory signature)
        external
        nonReentrant
        whenNotPaused
    {
        // Validate channel is in Closed state
        Channel storage channel = channels[channelId];
        if (channel.state != ChannelState.Closed) revert InvalidChannelState();

        // Validate caller is non-closing participant
        if (participants[channelId][msg.sender].isCloser) revert CallerIsCloser();
        if (msg.sender != channel.participant1 && msg.sender != channel.participant2) {
            revert InvalidParticipant();
        }

        // Validate challenge period has not expired
        if (block.timestamp >= channel.closedAt + channel.settlementTimeout) {
            revert ChallengePeriodExpired();
        }

        // Identify closing participant
        address closingParticipant =
            participants[channelId][channel.participant1].isCloser ? channel.participant1 : channel.participant2;

        // Validate balance proof channelId matches
        if (balanceProof.channelId != channelId) revert InvalidBalanceProof();

        // Compute EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                BALANCE_PROOF_TYPEHASH,
                balanceProof.channelId,
                balanceProof.nonce,
                balanceProof.transferredAmount,
                balanceProof.lockedAmount,
                balanceProof.locksRoot
            )
        );

        // Compute EIP-712 digest
        bytes32 digest = _hashTypedDataV4(structHash);

        // Recover signer from signature
        address recovered = ECDSA.recover(digest, signature);

        // Validate signer is closing participant
        if (recovered != closingParticipant) revert InvalidSignature();

        // Validate nonce is strictly greater than stored nonce
        uint256 storedNonce = participants[channelId][closingParticipant].nonce;
        if (balanceProof.nonce <= storedNonce) revert InvalidNonce();

        // Update closing participant state with newer balance proof
        participants[channelId][closingParticipant].nonce = balanceProof.nonce;
        participants[channelId][closingParticipant].transferredAmount = balanceProof.transferredAmount;

        // Compute balance hash for event
        bytes32 balanceHash = keccak256(
            abi.encodePacked(balanceProof.transferredAmount, balanceProof.lockedAmount, balanceProof.locksRoot)
        );

        // Emit event
        emit NonClosingBalanceProofUpdated(channelId, msg.sender, balanceProof.nonce, balanceHash);
    }

    /// @notice Settle a channel and distribute final balances after challenge period
    /// @param channelId The unique identifier for the channel
    /// @dev Anyone can call this function after challenge period expires
    function settleChannel(bytes32 channelId) external nonReentrant whenNotPaused {
        // Validate channel is in Closed state
        Channel storage channel = channels[channelId];
        if (channel.state != ChannelState.Closed) revert InvalidChannelState();

        // Validate challenge period has expired
        if (block.timestamp < channel.closedAt + channel.settlementTimeout) {
            revert SettlementTimeoutNotExpired();
        }

        // Calculate final balances for both participants
        uint256 participant1Deposit = participants[channelId][channel.participant1].deposit;
        uint256 participant1Withdrawn = participants[channelId][channel.participant1].withdrawnAmount;
        uint256 participant1Transferred = participants[channelId][channel.participant1].transferredAmount;
        uint256 participant2Transferred = participants[channelId][channel.participant2].transferredAmount;

        uint256 participant2Deposit = participants[channelId][channel.participant2].deposit;
        uint256 participant2Withdrawn = participants[channelId][channel.participant2].withdrawnAmount;

        // Participant 1 final balance: deposit - withdrawn - transferred_to_p2 + received_from_p2
        uint256 participant1FinalBalance =
            participant1Deposit - participant1Withdrawn - participant1Transferred + participant2Transferred;

        // Participant 2 final balance: deposit - withdrawn - transferred_to_p1 + received_from_p1
        uint256 participant2FinalBalance =
            participant2Deposit - participant2Withdrawn - participant2Transferred + participant1Transferred;

        // Update channel state to Settled
        channel.state = ChannelState.Settled;

        // Transfer tokens to both participants using SafeERC20
        if (participant1FinalBalance > 0) {
            IERC20(token).safeTransfer(channel.participant1, participant1FinalBalance);
        }

        if (participant2FinalBalance > 0) {
            IERC20(token).safeTransfer(channel.participant2, participant2FinalBalance);
        }

        // Emit event
        emit ChannelSettled(channelId, participant1FinalBalance, participant2FinalBalance);
    }

    /// @notice Force-close channel after maximum lifetime expires
    /// @param channelId The unique channel identifier
    /// @dev Anyone can call after channel expires. Uses deposit amounts as final balances.
    function forceCloseExpiredChannel(bytes32 channelId) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];

        // Validate channel is open
        if (channel.state != ChannelState.Opened) revert InvalidChannelState();

        // Validate channel has expired
        if (block.timestamp < channel.openedAt + maxChannelLifetime) {
            revert ChannelNotExpired();
        }

        // Close channel without balance proof (use deposits as final state)
        channel.state = ChannelState.Closed;
        channel.closedAt = block.timestamp;

        // Emit event
        emit ChannelClosedByExpiry(channelId, block.timestamp);
    }

    /// @notice Cooperatively settle channel with mutual consent (bypasses challenge period)
    /// @param channelId The unique channel identifier
    /// @param proof1 Balance proof from participant1
    /// @param sig1 Signature from participant1
    /// @param proof2 Balance proof from participant2
    /// @param sig2 Signature from participant2
    /// @dev Both participants must sign identical final state (same nonce)
    function cooperativeSettle(
        bytes32 channelId,
        BalanceProof memory proof1,
        bytes memory sig1,
        BalanceProof memory proof2,
        bytes memory sig2
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];

        // Validate channel is open
        if (channel.state != ChannelState.Opened) revert InvalidChannelState();

        // Validate channel IDs match
        if (proof1.channelId != channelId || proof2.channelId != channelId) {
            revert InvalidBalanceProof();
        }

        // Validate nonces match (both participants agree on final state)
        if (proof1.nonce != proof2.nonce) revert NonceMismatch();

        // Verify signatures - determine which participant signed which proof
        bytes32 structHash1 = keccak256(
            abi.encode(
                BALANCE_PROOF_TYPEHASH,
                proof1.channelId,
                proof1.nonce,
                proof1.transferredAmount,
                proof1.lockedAmount,
                proof1.locksRoot
            )
        );
        address signer1 = ECDSA.recover(_hashTypedDataV4(structHash1), sig1);

        bytes32 structHash2 = keccak256(
            abi.encode(
                BALANCE_PROOF_TYPEHASH,
                proof2.channelId,
                proof2.nonce,
                proof2.transferredAmount,
                proof2.lockedAmount,
                proof2.locksRoot
            )
        );
        address signer2 = ECDSA.recover(_hashTypedDataV4(structHash2), sig2);

        // Verify both participants signed (order doesn't matter)
        bool signer1IsParticipant1 = signer1 == channel.participant1;
        bool signer1IsParticipant2 = signer1 == channel.participant2;
        bool signer2IsParticipant1 = signer2 == channel.participant1;
        bool signer2IsParticipant2 = signer2 == channel.participant2;

        // One signer must be participant1, other must be participant2
        bool validSignatures = (signer1IsParticipant1 && signer2IsParticipant2) ||
                               (signer1IsParticipant2 && signer2IsParticipant1);
        if (!validSignatures) revert InvalidSignature();

        // Calculate final balances based on who signed what
        uint256 participant1Deposit = participants[channelId][channel.participant1].deposit;
        uint256 participant1Withdrawn = participants[channelId][channel.participant1].withdrawnAmount;
        uint256 participant2Deposit = participants[channelId][channel.participant2].deposit;
        uint256 participant2Withdrawn = participants[channelId][channel.participant2].withdrawnAmount;

        // Determine which proof is from which participant
        uint256 participant1Sent;
        uint256 participant2Sent;

        if (signer1IsParticipant1) {
            // proof1 from participant1, proof2 from participant2
            participant1Sent = proof1.transferredAmount;
            participant2Sent = proof2.transferredAmount;
        } else {
            // proof1 from participant2, proof2 from participant1
            participant1Sent = proof2.transferredAmount;
            participant2Sent = proof1.transferredAmount;
        }

        // Participant1 final = deposit - withdrawn - sent + received
        uint256 participant1Final = participant1Deposit - participant1Withdrawn - participant1Sent + participant2Sent;
        // Participant2 final = deposit - withdrawn - sent + received
        uint256 participant2Final = participant2Deposit - participant2Withdrawn - participant2Sent + participant1Sent;

        // Update channel state to Settled (skip Closed state)
        channel.state = ChannelState.Settled;

        // Transfer tokens to both participants
        if (participant1Final > 0) {
            IERC20(token).safeTransfer(channel.participant1, participant1Final);
        }

        if (participant2Final > 0) {
            IERC20(token).safeTransfer(channel.participant2, participant2Final);
        }

        // Emit event
        emit ChannelCooperativeSettled(channelId, participant1Final, participant2Final);
    }

    /// @notice Withdraw funds from an open channel with counterparty consent
    /// @param channelId The unique channel identifier
    /// @param withdrawnAmount Cumulative total amount withdrawn (monotonically increasing)
    /// @param nonce Monotonically increasing state counter (prevents replay)
    /// @param counterpartySignature Signature from counterparty approving withdrawal
    /// @dev Requires counterparty signature, allows removing funds while channel remains open
    function withdraw(
        bytes32 channelId,
        uint256 withdrawnAmount,
        uint256 nonce,
        bytes memory counterpartySignature
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];

        // Validate channel is open
        if (channel.state != ChannelState.Opened) revert InvalidChannelState();

        // Validate caller is a participant
        if (msg.sender != channel.participant1 && msg.sender != channel.participant2) {
            revert InvalidParticipant();
        }

        // Determine counterparty
        address counterparty = msg.sender == channel.participant1 ? channel.participant2 : channel.participant1;

        // Create withdrawal proof struct
        WithdrawalProof memory proof = WithdrawalProof({
            channelId: channelId,
            participant: msg.sender,
            withdrawnAmount: withdrawnAmount,
            nonce: nonce
        });

        // Verify counterparty signature
        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_PROOF_TYPEHASH,
                proof.channelId,
                proof.participant,
                proof.withdrawnAmount,
                proof.nonce
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), counterpartySignature);
        if (signer != counterparty) revert InvalidSignature();

        // Get participant state
        ParticipantState storage participantState = participants[channelId][msg.sender];

        // Validate nonce is increasing (prevents replay)
        if (nonce <= participantState.nonce) revert InvalidNonce();

        // Validate withdrawn amount is increasing (cumulative)
        if (withdrawnAmount <= participantState.withdrawnAmount) {
            revert WithdrawalNotIncreasing();
        }

        // Validate withdrawn amount doesn't exceed deposit
        if (withdrawnAmount > participantState.deposit) {
            revert WithdrawalExceedsDeposit();
        }

        // Calculate actual withdrawal amount for this transaction
        uint256 toWithdraw = withdrawnAmount - participantState.withdrawnAmount;

        // Transfer tokens to participant
        IERC20(token).safeTransfer(msg.sender, toWithdraw);

        // Update participant state
        participantState.withdrawnAmount = withdrawnAmount;
        participantState.nonce = nonce;

        // Emit event
        emit ChannelWithdrawal(channelId, msg.sender, toWithdraw, withdrawnAmount);
    }

    /// @notice Emergency token recovery for stuck funds (owner only, contract must be paused)
    /// @param channelId The channel identifier (if applicable, use bytes32(0) for general recovery)
    /// @param recipient The address to receive the recovered tokens
    /// @dev Only allowed when contract is paused. Last resort for invalid state recovery.
    function emergencyWithdraw(bytes32 channelId, address recipient) external onlyOwner {
        // Validate contract is paused (emergency situation only)
        if (!paused()) revert ContractNotPaused();

        // Calculate locked tokens in contract
        uint256 lockedAmount = IERC20(token).balanceOf(address(this));

        // Transfer all locked tokens to recipient
        IERC20(token).safeTransfer(recipient, lockedAmount);

        // Emit event for transparency
        emit EmergencyWithdrawal(channelId, recipient, lockedAmount);
    }

    /// @notice Pause all channel operations in emergency
    /// @dev Only owner can pause, emits Paused event
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume all channel operations after emergency
    /// @dev Only owner can unpause, emits Unpaused event
    function unpause() external onlyOwner {
        _unpause();
    }
}
