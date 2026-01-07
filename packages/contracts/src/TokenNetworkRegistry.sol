// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./TokenNetwork.sol";

/**
 * @title TokenNetworkRegistry
 * @notice Factory contract that creates isolated TokenNetwork contracts per ERC20 token
 * @dev Implements the factory pattern for deploying TokenNetwork instances with security isolation.
 *      Each ERC20 token can have only one TokenNetwork to prevent fragmentation and ensure consistency.
 *      Follows the Raiden Network's proven architecture pattern.
 */
contract TokenNetworkRegistry is Ownable {
    /// @notice Mapping from ERC20 token address to its TokenNetwork contract address
    mapping(address => address) public token_to_token_networks;

    /// @notice Reverse mapping from TokenNetwork contract address to ERC20 token address
    mapping(address => address) public token_network_to_token;

    /// @notice Optional token whitelist - if enabled, only whitelisted tokens can create networks
    mapping(address => bool) public allowedTokens;

    /// @notice Flag to enable/disable whitelist enforcement (false by default - all tokens allowed)
    bool public whitelistEnabled;

    /**
     * @notice Emitted when a new TokenNetwork is created for an ERC20 token
     * @param token The address of the ERC20 token
     * @param tokenNetwork The address of the deployed TokenNetwork contract
     */
    event TokenNetworkCreated(address indexed token, address indexed tokenNetwork);

    /**
     * @notice Emitted when a token is added to the whitelist
     * @param token The address of the whitelisted token
     */
    event TokenWhitelisted(address indexed token);

    /**
     * @notice Emitted when a token is removed from the whitelist
     * @param token The address of the token removed from whitelist
     */
    event TokenRemovedFromWhitelist(address indexed token);

    /**
     * @notice Emitted when whitelist enforcement is enabled or disabled
     * @param enabled True if whitelist is enabled, false otherwise
     */
    event WhitelistStatusChanged(bool enabled);

    /**
     * @notice Error thrown when attempting to create a duplicate TokenNetwork for a token
     * @param token The address of the token that already has a TokenNetwork
     */
    error TokenNetworkAlreadyExists(address token);

    /**
     * @notice Error thrown when an invalid token address is provided
     * @dev This includes zero address or non-ERC20 compliant contracts
     */
    error InvalidTokenAddress();

    /**
     * @notice Error thrown when attempting to create a TokenNetwork for a non-whitelisted token
     * @param token The address of the token that is not whitelisted
     */
    error TokenNotWhitelisted(address token);

    /**
     * @notice Initializes the TokenNetworkRegistry with ownership control
     * @dev Calls Ownable constructor with msg.sender as the initial owner (OpenZeppelin v5.x requirement)
     */
    constructor() Ownable(msg.sender) {}

    /**
     * @notice Creates a new TokenNetwork contract for an ERC20 token
     * @dev Validates token address, checks for duplicates, verifies ERC20 compliance,
     *      deploys TokenNetwork, and maintains bidirectional mappings.
     * @param token The address of the ERC20 token for which to create a TokenNetwork
     * @return The address of the newly deployed TokenNetwork contract
     *
     * Requirements:
     * - token must not be the zero address
     * - token must not already have a TokenNetwork
     * - token must be a valid ERC20 contract (implements totalSupply())
     * - if whitelist is enabled, token must be whitelisted
     *
     * Emits a {TokenNetworkCreated} event upon successful creation
     */
    function createTokenNetwork(address token) external returns (address) {
        // Validate token address is not zero
        if (token == address(0)) revert InvalidTokenAddress();

        // Validate token doesn't already have a TokenNetwork
        if (token_to_token_networks[token] != address(0)) {
            revert TokenNetworkAlreadyExists(token);
        }

        // If whitelist is enabled, validate token is whitelisted
        if (whitelistEnabled && !allowedTokens[token]) {
            revert TokenNotWhitelisted(token);
        }

        // Validate token is a valid ERC20 by calling totalSupply()
        // Use try-catch for safety against malicious or non-ERC20 contracts
        try IERC20(token).totalSupply() returns (
            uint256
        ) {
        // Valid ERC20 - proceed with deployment
        }
        catch {
            revert InvalidTokenAddress();
        }

        // Deploy new TokenNetwork contract
        TokenNetwork tokenNetwork = new TokenNetwork(token);
        address tokenNetworkAddress = address(tokenNetwork);

        // Store in both mappings for efficient bidirectional lookup
        token_to_token_networks[token] = tokenNetworkAddress;
        token_network_to_token[tokenNetworkAddress] = token;

        // Emit event for off-chain indexing
        emit TokenNetworkCreated(token, tokenNetworkAddress);

        return tokenNetworkAddress;
    }

    /**
     * @notice Retrieves the TokenNetwork address for a given ERC20 token
     * @param token The address of the ERC20 token to query
     * @return The address of the TokenNetwork contract, or address(0) if none exists
     */
    function getTokenNetwork(address token) external view returns (address) {
        return token_to_token_networks[token];
    }

    /**
     * @notice Adds a token to the whitelist
     * @dev Can only be called by contract owner
     * @param token The address of the token to whitelist
     */
    function addAllowedToken(address token) external onlyOwner {
        if (token == address(0)) revert InvalidTokenAddress();
        allowedTokens[token] = true;
        emit TokenWhitelisted(token);
    }

    /**
     * @notice Removes a token from the whitelist
     * @dev Can only be called by contract owner. Does not affect existing TokenNetworks.
     * @param token The address of the token to remove from whitelist
     */
    function removeAllowedToken(address token) external onlyOwner {
        allowedTokens[token] = false;
        emit TokenRemovedFromWhitelist(token);
    }

    /**
     * @notice Enables or disables whitelist enforcement
     * @dev Can only be called by contract owner
     * @param enabled True to enable whitelist enforcement, false to disable
     */
    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistStatusChanged(enabled);
    }
}
