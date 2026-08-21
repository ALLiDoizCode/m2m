#!/usr/bin/env bash
# =============================================================================
# Provision the key material a local topology needs, and fund it.
#
#   local/keys.sh <topology>        # e.g. local/keys.sh solo
#
# Everything lands in local/.keys/<topology>/<node>/, which is GITIGNORED.
# Nothing this script writes is ever committed: ADR 0012 makes key material a
# location rather than a value, and every committed connector.toml under
# local/ names these as paths.
#
# One directory per NODE, named after that node's compose service, and the
# node's config file is `local/<topology>/<node>.toml`. A topology with one
# node (`solo`) is not a special case of that -- it is the same rule with one
# entry -- which is what let two more topologies land here without a second
# provisioning path.
#
# This replaces `deploy/connector-rust/local-stack/prepare.sh`, deleted with
# that bundle. What it adds is the FUNDING: a key that exists is not a key that
# can pay gas, and "the connector refused to start" and "its settlement account
# has no ETH" are different problems that used to present identically.
#
# No faucet is involved on either chain. The faucet is an app-layer service and
# is not part of the connector; local chains fund from genesis.
#
# Idempotent. Re-running keeps existing keys, re-funds them, and leaves an
# already-open payment channel alone -- which is the common case: both local
# chains wipe their state on every start, so the accounts survive in this
# directory while their balances do not.
#
# ── Why some keys are RANDOM and some are DERIVED ────────────────────────────
#
# A multi-node topology has to write one node's address into another node's
# committed config: a `[[peer_channels]]` row names the `counterparty_key`
# whose signature this node accepts on a claim, and there is no way to say
# "whatever address the other container happens to have generated". So:
#
#   * `signer.key` and `operator-send.key` are RANDOM. Neither ever appears in
#     a committed file -- the signer is an identity the packet discovers over
#     `GET /ilp/identity`, and the operator allowlist holds only the PUBLIC
#     half, written here at run time.
#
#   * `settlement.key` and `settlement-solana.key` are DERIVED, per node, from
#     anvil's own published test mnemonic at a fixed index. Their ADDRESSES
#     are what the committed `[[peer_channels]]` rows name, so they have to be
#     the same on every machine and after every reset.
#
# The mnemonic is public knowledge -- anvil prints it on every start and this
# repository already commits account 0's private key below, for the same
# reason: it is the deployer of a disposable local chain. Deriving from it
# introduces no secret that did not already exist, and the alternative (a
# fixed "throwaway" key checked in under local/) would introduce one.
#
# EVM and Solana take DISJOINT index ranges, so no single 32 bytes is ever
# used on both curves. The Solana derivation is not BIP44-for-Solana and does
# not claim to be: `[settlement.solana.key]` is a raw 32-byte SEED that the
# connector hands to `keypair_from_seed`, and a BIP32 derivation is just a
# deterministic 32-byte function of (mnemonic, index), so it supplies one.
# =============================================================================
set -euo pipefail

TOPOLOGY="${1:-}"
if [[ -z "$TOPOLOGY" ]]; then
  echo "usage: local/keys.sh <topology>   (one of: solo, two-hop, mixed-chain)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
KEYS="$HERE/.keys/$TOPOLOGY"
CONNECTOR="$ROOT/target/release/connector"

ANVIL_RPC="${ANVIL_RPC:-http://127.0.0.1:8545}"
SOLANA_RPC="${SOLANA_RPC:-http://127.0.0.1:8899}"

# anvil's own published account 0 and the mnemonic it derives from -- "test
# test ... junk", public knowledge, printed by anvil on every start. Account 0
# is the deployer `DeployLocal.s.sol` runs as, so it owns the settlement
# topology and can mint the mock USDC. Only ever pointed at a disposable local
# chain.
ANVIL_MNEMONIC="test test test test test test test test test test test junk"
ANVIL_ACCOUNT0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
MOCK_USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
TOKEN_NETWORK_REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512

