# Smart Contract Development with Foundry and Anvil

## Overview

This guide explains the smart contract development workflow for M2M payment channels using Foundry and local Anvil blockchain development.

## Prerequisites

- Foundry installed (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Anvil running via `docker-compose -f docker-compose-dev.yml up -d anvil`
- Basic understanding of Solidity and smart contract development

## Foundry Overview

### Foundry Toolchain Components

- **`forge`**: Smart contract compiler, test runner, deployment tool
- **`cast`**: Command-line tool for interacting with contracts and RPC endpoints
- **`anvil`**: Local Ethereum node (provided by Epic 7 dev infrastructure)
- **`chisel`**: Solidity REPL for rapid prototyping

### Why Foundry for M2M?

- **Fast test execution**: 10x faster than Hardhat
- **Solidity-native testing**: No JavaScript context switching
- **Built-in fuzz testing**: Automated edge case discovery
- **Excellent Anvil integration**: Seamless local development workflow

## Project Structure

```
packages/contracts/
├── src/                          # Solidity contract source files
│   └── MockERC20.sol            # Example ERC20 token
├── test/                         # Foundry test files (*.t.sol)
│   └── Deploy.t.sol             # Deployment tests
├── script/                       # Deployment scripts (*.s.sol)
│   └── Deploy.s.sol             # Multi-environment deployment
├── lib/                          # Dependencies (OpenZeppelin, forge-std)
│   ├── forge-std/               # Foundry standard library
│   └── openzeppelin-contracts/  # OpenZeppelin library
├── out/                          # Compiled contract artifacts (forge build)
├── foundry.toml                  # Foundry configuration
├── remappings.txt                # Import path remappings
└── package.json                  # npm scripts for common tasks
```

### Configuration Files

- **`foundry.toml`**: Compiler settings, RPC endpoints, Etherscan config
- **`remappings.txt`**: Import path mappings (e.g., `@openzeppelin/=lib/openzeppelin-contracts/`)

### Naming Conventions

- Test files: `ContractName.t.sol`
- Script files: `Deploy.s.sol`, `Verify.s.sol`

## Development Workflow

### 1. Write Solidity Contract

Create contract file in `src/`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyToken is ERC20 {
    constructor() ERC20("MyToken", "MTK") {
        _mint(msg.sender, 1000000 * 10**18);
    }
}
```

### 2. Compile Contract

```bash
forge build
```

Verify compilation: check `out/` directory for JSON artifacts.

### 3. Write Tests

Create test file in `test/` with `.t.sol` extension:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MyToken.sol";

contract MyTokenTest is Test {
    MyToken public token;
    address public deployer = address(1);

    function setUp() public {
        vm.prank(deployer);
        token = new MyToken();
    }

    function testDeployment() public {
        assertEq(token.totalSupply(), 1000000 * 10**18);
        assertEq(token.balanceOf(deployer), 1000000 * 10**18);
    }
}
```

### 4. Run Tests

```bash
forge test                    # Run all tests
forge test -vvvv              # Verbose output
forge test --gas-report       # Gas usage report
forge coverage                # Coverage report
```

### 5. Deploy to Local Anvil

Ensure Anvil running:

```bash
docker ps | grep anvil
```

Deploy:

```bash
npm run deploy:local
# or: forge script script/Deploy.s.sol --rpc-url local --broadcast
```

Verify deployment:

```bash
cast code <contract-address> --rpc-url http://localhost:8545
```

### 6. Interact with Deployed Contract

Read contract state:

```bash
cast call <address> "balanceOf(address)" <wallet> --rpc-url http://localhost:8545
```

Send transaction:

```bash
cast send <address> "transfer(address,uint256)" <recipient> <amount> \
  --rpc-url http://localhost:8545 \
  --private-key <key>
```

### 7. Deploy to Testnet

Update .env: Set `BASE_SEPOLIA_RPC_URL` and `ETHERSCAN_API_KEY`

Deploy:

```bash
npm run deploy:sepolia
```

Verify on BaseScan: Check contract verified and readable.

### 8. Deploy to Mainnet (Production)

**CRITICAL: Security audit required before mainnet deployment**

Update .env: Set `BASE_MAINNET_RPC_URL` and secure `PRIVATE_KEY`

Deploy:

```bash
npm run deploy:mainnet
```

Monitor deployment for 24 hours before full rollout.

## Testing Best Practices

- **Unit tests**: Test individual contract functions in isolation
- **Integration tests**: Test multi-contract interactions
- **Fuzz tests**: Test with random inputs (`function testFuzz_Deposit(uint256 amount)`)
- **Invariant tests**: Test contract invariants hold across all states
- **Gas optimization**: Use `forge snapshot` to track gas usage changes

## Common Tasks and Commands

### Development

```bash
# Compile contracts
forge build

# Run tests
forge test

# Run specific test
forge test --match-test testDeployment

# Deploy to local Anvil
npm run deploy:local

# Check contract bytecode
cast code <address> --rpc-url <rpc-url>
```

### Contract Interaction

```bash
# Call view/pure function
cast call <address> "functionName(args)" <values> --rpc-url <rpc-url>

# Send transaction
cast send <address> "functionName(args)" <values> \
  --rpc-url <rpc-url> \
  --private-key <key>

# Get account balance
cast balance <address> --rpc-url <rpc-url>

# Get block number
cast block-number --rpc-url <rpc-url>
```

## Troubleshooting

### Issue: "Contract deployment fails with 'insufficient funds'"

**Solution**: Verify deployer account has sufficient ETH for gas

```bash
cast balance <address> --rpc-url http://localhost:8545
```

For Anvil: Anvil pre-funds 10 accounts with 10000 ETH each.

### Issue: "forge test fails with 'import not found'"

**Solution**: Verify remappings.txt configured correctly

```bash
cat remappings.txt
ls lib/openzeppelin-contracts
```

### Issue: "Contract verification fails on Etherscan"

**Solution**: Ensure ETHERSCAN_API_KEY set correctly

Use `--verify` flag with `forge script` or manually verify:

```bash
forge verify-contract <address> <contract-name> \
  --chain <chain-id> \
  --etherscan-api-key <key>
```

### Issue: "Deployment script can't find PRIVATE_KEY"

**Solution**: Ensure .env.dev loaded

```bash
source .env.dev
echo $PRIVATE_KEY
```

## Integration with M2M Connectors

### How Connectors Interact with Contracts

1. Connectors use ethers.js to connect to Base L2 RPC endpoints
2. Contract addresses configured via environment variables (`BASE_REGISTRY_ADDRESS`)
3. Connectors call contract functions for payment channel operations

### Example: Connector Opens Payment Channel

1. Connector loads contract ABI from `packages/contracts/out/`
2. Connector connects to Base L2 RPC endpoint (local Anvil or public Base)
3. Connector sends `openChannel()` transaction to contract
4. Connector waits for transaction confirmation
5. Connector monitors contract events for channel state changes

## Next Steps

- [Epic 8 Stories](../../docs/stories/) for payment channel contract implementation
- [Local Blockchain Development](./local-blockchain-development.md) for Anvil setup details
- [Environment Configuration](./local-vs-production-config.md) for multi-environment setup
