// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/TokenNetworkRegistry.sol";
import "../src/TokenNetwork.sol";
import "./mocks/MockERC20.sol";

/// @title TokenNetworkRegistryTest
/// @notice Comprehensive test suite for TokenNetworkRegistry factory contract
contract TokenNetworkRegistryTest is Test {
    TokenNetworkRegistry public registry;
    MockERC20 public token;
    address public owner;
    address public nonOwner;

    event TokenNetworkCreated(address indexed token, address indexed tokenNetwork);

    function setUp() public {
        owner = address(this);
        nonOwner = address(0x1234);

        // Deploy TokenNetworkRegistry
        registry = new TokenNetworkRegistry();

        // Deploy MockERC20 token
        token = new MockERC20("Test Token", "TEST", 18);
    }

    /// @notice Test: Happy path TokenNetwork creation
    function testCreateTokenNetwork() public {
        // Expect TokenNetworkCreated event
        vm.expectEmit(true, true, false, true);
        address predictedAddress = computeCreateAddress(address(registry), 1);
        emit TokenNetworkCreated(address(token), predictedAddress);

        // Create TokenNetwork
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert: Returned address is not zero
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork address should not be zero");

        // Assert: getTokenNetwork returns deployed address
        assertEq(
            registry.getTokenNetwork(address(token)),
            tokenNetworkAddress,
            "getTokenNetwork should return deployed address"
        );

        // Assert: Reverse mapping works
        assertEq(registry.token_network_to_token(tokenNetworkAddress), address(token), "Reverse mapping should work");

        // Assert: TokenNetwork has correct token address
        TokenNetwork tn = TokenNetwork(tokenNetworkAddress);
        assertEq(tn.token(), address(token), "TokenNetwork should have correct token address");
    }

    /// @notice Test: Duplicate TokenNetwork prevention
    function testCreateTokenNetworkRevertsOnDuplicate() public {
        // Create TokenNetwork for token once
        registry.createTokenNetwork(address(token));

        // Attempt to create again - should revert
        vm.expectRevert(abi.encodeWithSelector(TokenNetworkRegistry.TokenNetworkAlreadyExists.selector, address(token)));
        registry.createTokenNetwork(address(token));
    }

    /// @notice Test: Zero address validation
    function testCreateTokenNetworkRevertsOnZeroAddress() public {
        // Expect revert with InvalidTokenAddress
        vm.expectRevert(TokenNetworkRegistry.InvalidTokenAddress.selector);
        registry.createTokenNetwork(address(0));
    }

    /// @notice Test: Null pattern for nonexistent TokenNetworks
    function testGetTokenNetworkReturnsZeroForNonexistent() public {
        // Query TokenNetwork for token that hasn't been registered
        address result = registry.getTokenNetwork(address(token));

        // Assert: Returns address(0)
        assertEq(result, address(0), "Should return address(0) for nonexistent TokenNetwork");
    }

    /// @notice Test: Multiple token support
    function testMultipleTokenNetworks() public {
        // Create second token
        MockERC20 token2 = new MockERC20("Token Two", "TT2", 6);

        // Create TokenNetwork for token1
        address tn1 = registry.createTokenNetwork(address(token));

        // Create TokenNetwork for token2
        address tn2 = registry.createTokenNetwork(address(token2));

        // Assert: Different TokenNetwork addresses
        assertTrue(tn1 != tn2, "TokenNetworks should have different addresses");

        // Assert: Correct mappings for token1
        assertEq(registry.getTokenNetwork(address(token)), tn1, "Token1 should map to TokenNetwork1");

        // Assert: Correct mappings for token2
        assertEq(registry.getTokenNetwork(address(token2)), tn2, "Token2 should map to TokenNetwork2");

        // Assert: TokenNetworks have correct token addresses
        assertEq(TokenNetwork(tn1).token(), address(token), "TokenNetwork1 should have token1");
        assertEq(TokenNetwork(tn2).token(), address(token2), "TokenNetwork2 should have token2");
    }

    /// @notice Test: Ownable functionality
    function testOwnershipTransfer() public {
        // Verify deployer is owner
        assertEq(registry.owner(), owner, "Deployer should be owner");

        // Transfer ownership
        registry.transferOwnership(nonOwner);

        // Verify new owner
        assertEq(registry.owner(), nonOwner, "Ownership should be transferred");
    }

    /// @notice Test: Reverse lookup mapping
    function testTokenNetworkToTokenMapping() public {
        // Create TokenNetwork
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));

        // Assert: Reverse mapping works
        assertEq(
            registry.token_network_to_token(tokenNetworkAddress),
            address(token),
            "TokenNetwork address should map back to token"
        );
    }

    /// @notice Test: Whitelist blocks non-whitelisted tokens
    function testWhitelistBlocksNonWhitelistedTokens() public {
        // Enable whitelist
        registry.enableWhitelist();

        // Attempt to create TokenNetwork for non-whitelisted token - should revert
        vm.expectRevert(TokenNetworkRegistry.TokenNotWhitelisted.selector);
        registry.createTokenNetwork(address(token));
    }

    /// @notice Test: Whitelist allows whitelisted tokens
    function testWhitelistAllowsWhitelistedTokens() public {
        // Enable whitelist
        registry.enableWhitelist();

        // Add token to whitelist
        registry.addTokenToWhitelist(address(token));

        // Create TokenNetwork - should succeed
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork should be created for whitelisted token");
    }

    /// @notice Test: Disable whitelist allows all tokens
    function testDisableWhitelistAllowsAllTokens() public {
        // Enable whitelist
        registry.enableWhitelist();

        // Create TokenNetwork should fail for non-whitelisted token
        vm.expectRevert(TokenNetworkRegistry.TokenNotWhitelisted.selector);
        registry.createTokenNetwork(address(token));

        // Disable whitelist
        registry.disableWhitelist();

        // Create TokenNetwork should now succeed
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));
        assertTrue(tokenNetworkAddress != address(0), "TokenNetwork should be created after disabling whitelist");
    }

    /// @notice Test: Whitelist management functions emit events
    function testWhitelistManagementEmitsEvents() public {
        // Enable whitelist - expect event
        vm.expectEmit(false, false, false, false);
        emit WhitelistEnabled();
        registry.enableWhitelist();

        // Add token to whitelist - expect event
        vm.expectEmit(true, false, false, false);
        emit TokenWhitelisted(address(token));
        registry.addTokenToWhitelist(address(token));

        // Remove token from whitelist - expect event
        vm.expectEmit(true, false, false, false);
        emit TokenRemovedFromWhitelist(address(token));
        registry.removeTokenFromWhitelist(address(token));

        // Disable whitelist - expect event
        vm.expectEmit(false, false, false, false);
        emit WhitelistDisabled();
        registry.disableWhitelist();
    }

    // Test: pause prevents token network creation
    function testPausePreventsTokenNetworkCreation() public {
        // Pause the registry
        registry.pause();

        // Try to create token network (should revert)
        vm.expectRevert();
        registry.createTokenNetwork(address(token));
    }

    // Test: unpause restores token network creation
    function testUnpauseRestoresTokenNetworkCreation() public {
        // Pause the registry
        registry.pause();

        // Unpause the registry
        registry.unpause();

        // Create token network (should succeed)
        address tokenNetworkAddress = registry.createTokenNetwork(address(token));
        assertTrue(tokenNetworkAddress != address(0));
    }

    // Event declarations for testing
    event WhitelistEnabled();
    event WhitelistDisabled();
    event TokenWhitelisted(address indexed token);
    event TokenRemovedFromWhitelist(address indexed token);
}
