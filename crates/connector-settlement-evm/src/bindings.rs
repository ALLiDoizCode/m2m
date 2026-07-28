//! Generated typed bindings for `contracts/SettlementChannel.sol` and its
//! test-only `contracts/MockERC20.sol` companion, from the compiled
//! artifacts checked in alongside them (regenerate with `forge build`
//! against the `.sol` files in this directory and copy the
//! `abi`/`bytecode`/`deployedBytecode` fields back out if either contract
//! ever changes).

use ethers::contract::abigen;

abigen!(SettlementChannel, "./contracts/SettlementChannel.json");

// A mock, mintable ERC-20 this crate's own tests (and any devnet tooling
// standing up a fresh chain with nothing real to point at) deploy in place
// of the real 6-decimal USDC `SettlementChannel` settles in production --
// see `contracts/MockERC20.sol`.
abigen!(MockErc20, "./contracts/MockERC20.json");

// The minimal ERC-20 surface `EvmSettlementBackend` itself calls against
// whatever token a `SettlementChannel` instance was deployed with --
// deliberately not tied to the mock's compiled artifact (it carries no
// `mint`), and correct against the real, already-deployed USDC contract
// production points at just as much as against `MockErc20` above.
abigen!(
    Erc20,
    r#"[
        function approve(address spender, uint256 amount) external returns (bool)
        function transferFrom(address from, address to, uint256 amount) external returns (bool)
        function transfer(address to, uint256 amount) external returns (bool)
        function balanceOf(address account) external view returns (uint256)
    ]"#
);
