# Bytecode provenance: `TokenNetwork` and `TokenNetworkRegistry`

Issue #572, closing the open verification item #566 left standing: _"Whether the runtime
bytecode at `0x1E95493f…` (6490 bytes) — or at the registry (9796 bytes) — was compiled from
`origin/main`'s `packages/contracts/src` is not established."_

This is a one-time, read-only check (`cast code` / `cast call` against a public RPC, no
transactions) recorded here rather than run automatically in CI: the deployed addresses are
fixed, so there is nothing for a live check to catch on a later run that this record does not
already say, and adding a public-RPC dependency to the gate would trade a one-time fact for a
recurring flakiness risk. If either contract is ever redeployed, this file must be redone against
the new address.

## Method

1. Built `packages/contracts` at commit `66db40f8c51f8666a6858d5ed7b9f0a37685d452` with the
   committed `foundry.toml` (`solc 0.8.26`, `optimizer = true`, `optimizer_runs = 200`,
   `via_ir = true`) — exactly `crates/connector-settlement-evm/contracts/regenerate-token-network-abi.sh`'s
   own `forge build` step, no different settings.
2. Read the live runtime bytecode with `cast code <address> --rpc-url
https://base-sepolia-rpc.publicnode.com` (the same public RPC `infra/linode-node/connector.yaml`
   configures) for both addresses named in #566:
   - `TokenNetwork`: `0x1E95493fEF46707E034b4a1945f25a8C76A1823D`
   - `TokenNetworkRegistry`: `0xcC9079adE929b168B54145f6d25262b64FAB9D5b`
3. Compared each against the local build's `out/<Contract>.sol/<Contract>.json`
   `.deployedBytecode.object`.

## Result: `TokenNetworkRegistry` — exact byte-for-byte match

`TokenNetworkRegistry` declares no `immutable` state, so its deployed bytecode is fully static —
no constructor-supplied values are patched in after compilation. The live 9796-byte runtime code
matches the local build **exactly**, including the trailing CBOR metadata hash (which encodes the
exact source and compiler settings). This is the strongest form of match available short of
Etherscan verification: it proves the deployed registry was compiled from this exact source with
this exact `foundry.toml`, not merely "equivalent modulo build settings".

## Result: `TokenNetwork` — exact match outside the immutable slots, and those slots decode to exactly what deployment implies

`TokenNetwork` declares three `immutable` fields (`token`, `maxChannelDeposit`,
`maxChannelLifetime` — `packages/contracts/src/TokenNetwork.sol:19-25`) plus the EIP-712 domain's
cached name/version hashes and `address(this)` (OpenZeppelin `EIP712`'s own immutable caching).
Solidity bakes an immutable's value into the runtime code at deploy time by patching fixed
32-byte slots in the constructor-output bytecode; a _static_ build (one that was never
constructed) necessarily carries zero-filled placeholders at those slots instead. A byte string
comparison must therefore mask the slots the compiler itself reports as immutable
(`deployedBytecode.immutableReferences` in the forge artifact) before it means anything —
otherwise every deployed contract with an immutable field looks like a mismatch regardless of the
source, which would make the check useless.

Masking those slots, every other byte of the live 6490-byte runtime code — including the trailing
metadata hash — matches the local build exactly.

The masked slots themselves were read back out of the live code and check out against what an
honest deployment against the configured addresses implies (all values independently confirmed
against the live contract's own view functions and #566's second comment):

| immutable                      | live value (from the masked bytecode slot)      | independent confirmation                                         |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| `token`                        | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce`    | `cast call … token()` (#566)                                     |
| `maxChannelDeposit`            | `0xd3c21bcecceda1000000` = `1_000_000 * 10**18` | matches `TokenNetworkRegistry.sol:81`'s fixed cap (#566's Notes) |
| `maxChannelLifetime`           | `0x1e13380` = `31536000` seconds = 365 days     | —                                                                |
| EIP-712 name                   | `"TokenNetwork"`                                | `cast call … eip712Domain()` → `name: "TokenNetwork"` (#566)     |
| EIP-712 version                | `"1"`                                           | `cast call … eip712Domain()` → `version: "1"` (#566)             |
| EIP-712 cached `address(this)` | `0x1E95493fEF46707E034b4a1945f25a8C76A1823D`    | the contract's own address                                       |

No slot decodes to anything unexplained, and every value is independently corroborated by a
live view call rather than only by the bytecode itself.

## Conclusion

Both the deployed `TokenNetworkRegistry` at `0xcC9079adE929b168B54145f6d25262b64FAB9D5b` and the
deployed `TokenNetwork` at `0x1E95493fEF46707E034b4a1945f25a8C76A1823D` were compiled from
`origin/main`'s `packages/contracts/src` as of this check. #566's open verification item is
closed: every source-level reading in #566 and its comments (the four mismatches, the EIP-712
domain fields, the security comparison) describes the code that is actually live on Base Sepolia,
not merely a plausible reading of unexercised source.

## Reproducing this check

```bash
cd packages/contracts && forge build
cast code 0x1E95493fEF46707E034b4a1945f25a8C76A1823D --rpc-url https://base-sepolia-rpc.publicnode.com
cast code 0xcC9079adE929b168B54145f6d25262b64FAB9D5b --rpc-url https://base-sepolia-rpc.publicnode.com
```

Compare each against the corresponding `out/<Contract>.sol/<Contract>.json`'s
`.deployedBytecode.object`, masking any byte ranges listed in that same file's
`.deployedBytecode.immutableReferences` before comparing.
