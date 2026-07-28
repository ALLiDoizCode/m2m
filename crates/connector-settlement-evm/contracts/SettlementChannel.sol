// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ⚠️ DO NOT DEPLOY ⚠️ (issue #568)
///
/// This contract must never be deployed against a chain that holds real
/// value. Concretely:
///
///   - `redeem` never verifies the signature it is given. It accepts
///     `bytes` of any shape, logs them on `ChannelRedeemed` as an opaque
///     audit trail, and does nothing else with them -- there is no
///     `ecrecover`/EIP-712 check anywhere in this file. Any address can
///     call `redeem(channelId, <deposited>, "")` on a funded channel and
///     send the whole balance to `payoutAddress`.
///   - `close` has no access control. Any address can close any channel.
///   - There is no refund path. `redeem` is the only exit `fund` pairs
///     with; anything deposited and never redeemed is stranded forever.
///
/// This is not a latent bug -- the contract's own header below says claim
/// authenticity is out of scope for it by design. It just means the
/// contract must hold nothing. Issue #566 replaces it with a real,
/// signature-verifying `TokenNetwork` and deletes this file entirely.
///
/// The constructor below reverts unless given `DEPLOYMENT_ACKNOWLEDGEMENT`
/// exactly, so that deploying this contract without having read this
/// warning fails the deployment itself rather than merely logging or
/// commenting around the danger. See that constant's own doc comment.
///
/// @dev The subset of ERC-20 this contract needs to pull deposits in and
/// pay redemptions out. Hand-rolled rather than pulled from a library
/// dependency, matching this contract's own "minimal" charter and
/// `packages/contracts/test/mocks/MockERC20.sol`'s precedent for this
/// workspace.
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title SettlementChannel
/// @notice Minimal ERC-20 payment channel backing the Rust connector's EVM
/// `SettlementBackend` (issue #459, ADR 0002; issue #542 moved this from
/// native ETH to a configured ERC-20 so the Rust fleet settles the same
/// 6-decimal USDC the TypeScript fleet does). Deliberately carries no
/// `lockedAmount`/`locksRoot` fields (ADR 0004 -- both were always zero on
/// the legacy TokenNetwork contract and are not reintroduced here).
///
/// DO NOT DEPLOY THIS CONTRACT -- see the file-level warning above. It
/// redeems on an unverified signature, closes with no access control, and
/// has no refund path; issue #566 deletes it once its replacement lands.
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

    /// @notice The ERC-20 token every channel this contract manages is
    /// denominated in -- one deployment, one asset, fixed at construction
    /// (issue #542). A deployer wanting a different asset deploys another
    /// instance rather than reconfiguring this one.
    IERC20 public immutable token;

    uint256 public channelCounter;
    mapping(uint256 => Channel) private channels;

    /// @notice The value the constructor's `acknowledgement` parameter
    /// must equal, or deployment reverts with `NotForDeployment` -- see
    /// the file-level DO NOT DEPLOY block above (issue #568). Not a
    /// secret: it is the hash of a public string, derivable by anyone who
    /// reads this source. Its only purpose is turning an accidental
    /// deployment (a `forge create`, or any tooling that does not pass
    /// this exact value on purpose) into a loud revert instead of a
    /// silent success placing an unsafe contract on a live chain. This
    /// crate's own tests and local `anvil` tooling are the only
    /// legitimate callers, and pass it automatically
    /// (`EvmSettlementBackend::deploy`).
    bytes32 public constant DEPLOYMENT_ACKNOWLEDGEMENT =
        keccak256("SettlementChannel is UNSAFE and test-only -- see issue #568 DO NOT DEPLOY");

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
    /// @notice Thrown by the constructor when `acknowledgement` does not
    /// equal `DEPLOYMENT_ACKNOWLEDGEMENT` -- see the file-level DO NOT
    /// DEPLOY block above (issue #568).
    error NotForDeployment();

    /// @param _token The ERC-20 contract every channel here settles in.
    /// @param acknowledgement Must equal `DEPLOYMENT_ACKNOWLEDGEMENT`
    /// exactly, or this reverts with `NotForDeployment` -- see the
    /// file-level DO NOT DEPLOY block above and that constant's own doc
    /// comment.
    constructor(address _token, bytes32 acknowledgement) {
        if (acknowledgement != DEPLOYMENT_ACKNOWLEDGEMENT) {
            revert NotForDeployment();
        }
        token = IERC20(_token);
    }

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

    /// @notice Pull `amount` of `token` from the caller into `channelId`,
    /// increasing its cumulative deposited total. The caller must have
    /// approved this contract for at least `amount` beforehand -- this is
    /// the ERC-20 approve-then-fund two-transaction sequence, replacing
    /// what a single `payable` call did when this contract settled native
    /// ETH (issue #542).
    function fund(uint256 channelId, uint256 amount) external {
        Channel storage channel = _open(channelId);
        bool ok = token.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert SettlementTransferFailed(channelId);
        channel.deposited += amount;
        emit ChannelFunded(channelId, amount, channel.deposited);
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

        bool ok = token.transfer(channel.payoutAddress, delta);
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