# The deterministic mock mint and the payment-channel program id the local
# validator loads at genesis (`infra/solana/entrypoint.sh`,
# `infra/solana/create-usdc-mint.sh`). Needed here only to derive a Solana
# peering's channel PDA, which is a pure function of the program, the mint and
# the two participants.
SOLANA_USDC_MINT=H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H
SOLANA_PROGRAM_ID=HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR

# What a peering's payer deposits into its channel, in 6-decimal USDC base
# units: 100 USDC against a 1000 µUSDC crossing, so a topology can be
# rehearsed a hundred thousand times before the collateral is the reason
# something fails. `setTotalDeposit` takes a TOTAL rather than an increment,
# so re-running this script re-asserts the figure instead of adding to it.
CHANNEL_DEPOSIT=100000000

# ── The topology table ───────────────────────────────────────────────────────
# `node:evm_index:solana_index` per node, and `id:chain:payer:payee` per
# peering. The payer is the side that OPENS and FUNDS the channel, and it is
# the side packets flow away from: debt flows in the direction packets do
# (`peer-semantics-pre-868.md` §6.4), so the payer is the side that can
# actually be owed against.
#
# Indices are disjoint across topologies as well as across nodes. They need
# not be -- no two topologies are ever up at once -- but a settlement address
# that appears in exactly one committed config is one fewer thing to
# disambiguate when a claim is refused and the log names an address.
case "$TOPOLOGY" in
  solo)
    NODES="connector:4:14"
    PEERINGS=""
    ;;
  two-hop)
    NODES="connector-a:5:15 connector-b:6:16"
    PEERINGS="a-b:evm:connector-a:connector-b"
    ;;
  mixed-chain)
    NODES="connector-a:7:17 connector-b:8:18 connector-c:9:19"
    PEERINGS="a-b:evm:connector-a:connector-b b-c:solana:connector-b:connector-c"
    ;;
  *)
    echo "ERROR: unknown topology '$TOPOLOGY'." >&2
    echo "       Known topologies are the directories under local/: solo, two-hop, mixed-chain." >&2
    echo "       A new one needs an entry in this script's topology table as well as a" >&2
    echo "       directory -- keys are provisioned from the table, not discovered." >&2
    exit 1
    ;;
esac

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: '$1' is not on PATH. $2" >&2
    exit 1
  }
}

need cast "Install Foundry: https://getfoundry.sh"
need solana "Install the Solana CLI: https://solana.com/docs/intro/installation"
need solana-keygen "Ships with the Solana CLI."
need openssl "openssl generates the key material."
need python3 "python3 does the two encodings this script cannot ask a chain tool for."

if [[ ! -x "$CONNECTOR" ]]; then
  echo "ERROR: $CONNECTOR is missing. Run 'cargo build --release -p connector' first --" >&2
  echo "       this script derives the operator allowlist value with it, so the value in" >&2
  echo "       write_keys cannot disagree with whatever actually signs. It derives every" >&2
  echo "       Solana settlement PUBLIC key with it too, for the same reason." >&2
  exit 1
fi

# base58, for the one direction no tool here offers: an ed25519 public key in
# hex is what the connector prints, and base58 is what Solana and every
# committed `[[peer_channels]]` Solana row spell it in.
base58() {
  python3 - "$1" <<'PY'
import sys
raw = bytes.fromhex(sys.argv[1])
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
value = int.from_bytes(raw, "big")
encoded = ""
while value:
    value, remainder = divmod(value, 58)
    encoded = alphabet[remainder] + encoded
leading_zeros = len(raw) - len(raw.lstrip(b"\0"))
print(alphabet[0] * leading_zeros + encoded)
PY
}

