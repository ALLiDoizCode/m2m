# Coding Standards

**CRITICAL: These standards are MANDATORY for AI code generation**

## Core Standards

- **Languages & Runtimes:** TypeScript 5.3.3 (strict mode), Node.js 20.11.0 LTS
- **Style & Linting:** ESLint (@typescript-eslint/recommended), Prettier (line length 100, single quotes)
- **Test Organization:** Co-located tests (`*.test.ts` next to `*.ts`), `__mocks__` for shared mocks

## Naming Conventions

| Element            | Convention                                | Example                          |
| ------------------ | ----------------------------------------- | -------------------------------- |
| Files (TypeScript) | kebab-case                                | `packet-handler.ts`              |
| Classes            | PascalCase                                | `PacketHandler`                  |
| Interfaces/Types   | PascalCase with `I` prefix for interfaces | `ILPPacket`, `RoutingTableEntry` |
| Functions/Methods  | camelCase                                 | `validatePacket()`               |
| Constants          | UPPER_SNAKE_CASE                          | `DEFAULT_BTP_PORT`               |
| Private members    | camelCase with `_` prefix                 | `_internalState`                 |

## Critical Rules

- **NEVER use console.log:** Use Pino logger exclusively (`logger.info()`, `logger.error()`, etc.)
- **All ILP packet responses use typed returns:** Functions return `ILPFulfillPacket | ILPRejectPacket`, never plain objects
- **BTP connections must use BTPClient/BTPServer classes:** No raw WebSocket usage outside BTP module
- **Telemetry emission is non-blocking:** Always use `try-catch` around `telemetryEmitter.emit()` to prevent packet processing failures
- **Configuration loaded at startup only:** No runtime config changes for MVP
- **NEVER hardcode ports/URLs:** Use environment variables with defaults
- **All async functions must handle errors:** Use try-catch or .catch() - no unhandled promise rejections
- **OER encoding must validate packet structure:** Throw `InvalidPacketError` for malformed data
- **Routing table lookups return null for no match:** Caller handles null by generating F02 error

## Language-Specific Guidelines

### TypeScript Specifics

- **Strict mode enabled:** `strict: true` in tsconfig.json - no `any` types except in test mocks
- **Prefer interfaces over type aliases** for object shapes (better error messages)
- **Use `Buffer` for binary data:** Not `Uint8Array` or `ArrayBuffer` (Node.js convention)
- **Async/await over callbacks:** All asynchronous code uses `async/await` pattern
- **Optional chaining for safety:** Use `peer?.connected` instead of `peer && peer.connected`

## Solidity Standards (Epic 8 Smart Contracts)

### Core Standards

- **Solidity Version:** 0.8.20 (configured in foundry.toml)
- **License Identifier:** MIT (`SPDX-License-Identifier: MIT` at top of all files)
- **OpenZeppelin:** Version 5.5.0 for audited contract implementations
- **Gas Optimization:** Use custom errors instead of require strings (~50% gas savings)

### Naming Conventions

| Element           | Convention                | Example                                 |
| ----------------- | ------------------------- | --------------------------------------- |
| Contracts         | PascalCase                | `TokenNetwork`, `TokenNetworkRegistry`  |
| Functions/Methods | camelCase                 | `openChannel`, `setTotalDeposit`        |
| Structs           | PascalCase                | `Channel`, `ParticipantState`           |
| Enums             | PascalCase                | `ChannelState`                          |
| Custom Errors     | PascalCase                | `InvalidParticipant`, `ChannelNotFound` |
| Events            | PascalCase                | `ChannelOpened`, `ChannelDeposit`       |
| State Variables   | camelCase                 | `channelCounter`, `settlementTimeout`   |
| Constants         | UPPER_SNAKE_CASE          | `MIN_SETTLEMENT_TIMEOUT`                |
| Private/Internal  | camelCase with `_` prefix | `_validateParticipants`                 |

### Critical Rules

- **ALWAYS use SafeERC20:** Use `safeTransferFrom` and `safeTransfer` for all ERC20 operations (handles non-standard tokens)
- **ALWAYS use ReentrancyGuard:** Apply `nonReentrant` modifier to all state-changing functions with external calls
- **Custom errors over require:** `if (invalid) revert InvalidParticipant();` instead of `require(valid, "Invalid")`
- **NatSpec documentation required:** All contracts, structs, functions, events must have `@notice`, `@dev`, `@param`, `@return` comments
- **Checks-Effects-Interactions pattern:** Always update state BEFORE external calls
- **Indexed event parameters:** Use `indexed` for up to 3 parameters per event for efficient filtering
- **Immutable where possible:** Use `immutable` for constructor-set values (gas optimization)
- **Balance verification for tokens:** Measure actual balance changes for fee-on-transfer token support

### Security Patterns

```solidity
// Custom errors (gas efficient)
error InvalidParticipant();
error ChannelNotFound();

// SafeERC20 usage
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
using SafeERC20 for IERC20;

IERC20(token).safeTransferFrom(participant, address(this), amount);

// Reentrancy protection
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

function deposit() external nonReentrant {
    // State changes BEFORE external calls
    balance += amount;
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
}

// Balance verification (fee-on-transfer tokens)
uint256 balanceBefore = IERC20(token).balanceOf(address(this));
IERC20(token).safeTransferFrom(participant, address(this), amount);
uint256 balanceAfter = IERC20(token).balanceOf(address(this));
uint256 actualReceived = balanceAfter - balanceBefore;
```

### Testing Standards (Foundry)

- **Test file naming:** `ContractName.t.sol`
- **Test contract naming:** `ContractNameTest is Test`
- **Test function naming:** `test` prefix (e.g., `testOpenChannel`, `testRevertInvalidParticipant`)
- **AAA pattern:** Arrange (setup), Act (execute), Assert (verify)
- **Descriptive names:** `testRejectInvalidParticipants` not `testFail1`
- **Fuzz testing:** Use `testFuzz_` prefix for fuzz tests with random inputs
- **Coverage target:** >95% line coverage for all production contracts
