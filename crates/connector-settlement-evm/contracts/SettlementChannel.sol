// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SettlementChannel
/// @notice Minimal native-ETH payment channel backing the Rust connector's
/// EVM `SettlementBackend` (issue #459, ADR 0002). Deliberately carries no
/// `lockedAmount`/`locksRoot` fields (ADR 0004 -- both were always zero on
/// the legacy TokenNetwork contract and are not reintroduced here).
/// @dev Claim authenticity is a peer-wire concern the SettlementBackend
/// port itself declines to specify (crates/connector-settlement/src/port.rs
/// -- "this port does not verify a claim"); this contract enforces exactly
/// what the port's own contract suite requires -- monotonic redemption,
/// bounded by what was deposited, terminal once closed -- and stores a
/// claim's signature only as an opaque audit trail on the `ChannelRedeemed`
/// event, not as something it cryptographically checks.
///
/// A channel's counterparty is recorded twice, deliberately: `counterparty`
/// is an opaque identifier (the port's own `open` takes `Vec<u8>`, not
/// necessarily a 20-byte address -- its own contract suite opens a channel
/// to plain ASCII peer names) reported back unchanged by `channelState`,
/// while `payoutAddress` is the real EVM address `redeem` actually pays --
/// derived off-chain from `counterparty` by the caller (see
/// `connector-settlement-evm`'s `counterparty_address`) since this contract
/// has no opinion on how that derivation works.
contract SettlementChannel {
    enum Status {
        Open,
        Closed
    }

    struct Channel {
        address payer;
        bytes counterparty;
        address payoutAddress;
        uint256 settlementTimeout;
        uint256 deposited;
        uint256 redeemed;
        Status status;
    }

    uint256 public channelCounter;
    mapping(uint256 => Channel) private channels;

    event ChannelOpened(
        uint256 indexed channelId, address indexed payer, address indexed payoutAddress, uint256 settlementTimeout
    );
    event ChannelFunded(uint256 indexed channelId, uint256 amount, uint256 totalDeposited);
    event ChannelRedeemed(uint256 indexed channelId, uint256 cumulativeAmount, bytes signature);
    event ChannelClosed(uint256 indexed channelId);

    error ChannelNotFound(uint256 channelId);
    error ChannelAlreadyClosed(uint256 channelId);
    error StaleClaim(uint256 claimed, uint256 alreadyRedeemed);
    error InsufficientChannelBalance(uint256 requested, uint256 deposited);
    error SettlementTransferFailed(uint256 channelId);

    /// @notice Open a new channel from the caller to `counterparty`
    /// (paid out to `payoutAddress` on redemption), open and unfunded.
    /// `settlementTimeout` is recorded but not otherwise enforced by this
    /// contract -- there is no on-chain challenge period here, since the
    /// port's own `close` is already terminal (no intermediate "closed,
    /// awaiting settlement" state).
    function open(bytes calldata counterparty, address payoutAddress, uint256 settlementTimeout)
        external
        returns (uint256 channelId)
    {
        channelId = channelCounter++;
        channels[channelId] = Channel({
            payer: msg.sender,
            counterparty: counterparty,
            payoutAddress: payoutAddress,
            settlementTimeout: settlementTimeout,
            deposited: 0,
            redeemed: 0,
            status: Status.Open
        });
        emit ChannelOpened(channelId, msg.sender, payoutAddress, settlementTimeout);
    }

    /// @notice Deposit `msg.value` into `channelId`, increasing its
    /// cumulative deposited total.
    function fund(uint256 channelId) external payable {
        Channel storage channel = _open(channelId);
        channel.deposited += msg.value;
        emit ChannelFunded(channelId, msg.value, channel.deposited);
    }

    /// @notice Redeem a claim: the channel's honored total becomes
    /// `cumulativeAmount`, and the newly-owed delta is paid to
    /// `payoutAddress` immediately. Rejects a claim that does not
    /// supersede the highest one redeemed so far, or that exceeds what has
    /// been deposited.
    function redeem(uint256 channelId, uint256 cumulativeAmount, bytes calldata signature) external {
        Channel storage channel = _open(channelId);
        if (cumulativeAmount <= channel.redeemed) {
            revert StaleClaim(cumulativeAmount, channel.redeemed);
        }
        if (cumulativeAmount > channel.deposited) {
            revert InsufficientChannelBalance(cumulativeAmount, channel.deposited);
        }

        uint256 delta = cumulativeAmount - channel.redeemed;
        channel.redeemed = cumulativeAmount;
        emit ChannelRedeemed(channelId, cumulativeAmount, signature);

        (bool ok,) = channel.payoutAddress.call{value: delta}("");
        if (!ok) revert SettlementTransferFailed(channelId);
    }

    /// @notice Close a channel. Terminal: no further funding or redemption
    /// is possible against it afterward, and it cannot be closed again.
    function close(uint256 channelId) external {
        Channel storage channel = _open(channelId);
        channel.status = Status.Closed;
        emit ChannelClosed(channelId);
    }

    /// @notice A channel's current state, as this contract records it.
    function channelState(uint256 channelId)
        external
        view
        returns (
            address payer,
            bytes memory counterparty,
            address payoutAddress,
            uint256 settlementTimeout,
            uint256 deposited,
            uint256 redeemed,
            Status status
        )
    {
        Channel storage channel = _existing(channelId);
        return (
            channel.payer,
            channel.counterparty,
            channel.payoutAddress,
            channel.settlementTimeout,
            channel.deposited,
            channel.redeemed,
            channel.status
        );
    }

    function _existing(uint256 channelId) internal view returns (Channel storage channel) {
        channel = channels[channelId];
        if (channel.payer == address(0)) revert ChannelNotFound(channelId);
    }

    function _open(uint256 channelId) internal view returns (Channel storage channel) {
        channel = _existing(channelId);
        if (channel.status != Status.Open) revert ChannelAlreadyClosed(channelId);
    }
}