# The two participants of a Solana channel, in the order the program derives
# its PDA from: `sort_participants` returns (min, max) by the 32-byte VALUE
# (packages/solana-program/src/processor.rs), which base58 does not order --
# sorting the encoded strings gives a different pair and therefore a different,
# perfectly valid-looking, wrong address.
sorted_solana_pair() {
  python3 - "$1" "$2" <<'PY'
import sys
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def decode(encoded):
    value = 0
    for character in encoded:
        value = value * 58 + alphabet.index(character)
    return value.to_bytes(32, "big")


first, second = sys.argv[1], sys.argv[2]
print(*(
    (first, second) if decode(first) < decode(second) else (second, first)
))
PY
}

# The node's directory, and the committed config file that goes with it. One
# name, two places, and the invariant that keeps them together.
node_dir() { echo "$KEYS/$1"; }
node_config() { echo "$HERE/$TOPOLOGY/$1.toml"; }

# The private key derived for a node, on either chain. `cast wallet
# private-key` prints `0x`-prefixed; every key_file in this repository takes
# bare 64 hex, so the prefix is stripped exactly once, here.
derived_key() {
  cast wallet private-key --mnemonic "$ANVIL_MNEMONIC" --mnemonic-index "$1" | sed 's/^0x//'
}

# Assert `$2` (a committed config) names `$1`. This is the drift guard the
# whole committed-not-generated choice rests on (ADR 0009): every address in
# those files is deterministic, and this is where "deterministic" stops being
# a claim in a comment.
config_must_name() {
  local value="$1" config="$2" what="$3"
  if ! grep -qF "$value" "$config"; then
    echo "ERROR: $config does not name $what" >&2
    echo "         $value" >&2
    echo "       That value is a deterministic function of the local chains and this" >&2
    echo "       script's own topology table, so a mismatch means the committed config is" >&2
    echo "       stale -- update it to the value above rather than editing this script." >&2
    exit 1
  fi
}

mkdir -p "$KEYS"
chmod 700 "$KEYS"

# ── Keys, per node ───────────────────────────────────────────────────────────
for entry in $NODES; do
  IFS=':' read -r node evm_index solana_index <<<"$entry"
  dir="$(node_dir "$node")"
  config="$(node_config "$node")"

  if [[ ! -f "$config" ]]; then
    echo "ERROR: $config does not exist, but this script's topology table lists node" >&2
    echo "       '$node' for '$TOPOLOGY'. A node's key directory is named after its" >&2
    echo "       compose service and its config file after the same name." >&2
    exit 1
  fi

  mkdir -p "$dir"
  chmod 700 "$dir"

  # 64 hex characters each -- one of the two shapes every `key_file` in this
  # repository accepts (32 raw bytes is the other). Random, and kept across
  # runs: neither appears in a committed file, so nothing depends on their
  # value.
  for key in signer operator-send; do
    if [[ ! -f "$dir/$key.key" ]]; then
      openssl rand -hex 32 >"$dir/$key.key"
      chmod 600 "$dir/$key.key"
      echo "$node: generated $key.key"
    fi
  done

  # The operator surface's READ credential. A token, not a key: it gates reads
  # and nothing else, and no shared secret can move value (ADR 0008).
  if [[ ! -f "$dir/operator-bearer-token" ]]; then
    openssl rand -hex 32 >"$dir/operator-bearer-token"
    chmod 600 "$dir/operator-bearer-token"
    echo "$node: generated operator-bearer-token"
  fi

  # The two DERIVED keys. Rewritten every run rather than kept, because they
  # are a pure function of the mnemonic and the index: a stale file here would
  # be a settlement address that no longer matches the one a peer's committed
  # config names, which is the single hardest failure in this directory to
  # read backwards from its symptom.
  derived_key "$evm_index" >"$dir/settlement.key"
  derived_key "$solana_index" >"$dir/settlement-solana.key"
  chmod 600 "$dir/settlement.key" "$dir/settlement-solana.key"

  # The Solana CLI's own keypair file: a 64-element array of `seed || public
  # key`. Built here rather than by `solana-keygen`, which only generates
  # random keys and cannot be handed a seed non-interactively. The public half
  # is derived by the SAME binary that will sign with it, so the account this
  # script airdrops to is provably the account the connector signs as -- and
  # `solana-keygen verify` below is a real signature round trip, not a
  # re-read of the bytes we just wrote.
  solana_keyid="$("$CONNECTOR" send --operator-key "$dir/settlement-solana.key" --print-keyid)"
  python3 - "$dir/settlement-solana.key" "$solana_keyid" "$dir/settlement-solana-cli.json" <<'PY'
