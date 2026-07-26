//! Generated typed bindings for `contracts/SettlementChannel.sol`, from the
//! compiled artifact checked in at `contracts/SettlementChannel.json`
//! (regenerate with `forge build` against the `.sol` file in this
//! directory and copy the `abi`/`bytecode`/`deployedBytecode` fields back
//! out if the contract ever changes).

use ethers::contract::abigen;

abigen!(SettlementChannel, "./contracts/SettlementChannel.json");
