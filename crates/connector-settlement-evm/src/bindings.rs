//! Generated typed bindings for `contracts/SettlementChannel.sol` and its
//! test-only `contracts/MockERC20.sol` companion, from the compiled
//! artifacts checked in alongside them (regenerate with `forge build`
//! against the `.sol` files in this directory and copy the
//! `abi`/`bytecode`/`deployedBytecode` fields back out if either contract
//! ever changes), plus `TokenNetwork`/`TokenNetworkRegistry` bindings for
//! `packages/contracts/src` (issue #572; regenerate with
//! `contracts/regenerate-token-network-abi.sh`, not by hand -- see that
//! script and `tests/abi_provenance.rs`). `contracts/BYTECODE-PROVENANCE.md`
//! records the check that the deployed Base Sepolia bytecode at both
//! `TokenNetwork` and `TokenNetworkRegistry` addresses matches a local
//! build of this source.

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

// Bindings for the two contracts issue #566 retargets this crate onto --
// `packages/contracts/src/TokenNetwork.sol` and its
// `TokenNetworkRegistry.sol` factory. Nothing in this crate constructs
// either binding yet (issue #572 adds only the bindings and their artifact
// provenance; #576 is the rewrite that uses them), so both modules are
// allowed to be unused for now.
//
// Each lives in its own private module rather than at this module's top
// level like `SettlementChannel`/`MockErc20`/`Erc20` above: `abigen!` also
// generates an event-filter type per event name, flattened into whatever
// module it's invoked in, and `TokenNetwork.sol` and
// `SettlementChannel.sol` both declare a `ChannelOpened` event -- sharing
// this module would make `ChannelOpenedFilter` ambiguous.
//
// The artifacts are NOT hand-committed the way SettlementChannel.json/
// MockERC20.json above are -- they are extracted verbatim from a real
// `forge build` of `packages/contracts` by
// `contracts/regenerate-token-network-abi.sh`, and
// `tests/abi_provenance.rs` asserts regenerating them against an
// unchanged `packages/contracts/src` is a no-op. Do not hand-edit
// `contracts/TokenNetwork.json` or `contracts/TokenNetworkRegistry.json`;
// regenerate them with that script instead.
#[allow(dead_code)]
mod token_network {
    use ethers::contract::abigen;

    abigen!(TokenNetwork, "./contracts/TokenNetwork.json");
}

#[allow(dead_code)]
mod token_network_registry {
    use ethers::contract::abigen;

    abigen!(
        TokenNetworkRegistry,
        "./contracts/TokenNetworkRegistry.json"
    );
}
