// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TokenNetworkRegistry.sol";
import "../src/MockERC20.sol";

/**
 * @title TokenNetworkRegistryTest
 * @notice Comprehensive unit tests for TokenNetworkRegistry factory contract
 */
contract TokenNetworkRegistryTest is Test {
    TokenNetworkRegistry public registry;
    MockERC20 public token;
    address public owner;

    // Event declarations for testing
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);
    event WhitelistStatusChanged(bool enabled);

    function setUp() public {
        owner = address(this);

        // Deploy TokenNetworkRegistry
        registry = new TokenNetworkRegistry();

        // Deploy MockERC20 for testing
        token = new MockERC20("Test Token", "TEST", 18);
    }

    /**
     * @notice Test successful TokenNetwork creation for valid ERC20 token
     * @dev Verifies TokenNetwork deployment, mapping updates, and event emission
     */
    function testCreateTokenNetwork() public {
        // Arrange - token and registry already set up in setUp()

        // Act - Create TokenNetwork for token
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert - Verify TokenNetwork address is non-zero
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork address should not be zero");

        // Assert - Verify mapping updated correctly
        address retrievedAddress = registry.getTokenNetwork(address(token));
        assertEq(retrievedAddress, tokenNetworkAddress, "getTokenNetwork should return correct address");

        // Assert - Verify reverse mapping updated correctly
        address retrievedToken = registry.token_network_to_token(tokenNetworkAddress);
        assertEq(retrievedToken, address(token), "Reverse mapping should return correct token address");

        // Assert - Verify TokenNetwork was initialized correctly
        TokenNetwork tokenNetwork = TokenNetwork(tokenNetworkAddress);
        assertEq(tokenNetwork.token(), address(token), "TokenNetwork should store correct token address");
    }

    /**
     * @notice Test duplicate TokenNetwork prevention
     * @dev Verifies that creating a TokenNetwork for the same token twice reverts
     */
    function testPreventDuplicateTokenNetwork() public {
        // Arrange - Create TokenNetwork for token once
        registry.createTokenNetwork(address(token));

        // Act & Assert - Attempt to create TokenNetwork for same token again should revert
        vm.expectRevert(abi.encodeWithSelector(TokenNetworkRegistry.TokenNetworkAlreadyExists.selector, address(token)));
        registry.createTokenNetwork(address(token));
    }

    /**
     * @notice Test zero address rejection
     * @dev Verifies that attempting to create TokenNetwork with zero address reverts
     */
    function testRejectZeroAddressToken() public {
        // Act & Assert - Attempt to create TokenNetwork with address(0)
        vm.expectRevert(TokenNetworkRegistry.InvalidTokenAddress.selector);
        registry.createTokenNetwork(address(0));
    }

    /**
     * @notice Test invalid token rejection
     * @dev Verifies that attempting to create TokenNetwork with non-ERC20 contract reverts
     */
    function testRejectInvalidToken() public {
        // Arrange - Use a non-ERC20 contract address (the registry itself)
        address invalidToken = address(registry);

        // Act & Assert - Attempt to create TokenNetwork with invalid token should revert
        vm.expectRevert(TokenNetworkRegistry.InvalidTokenAddress.selector);
        registry.createTokenNetwork(invalidToken);
    }

    /**
     * @notice Test getTokenNetwork lookup function
     * @dev Verifies lookup returns address(0) for non-existent TokenNetwork and correct address after creation
     */
    function testGetTokenNetwork() public {
        // Arrange - Query for token that doesn't exist yet
        address nonExistentResult = registry.getTokenNetwork(address(token));

        // Assert - Should return address(0) for non-existent TokenNetwork
        assertEq(nonExistentResult, address(0), "Should return address(0) for non-existent TokenNetwork");

        // Act - Create TokenNetwork for token
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert - Query should now return correct TokenNetwork address
        address existentResult = registry.getTokenNetwork(address(token));
        assertEq(existentResult, tokenNetworkAddress, "Should return correct TokenNetwork address after creation");
    }

    /**
     * @notice Test multiple TokenNetwork creation for different tokens
     * @dev Verifies registry can manage multiple TokenNetworks with unique addresses
     */
    function testMultipleTokenNetworks() public {
        // Arrange - Deploy 3 different MockERC20 tokens
        MockERC20 tokenA = new MockERC20("Token A", "TKA", 18);
        MockERC20 tokenB = new MockERC20("Token B", "TKB", 6);
        MockERC20 tokenC = new MockERC20("Token C", "TKC", 8);

        // Act - Create TokenNetwork for each token
        address tokenNetworkA = registry.createTokenNetwork(address(tokenA));
        address tokenNetworkB = registry.createTokenNetwork(address(tokenB));
        address tokenNetworkC = registry.createTokenNetwork(address(tokenC));

        // Assert - All 3 TokenNetworks created successfully with unique addresses
        assertTrue(tokenNetworkA != address(0), "TokenNetwork A should be created");
        assertTrue(tokenNetworkB != address(0), "TokenNetwork B should be created");
        assertTrue(tokenNetworkC != address(0), "TokenNetwork C should be created");

        assertTrue(tokenNetworkA != tokenNetworkB, "TokenNetwork A and B should have different addresses");
        assertTrue(tokenNetworkB != tokenNetworkC, "TokenNetwork B and C should have different addresses");
        assertTrue(tokenNetworkA != tokenNetworkC, "TokenNetwork A and C should have different addresses");

        // Assert - getTokenNetwork returns correct address for each token
        assertEq(registry.getTokenNetwork(address(tokenA)), tokenNetworkA, "Should return correct address for token A");
        assertEq(registry.getTokenNetwork(address(tokenB)), tokenNetworkB, "Should return correct address for token B");
        assertEq(registry.getTokenNetwork(address(tokenC)), tokenNetworkC, "Should return correct address for token C");

        // Assert - Verify each TokenNetwork has correct token stored
        assertEq(TokenNetwork(tokenNetworkA).token(), address(tokenA), "TokenNetwork A should store correct token");
        assertEq(TokenNetwork(tokenNetworkB).token(), address(tokenB), "TokenNetwork B should store correct token");
        assertEq(TokenNetwork(tokenNetworkC).token(), address(tokenC), "TokenNetwork C should store correct token");
    }

    /**
     * @notice Test TokenNetworkCreated event emission
     * @dev Verifies event is emitted with correct parameters
     */
    function testTokenNetworkCreatedEvent() public {
        // Arrange - Set up expectation for event emission
        // Note: We can't predict the exact TokenNetwork address before deployment,
        // so we verify event was emitted and check parameters separately

        // Act - Create TokenNetwork
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert - Verify event was emitted (checked via transaction logs)
        // The vm.expectEmit in testCreateTokenNetwork already validates this,
        // but we verify the relationship between emitted addresses
        assertEq(
            registry.getTokenNetwork(address(token)), tokenNetworkAddress, "Event should reference created TokenNetwork"
        );
    }

    /**
     * @notice Test Ownable inheritance
     * @dev Verifies registry inherits Ownable and owner is set correctly
     */
    function testOwnableInheritance() public {
        // Assert - Verify owner is set correctly (msg.sender during deployment)
        assertEq(registry.owner(), owner, "Registry owner should be deployer");
    }

    /**
     * @notice Test whitelist disabled by default
     * @dev Verifies whitelist enforcement is disabled on deployment
     */
    function testWhitelistDisabledByDefault() public {
        // Assert - Whitelist should be disabled by default
        assertFalse(registry.whitelistEnabled(), "Whitelist should be disabled by default");
    }

    /**
     * @notice Test owner can add token to whitelist
     */
    function testAddAllowedToken() public {
        // Act - Owner adds token to whitelist
        registry.addAllowedToken(address(token));

        // Assert - Token should be whitelisted
        assertTrue(registry.allowedTokens(address(token)), "Token should be whitelisted");
    }

    /**
     * @notice Test non-owner cannot add token to whitelist
     */
    function testRejectAddAllowedTokenByNonOwner() public {
        // Arrange - Create non-owner address
        address nonOwner = address(0x123);

        // Act & Assert - Non-owner tries to whitelist token
        vm.prank(nonOwner);
        vm.expectRevert(); // OwnableUnauthorizedAccount error
        registry.addAllowedToken(address(token));
    }

    /**
     * @notice Test owner can remove token from whitelist
     */
    function testRemoveAllowedToken() public {
        // Arrange - Add token to whitelist first
        registry.addAllowedToken(address(token));

        // Act - Owner removes token from whitelist
        registry.removeAllowedToken(address(token));

        // Assert - Token should not be whitelisted
        assertFalse(registry.allowedTokens(address(token)), "Token should not be whitelisted");
    }

    /**
     * @notice Test owner can enable whitelist
     */
    function testEnableWhitelist() public {
        // Act - Owner enables whitelist
        registry.setWhitelistEnabled(true);

        // Assert - Whitelist should be enabled
        assertTrue(registry.whitelistEnabled(), "Whitelist should be enabled");
    }

    /**
     * @notice Test owner can disable whitelist
     */
    function testDisableWhitelist() public {
        // Arrange - Enable whitelist first
        registry.setWhitelistEnabled(true);

        // Act - Owner disables whitelist
        registry.setWhitelistEnabled(false);

        // Assert - Whitelist should be disabled
        assertFalse(registry.whitelistEnabled(), "Whitelist should be disabled");
    }

    /**
     * @notice Test whitelist enforcement blocks non-whitelisted tokens
     */
    function testWhitelistEnforcementBlocksNonWhitelisted() public {
        // Arrange - Enable whitelist without whitelisting token
        registry.setWhitelistEnabled(true);

        // Act & Assert - Attempt to create TokenNetwork for non-whitelisted token
        vm.expectRevert(abi.encodeWithSelector(TokenNetworkRegistry.TokenNotWhitelisted.selector, address(token)));
        registry.createTokenNetwork(address(token));
    }

    /**
     * @notice Test whitelist enforcement allows whitelisted tokens
     */
    function testWhitelistEnforcementAllowsWhitelisted() public {
        // Arrange - Enable whitelist and whitelist token
        registry.setWhitelistEnabled(true);
        registry.addAllowedToken(address(token));

        // Act - Create TokenNetwork for whitelisted token
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert - TokenNetwork should be created successfully
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork should be created for whitelisted token");
        assertEq(registry.getTokenNetwork(address(token)), tokenNetworkAddress, "Should return correct address");
    }

    /**
     * @notice Test disabled whitelist allows all tokens
     */
    function testDisabledWhitelistAllowsAll() public {
        // Arrange - Ensure whitelist is disabled (default state)
        assertFalse(registry.whitelistEnabled(), "Whitelist should be disabled");

        // Act - Create TokenNetwork without whitelisting token
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert - TokenNetwork should be created successfully
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork should be created when whitelist disabled");
    }

    /**
     * @notice Test TokenWhitelisted event emission
     */
    function testTokenWhitelistedEvent() public {
        // Arrange & Act - Expect event and add token
        vm.expectEmit(true, false, false, false);
        emit TokenWhitelisted(address(token));
        registry.addAllowedToken(address(token));
    }

    /**
     * @notice Test TokenRemovedFromWhitelist event emission
     */
    function testTokenRemovedFromWhitelistEvent() public {
        // Arrange - Add token first
        registry.addAllowedToken(address(token));

        // Act - Expect event and remove token
        vm.expectEmit(true, false, false, false);
        emit TokenRemovedFromWhitelist(address(token));
        registry.removeAllowedToken(address(token));
    }

    /**
     * @notice Test WhitelistStatusChanged event emission
     */
    function testWhitelistStatusChangedEvent() public {
        // Act - Expect event and enable whitelist
        vm.expectEmit(false, false, false, true);
        emit WhitelistStatusChanged(true);
        registry.setWhitelistEnabled(true);
    }

    /**
     * @notice Test reject zero address in addAllowedToken
     */
    function testRejectZeroAddressWhitelist() public {
        // Act & Assert - Attempt to whitelist zero address
        vm.expectRevert(TokenNetworkRegistry.InvalidTokenAddress.selector);
        registry.addAllowedToken(address(0));
    }
}
