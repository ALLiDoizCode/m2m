// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./TokenNetwork.sol";

/// @title TokenNetworkRegistry
/// @notice Factory contract for deploying isolated TokenNetwork contracts per ERC20 token
/// @dev Follows Raiden Network architecture pattern for multi-token payment channels
/// @dev Provides security isolation between different token types
contract TokenNetworkRegistry is Ownable, Pausable {
    /// @notice Mapping from ERC20 token address to TokenNetwork contract address
    mapping(address => address) public token_to_token_networks;

    /// @notice Mapping from TokenNetwork contract address to ERC20 token address
    /// @dev Provides reverse lookup for TokenNetwork contracts
    mapping(address => address) public token_network_to_token;

    /// @notice Mapping from token address to whitelist status
    mapping(address => bool) public whitelistedTokens;

    /// @notice Whether whitelist is enabled (default: false for permissionless deployment)
    bool public whitelistEnabled;

    /// @notice Thrown when attempting to create a TokenNetwork for a token that already has one
    /// @param token The token address that triggered the error
    error TokenNetworkAlreadyExists(address token);

    /// @notice Thrown when attempting to create a TokenNetwork with zero address
    error InvalidTokenAddress();

    /// @notice Thrown when TokenNetwork deployment fails
    error TokenNetworkCreationFailed();

    /// @notice Thrown when token not in whitelist
    error TokenNotWhitelisted();

    /// @notice Emitted when a new TokenNetwork is created
    /// @param token The ERC20 token address
    /// @param tokenNetwork The deployed TokenNetwork contract address
    event TokenNetworkCreated(address indexed token, address indexed tokenNetwork);

    /// @notice Emitted when whitelist is enabled
    event WhitelistEnabled();

    /// @notice Emitted when whitelist is disabled
    event WhitelistDisabled();

    /// @notice Emitted when a token is added to whitelist
    /// @param token The token address
    event TokenWhitelisted(address indexed token);

    /// @notice Emitted when a token is removed from whitelist
    /// @param token The token address
    event TokenRemovedFromWhitelist(address indexed token);

    /// @notice Deploy a new TokenNetworkRegistry
    /// @dev Sets the deployer as the initial owner
    constructor() Ownable(msg.sender) {}

    /// @notice Create a new TokenNetwork contract for an ERC20 token
    /// @param token The address of the ERC20 token
    /// @return The address of the deployed TokenNetwork contract
    /// @dev Reverts if token is zero address or TokenNetwork already exists
    function createTokenNetwork(address token) external whenNotPaused returns (address) {
        // Validate token address is not zero
        if (token == address(0)) revert InvalidTokenAddress();

        // Validate token is whitelisted if whitelist is enabled
        if (whitelistEnabled && !whitelistedTokens[token]) {
            revert TokenNotWhitelisted();
        }

        // Check for duplicate TokenNetwork
        if (token_to_token_networks[token] != address(0)) {
            revert TokenNetworkAlreadyExists(token);
        }

        // Deploy new TokenNetwork contract with default 1M token deposit limit and 365 day lifetime
        TokenNetwork tokenNetwork = new TokenNetwork(token, 1_000_000 * 10 ** 18, 365 days);
        address tokenNetworkAddress = address(tokenNetwork);

        // Validate deployment succeeded
        if (tokenNetworkAddress == address(0)) revert TokenNetworkCreationFailed();

        // Store in mappings
        token_to_token_networks[token] = tokenNetworkAddress;
        token_network_to_token[tokenNetworkAddress] = token;

        // Emit event
        emit TokenNetworkCreated(token, tokenNetworkAddress);

        // Return address
        return tokenNetworkAddress;
    }

    /// @notice Get the TokenNetwork contract address for a token
    /// @param token The ERC20 token address
    /// @return The TokenNetwork contract address, or address(0) if doesn't exist
    function getTokenNetwork(address token) external view returns (address) {
        return token_to_token_networks[token];
    }

    /// @notice Enable token whitelist (restricts to approved tokens only)
    /// @dev Only owner can enable whitelist
    function enableWhitelist() external onlyOwner {
        whitelistEnabled = true;
        emit WhitelistEnabled();
    }

    /// @notice Disable token whitelist (allows all tokens)
    /// @dev Only owner can disable whitelist
    function disableWhitelist() external onlyOwner {
        whitelistEnabled = false;
        emit WhitelistDisabled();
    }

    /// @notice Add token to whitelist
    /// @param token The token address to whitelist
    /// @dev Only owner can add tokens to whitelist
    function addTokenToWhitelist(address token) external onlyOwner {
        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token);
    }

    /// @notice Remove token from whitelist
    /// @param token The token address to remove from whitelist
    /// @dev Only owner can remove tokens from whitelist
    function removeTokenFromWhitelist(address token) external onlyOwner {
        whitelistedTokens[token] = false;
        emit TokenRemovedFromWhitelist(token);
    }

    /// @notice Pause all TokenNetwork creation in emergency
    /// @dev Only owner can pause, emits Paused event
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume TokenNetwork creation after emergency
    /// @dev Only owner can unpause, emits Unpaused event
    function unpause() external onlyOwner {
        _unpause();
    }
}