import json
import sys

seed = bytes.fromhex(open(sys.argv[1]).read().strip())
public = bytes.fromhex(sys.argv[2])
assert len(seed) == 32 and len(public) == 32, "a Solana keypair is 32 bytes of seed and 32 of key"
json.dump(list(seed + public), open(sys.argv[3], "w"))
PY
  chmod 600 "$dir/settlement-solana-cli.json"
  solana_address="$(base58 "$solana_keyid")"
  solana-keygen verify "$solana_address" "$dir/settlement-solana-cli.json" >/dev/null

  # The write allowlist: the PUBLIC half of operator-send.key, one 64-hex key
  # per line. Derived by the binary that will do the signing, so the
  # allowlisted value and the signature cannot disagree.
  keyid="$("$CONNECTOR" send --operator-key "$dir/operator-send.key" --print-keyid)"
  {
    echo "# Written by local/keys.sh -- the public half of operator-send.key."
    echo "# An allowlist entry is an ed25519 PUBLIC key and holds no secret."
    echo "$keyid"
  } >"$dir/operator-write-keys"

  # The body the sender posts. A fixture; it lives beside the keys so the
  # sender container mounts exactly one directory.
  if [[ ! -f "$dir/payload.json" ]]; then
    echo '{"hello":"from a paid packet"}' >"$dir/payload.json"
  fi

  echo "$node: evm $(cast wallet address --private-key "0x$(cat "$dir/settlement.key")")  solana $solana_address  operator keyid $keyid"
done

# ── The peering secrets ──────────────────────────────────────────────────────
# §1.4's shared secret, one per peering, written into BOTH participants' key
# directories. A `[[peers]]` entry takes `secret_file` as well as a literal
# `secret`, and this is why the file form exists: a peering secret in a
# committed config is a credential in a public repository.
for peering in $PEERINGS; do
  IFS=':' read -r id _chain payer payee <<<"$peering"
  secret_file="peer-$id-secret"
  if [[ ! -f "$(node_dir "$payer")/$secret_file" ]]; then
    openssl rand -hex 32 >"$(node_dir "$payer")/$secret_file"
    echo "generated the '$id' peering secret"
  fi
  cp "$(node_dir "$payer")/$secret_file" "$(node_dir "$payee")/$secret_file"
done

# The connector containers mount these directories READ-ONLY as uid 10001, so
# the files must be world-readable to them. They are mode 600 above for the
# host's sake; relax now that generation is done. These are disposable
# local-chain keys and none of them has ever held value anywhere else.
chmod -R a+rX "$KEYS"

# ── Funding ──────────────────────────────────────────────────────────────────
# The mock USDC must actually be ON the chain before anything mints from it. A
# `cast send` of `mint(...)` to an address with no code does NOT revert -- it
# is an ordinary call to a plain account -- so without this check a race
# against the anvil deploy reports a funded account and leaves an empty one.
# The compose anvil healthcheck gates on the same fact; this is the second
# half, for anyone running the script against a chain they brought up
# themselves.
if [[ "$(cast code "$MOCK_USDC" --rpc-url "$ANVIL_RPC" 2>/dev/null)" == "0x" ]]; then
  echo "ERROR: no contract at $MOCK_USDC on $ANVIL_RPC." >&2
  echo "       The settlement topology is not deployed yet -- DeployLocal.s.sol runs as part" >&2
  echo "       of the compose anvil service's startup. Wait for that container to report" >&2
  echo "       healthy (it gates on exactly this) and re-run." >&2
  exit 1
fi

