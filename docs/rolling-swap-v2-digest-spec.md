# Rolling-Swap v2 Claim-Digest Spec (EIP-712 domain separation)

Status: **DRAFT** — canonical cross-repo contract for the v2 balance-proof
migration. Refs connector#324 **finding #1** (the v1 digest
`keccak256(abi.encodePacked(channelId, cumulativeAmount, nonce, recipient))`
lacked chainId / contract-address domain separation → cross-chain and
cross-deployment claim replay).

This document is the **single source of truth** that all four repos implement
against:

1. `connector` — `packages/contracts/src/RollingSwapChannel.sol` (the reference
   implementation; this repo). Verifies the digest on-chain.
2. `toon` (core + sdk) — `balanceProofHashEvm` in
   `packages/core/src/settlement/hashes.ts` and the settlement builder in
   `packages/sdk/src/settlement/evm.ts`.
3. `swap` — `EvmPaymentChannelSigner.signBalanceProof` /
   `PaymentChannelSignParams` in `packages/swap/src/payment-channel-signer.ts`.
4. `toon-client` — the client-side digest recompute / verify in
   `submitEvmSettlement`.

**All four MUST produce byte-identical digests.** The golden vectors in §4 are
the conformance fixtures — hardcode and assert them in each repo.

---

## 1. Why v1 is replaced (not patched)

The v1 digest bound only `(channelId, cumulativeAmount, nonce, recipient)`. It
did **not** bind `chainId` or the settling contract address. Because the swap
node uses **one EVM signing key for every EVM chain**, and the off-chain state
layer keys channels by `${assetCode}:${chain}:${channelId}` (so the same
`channelId` on two chains is normal), a single signer-signed claim redeemed on
chain/deployment A could be replayed verbatim on chain/deployment B for the same
tuple — draining a second deposit for value earned once.

v2 folds `chainId` **and** `verifyingContract` into the signed preimage via a
standard **EIP-712** typed-data domain. A signature is then valid on **exactly
one `(chainId, contract)` pair**. The domain `version = "2"` additionally makes
the cutover **fail-closed**: a v1 raw-keccak signature can never validate as v2,
and a v2 signature can never validate as v1.

This is an **ABI-breaking wire migration**. The `updateBalance` selector/arity
and the `SettlementSucceeded` event are **unchanged** — only the *signed digest
preimage* moves. The 65-byte `r ‖ s ‖ v` signature envelope is unchanged
(`v ∈ {27, 28}`, canonical low-`s` enforced by OZ `ECDSA.recover`).

---

## 2. The v2 digest algorithm

Standard EIP-712 (`https://eips.ethereum.org/EIPS/eip-712`). Two message
structs share one domain.

### 2.1 Domain

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

- `name`    = `"RollingSwapChannel"`
- `version` = `"2"`
- `chainId` = the settlement chain id (e.g. `8453` for Base). On-chain this is
  `block.chainid`.
- `verifyingContract` = the deployed `RollingSwapChannel` address (`address(this)`).

Domain type hash:

```
EIP712DOMAIN_TYPEHASH =
  keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
= 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f
```

Domain separator:

```
domainSeparator = keccak256(abi.encode(
    EIP712DOMAIN_TYPEHASH,
    keccak256(bytes("RollingSwapChannel")),   // = 0x03b1e55f7f93cd70e54a750705030a137e734d1a9c1f1921ac04f8898b004f7f
    keccak256(bytes("2")),                     // = 0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5
    chainId,                                   // uint256, left-padded to 32 bytes
    verifyingContract                          // address, left-padded to 32 bytes
))
```

`abi.encode` here means each field is a 32-byte word (the two `keccak256(...)`
results verbatim, `chainId` big-endian, `verifyingContract` right-aligned in 32
bytes). This is exactly OpenZeppelin `EIP712._domainSeparatorV4()`.

### 2.2 Claim message (`updateBalance` / the claim leg of `cooperativeClose`)

```
ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)

CLAIM_TYPEHASH =
  keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)")
= 0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91
```

```
claimStructHash = keccak256(abi.encode(
    CLAIM_TYPEHASH,
    channelId,          // bytes32
    cumulativeAmount,   // uint256
    nonce,              // uint256
    recipient           // address (right-aligned in 32 bytes)
))
```

### 2.3 Cooperative-close message (recipient close-ack)

```
CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)

COOP_CLOSE_TYPEHASH =
  keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)")
= 0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f
```

```
coopStructHash = keccak256(abi.encode(
    COOP_CLOSE_TYPEHASH,
    channelId,          // bytes32
    cumulativeAmount,   // uint256
    nonce               // uint256
))
```

The coop-close ack shares the **same domain** as the claim, so it is bound to
`chainId + verifyingContract` too, and the distinct type hash guarantees a
close-ack can never be recovered as a balance-proof claim (or vice-versa).

### 2.4 Final digest (both messages)

```
digest = keccak256( 0x1901 ‖ domainSeparator ‖ structHash )
```

where `‖` is byte concatenation, `0x1901` is the 2-byte EIP-712 prefix, and
`structHash` is `claimStructHash` or `coopStructHash` respectively. The signer
signs `digest` directly (no additional EIP-191 prefix — EIP-712 already
provides the `0x1901` domain binding). Signature envelope: 65 bytes
`r(32) ‖ s(32) ‖ v(1)`, `v ∈ {27,28}`, canonical low-`s`.

This is exactly OpenZeppelin `EIP712._hashTypedDataV4(structHash)` and matches
`eth_signTypedData_v4` / eth-account `encode_typed_data`.

---

## 3. Signer input change (ACTION REQUIRED in swap / sdk / core / client)

**The v2 signer REQUIRES two inputs the v1 signer did not take:**

- `chainId` — the settlement chain id, and
- `verifyingContract` — the `RollingSwapChannel` deployment address.

v1 `balanceProofHashEvm(channelId, cumulativeAmount, nonce, recipient)` and
`PaymentChannelSignParams` (which carried only those four fields) **must gain**
`chainId` + `verifyingContract`. In swap the "shared EVM key, per-chain domain"
model applies: the key stays shared across chains, but the signing **domain** is
now per-chain **and** per-contract, so `sharedEvmSigner` must be handed the
`(chainId, contractAddress)` for the target channel at sign time (the channel
state already keys by chain; it must also carry the settlement contract
address). The false comment in `swap-node.ts` ("the chain-id is baked into
`BalanceProofParams` at signing time") becomes **true** after this change — fix
its wording to reference EIP-712 domain binding.

Because `version="2"`, no dual-format transition window is required for
correctness (a v1 sig simply fails a v2 verifier). Follow the coordinated
release order in connector#324: core/sdk → swap → client accept v2, then
`connector` **deploys** v2 contracts at fresh addresses (immutable — redeploy,
not upgrade) and retires v1 channels via cooperative/unilateral close.

---

## 4. Golden test vectors (CONFORMANCE FIXTURES — hardcode these)

Fixed parameters:

| Parameter | Value |
|---|---|
| `chainId` | `8453` (Base) |
| `verifyingContract` | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| domain `name` | `"RollingSwapChannel"` |
| domain `version` | `"2"` |
| claim signer private key | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| claim signer address | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| coop-close (recipient) private key | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| coop-close (recipient) address | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

Message inputs (shared by both vectors):

| Field | Value |
|---|---|
| `channelId` | `0x000000000000000000000000000000000000000000000000000000000000005b` |
| `cumulativeAmount` | `24000000` (`0x016e3600`) |
| `nonce` | `24` |
| `recipient` | `0x00000000000000000000000000000000DEADBEEF` |

Derived domain (independent of the message):

```
EIP712Domain typehash = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f
keccak256("RollingSwapChannel") = 0x03b1e55f7f93cd70e54a750705030a137e734d1a9c1f1921ac04f8898b004f7f
keccak256("2")                  = 0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5
domainSeparator = 0xb94d6e9c9c28083295de906f48c4db4110392800177aad52c3f99f2afbce594f
```

### 4.1 Claim (`ClaimBalanceProof`)

```
CLAIM_TYPEHASH  = 0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91
claimStructHash = 0x6c114f364e0705a509d8db6812094b38908680f9108024576c4daca24a27959e
claim digest    = 0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede
signature (r‖s‖v, 65 bytes, signed by the claim signer key) =
  0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb1b
    r = 0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b
    s = 0x196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb
    v = 0x1b (27)
recovers to = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

### 4.2 Cooperative close (`CooperativeClose`)

```
COOP_CLOSE_TYPEHASH = 0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f
coopStructHash      = 0xf25eeb77a482188eaa1586c7ae453d9890d22eca7a0b2afd73f69c5d9f416875
coop-close digest   = 0x8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0
signature (r‖s‖v, 65 bytes, signed by the recipient key) =
  0xd8c7479c1d048fc8ee8bbb912db60d2c7b0056245a7c3611b88eceabe243932d7878586332642641c62fb909e4f23655a428f13125af2e41fe1f90ea85a100621b
    r = 0xd8c7479c1d048fc8ee8bbb912db60d2c7b0056245a7c3611b88eceabe243932d
    s = 0x7878586332642641c62fb909e4f23655a428f13125af2e41fe1f90ea85a10062
    v = 0x1b (27)
recovers to = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
```

> The two example signer/recipient keys above are the standard anvil test keys
> (#0 and #1). They are for reproducibility of the vectors only — never use them
> in production.

### 4.3 How the vectors were produced / cross-checked

Computed with Foundry `cast` and **independently** cross-checked with Python
`eth-account` (`encode_typed_data`, which builds the EIP-712 digest from the
typed-data structure itself). Both agree byte-for-byte, and the connector
contract's on-chain `domainSeparator()` / `claimDigest()` /
`cooperativeCloseDigest()` (via OZ `EIP712._hashTypedDataV4`) reproduce the same
literals — see `testV2GoldenVectorPin` in
`packages/contracts/test/RollingSwapChannel.t.sol`.

Reproduce (cast):

```bash
DOMSEP=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
  $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") \
  $(cast keccak "RollingSwapChannel") $(cast keccak "2") \
  8453 0x5FbDB2315678afecb367f032d93F642f64180aa3))
STRUCT=$(cast keccak $(cast abi-encode "f(bytes32,bytes32,uint256,uint256,address)" \
  $(cast keccak "ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)") \
  0x000000000000000000000000000000000000000000000000000000000000005b \
  24000000 24 0x00000000000000000000000000000000DEADBEEF))
cast keccak $(cast concat-hex 0x1901 $DOMSEP $STRUCT)   # -> claim digest
```

---

## 5. Reference implementation (connector)

`RollingSwapChannel.sol` inherits OpenZeppelin `EIP712("RollingSwapChannel","2")`
and computes both digests through `_hashTypedDataV4`:

- `_claimDigest(channelId, cumulativeAmount, nonce, recipient)` → claim digest.
- `_cooperativeCloseDigest(channelId, cumulativeAmount, nonce)` → coop-close digest.
- View functions `claimDigest(...)`, `cooperativeCloseDigest(...)`, and
  `domainSeparator()` expose the exact values for off-chain cross-checking.

OZ `EIP712` caches the domain separator at construction and recomputes it if
`block.chainid` changes, so the contract stays correct across chain forks. The
selector/event ABI-lock tests and the golden-vector pin test guard against drift.