for entry in $NODES; do
  IFS=':' read -r node _evm_index _solana_index <<<"$entry"
  dir="$(node_dir "$node")"

  evm_address="$(cast wallet address --private-key "0x$(cat "$dir/settlement.key")")"
  echo "$node: funding EVM settlement account $evm_address"
  cast send --rpc-url "$ANVIL_RPC" --private-key "$ANVIL_ACCOUNT0_KEY" \
    --value 100ether "$evm_address" >/dev/null
  # Mock USDC is MINTABLE (packages/contracts/test/mocks/MockERC20.sol), so
  # this is a mint rather than a transfer out of somebody's balance.
  cast send --rpc-url "$ANVIL_RPC" --private-key "$ANVIL_ACCOUNT0_KEY" \
    "$MOCK_USDC" "mint(address,uint256)" "$evm_address" 1000000000 >/dev/null
  echo "  100 ETH + 1000 USDC (6dp)"

  solana_address="$(solana address --keypair "$dir/settlement-solana-cli.json")"
  echo "$node: funding Solana settlement account $solana_address"
  solana airdrop 100 "$solana_address" --url "$SOLANA_RPC" >/dev/null
  echo "  100 SOL"
done

# ── The peering channels ─────────────────────────────────────────────────────
# A peer claim is a balance proof against a real payment channel. Nothing on
# the peer path READS the chain to verify one -- `ClaimBook` checks the
# signature against the `counterparty_key` its operator configured and nothing
# else (CF-23) -- so a topology could be rehearsed green against a channel
# that does not exist. It is opened and funded here anyway, for the same
# reason `two_connectors_peer.rs`'s fixture opens and funds one: a claim that
# names a channel nobody could redeem is not a payment, and the difference
# does not show up until someone tries.
for peering in $PEERINGS; do
  IFS=':' read -r id chain payer payee <<<"$peering"
  payer_config="$(node_config "$payer")"
  payee_config="$(node_config "$payee")"

  case "$chain" in
    evm)
      token_network="$(cast call "$TOKEN_NETWORK_REGISTRY" "getTokenNetwork(address)(address)" \
        "$MOCK_USDC" --rpc-url "$ANVIL_RPC")"
      config_must_name "$token_network" "$payer_config" "the deployed TokenNetwork"
      config_must_name "$token_network" "$payee_config" "the deployed TokenNetwork"

      payer_key="0x$(cat "$(node_dir "$payer")/settlement.key")"
      payer_address="$(cast wallet address --private-key "$payer_key")"
      payee_address="$(cast wallet address --private-key "0x$(cat "$(node_dir "$payee")/settlement.key")")"
      # Each side's `counterparty_key` is the OTHER side's derived settlement
      # address. This is the assertion the derivation exists for: change an
      # index in the topology table above without changing the committed
      # configs and the failure is here, by name, rather than as a peer claim
      # refused `signature_invalid` after a green start-up.
      config_must_name "$payer_address" "$payee_config" "$payer's EVM settlement address"
      config_must_name "$payee_address" "$payer_config" "$payee's EVM settlement address"

      # The id the committed config names. Read from the file rather than
      # recomputed, so this loop's job is the falsifiable one: make the chain
      # match what is committed, or say why it cannot.
      channel_id="$(sed -n 's/^channel_id = "\(0x[0-9a-f]\{64\}\)"$/\1/p' "$payer_config" | head -1)"
      if [[ -z "$channel_id" ]]; then
        echo "ERROR: $payer_config declares no [[peer_channels]] channel_id, but the topology" >&2
        echo "       table says '$payer' is the payer of the '$id' peering." >&2
        exit 1
      fi
      config_must_name "$channel_id" "$payee_config" "the '$id' peering's channel id"

      state="$(cast call "$token_network" "channels(bytes32)(uint256,uint8,uint256,uint256,address,address)" \
        "$channel_id" --rpc-url "$ANVIL_RPC" | sed -n 2p)"
      if [[ "$state" == "0" ]]; then
        # `openChannel` derives the id as keccak(p1, p2, channelCounter) with
        # the participants sorted, so it is deterministic ONLY on a chain
        # whose counter is where this topology expects it. That is what the
        # re-read below actually checks: a chain that has had other channels
        # opened on it produces a different id and this fails naming both.
        cast send --rpc-url "$ANVIL_RPC" --private-key "$payer_key" \
          "$token_network" "openChannel(address,uint256)" "$payee_address" 3600 >/dev/null
        state="$(cast call "$token_network" "channels(bytes32)(uint256,uint8,uint256,uint256,address,address)" \
          "$channel_id" --rpc-url "$ANVIL_RPC" | sed -n 2p)"
        if [[ "$state" == "0" ]]; then
          echo "ERROR: opened a channel between $payer_address and $payee_address on" >&2
          echo "       $token_network, and it did NOT land at the id the committed config names:" >&2
          echo "         $channel_id" >&2
          echo "       That id is keccak(participant1, participant2, channelCounter), so this" >&2
          echo "       means the chain is not fresh -- something else opened a channel on this" >&2
          echo "       TokenNetwork first. 'make local-down && make local-up' resets it." >&2
          exit 1
        fi
        echo "'$id': opened channel $channel_id"
      fi

      # `setTotalDeposit` pulls from the payer's own balance and takes a
      # TOTAL, so this is both the funding and the idempotence.
      cast send --rpc-url "$ANVIL_RPC" --private-key "$payer_key" \
        "$MOCK_USDC" "approve(address,uint256)" "$token_network" "$CHANNEL_DEPOSIT" >/dev/null
      cast send --rpc-url "$ANVIL_RPC" --private-key "$payer_key" \
        "$token_network" "setTotalDeposit(bytes32,address,uint256)" \
        "$channel_id" "$payer_address" "$CHANNEL_DEPOSIT" >/dev/null
      echo "'$id': $payer deposited $CHANNEL_DEPOSIT (6dp USDC) into $channel_id"
      ;;

    solana)
      payer_account="$(base58 "$("$CONNECTOR" send \
        --operator-key "$(node_dir "$payer")/settlement-solana.key" --print-keyid)")"
      payee_account="$(base58 "$("$CONNECTOR" send \
        --operator-key "$(node_dir "$payee")/settlement-solana.key" --print-keyid)")"
      config_must_name "$payer_account" "$payee_config" "$payer's Solana settlement key"
      config_must_name "$payee_account" "$payer_config" "$payee's Solana settlement key"

      # The channel PDA the deployed program would use for these two
      # participants: `find_program_address(["channel", min, max, mint])`
      # (packages/solana-program/src/processor.rs). Computed rather than read,
      # because it is a pure function -- and asserted against both committed
      # configs, which is what makes committing it legitimate.
      read -r channel_min channel_max <<<"$(sorted_solana_pair "$payer_account" "$payee_account")"
      channel_account="$(solana find-program-derived-address "$SOLANA_PROGRAM_ID" \
        string:channel "pubkey:$channel_min" "pubkey:$channel_max" "pubkey:$SOLANA_USDC_MINT" \
        --url "$SOLANA_RPC")"
      config_must_name "$channel_account" "$payer_config" "the '$id' peering's channel account"
      config_must_name "$channel_account" "$payee_config" "the '$id' peering's channel account"
      echo "'$id': channel account $channel_account"

      # NOT OPENED ON CHAIN, and said plainly rather than left to be noticed.
      # Opening one means submitting an `OpenChannel` instruction to the
      # deployed program, and nothing in this repository can do that from a
      # shell -- there is no `connector channel open` verb and the Solana CLI
      # cannot build an arbitrary instruction. The EVM leg above IS opened and
      # funded, so the honest summary of this directory is: a peering's claim
      # is real cryptography on both chains, and its collateral is real on
      # EVM only. Closing that gap is a tool, not a config change.
      ;;
  esac
done

echo
echo "keys for '$TOPOLOGY' are in $KEYS (gitignored)"
