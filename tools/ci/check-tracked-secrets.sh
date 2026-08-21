#!/usr/bin/env bash
# =============================================================================
# Tracked-key guard (issue #922)
#
# Fails the build when a key-shaped file is tracked in git. An ignore rule
# only stops a *new* commit from adding a file — it does nothing for one
# already in the index, which is exactly how
# crates/connector-settlement-solana/deploy/payment_channel-keypair.json
# survived (connector#920). This script is the check that would have caught
# it: it inspects `git ls-files`, not the working tree, so an ignored-but-
# already-tracked file still fails it.
#
# Prints PATHS ONLY. Never prints file contents, and never the matched glob
# alongside a `cat`/`grep -o` of the file — a CI log is not a safe place for
# key material.
# =============================================================================
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Key-shaped filename patterns, matched against each tracked file's basename
# by `matches_pattern` below. Kept in sync with connector#922's acceptance
# criteria; add a pattern here rather than special-casing a path below.
PATTERNS=(
  '*-keypair.json'
  '*.key'
  '*.secret'
  'deployer-wallet.json'
  'testnet-wallets.json'
)

# Explicit allowlist for tracked files that are key-shaped -- by name or by
# CONTENT (see `is_solana_keypair_json`) -- but hold no real secret. Every
# entry needs a comment saying why.
#
# Both entries below are deliberately committed throwaway local-chain
# material. They were previously not allowlisted and not caught either: their
# names match none of the PATTERNS above, so the guard simply never saw them.
# That is the hole the content check closes -- "this file is safe" is now a
# stated fact with a reason, rather than a coincidence of what it is called.
ALLOWLIST=(
  # The mock-USDC mint authority + USDC treasury source for the LOCAL Solana
  # validator and the devnet faucet box. Mints an unlimited supply of a mock
  # token that has no relationship to real USDC, and
  # infra/solana/create-usdc-mint.sh hard-refuses any RPC URL naming mainnet.
  infra/solana/usdc-authority.json
  # The mock-USDC mint's own keypair. Committed so the mint lands at the SAME
  # address across every `solana-test-validator --reset`, which is what lets a
  # committed connector.toml name it in `token_address`. Same mock token, same
  # mainnet refusal.
  infra/solana/usdc-mint.json
)

is_allowlisted() {
  local path="$1"
  for allowed in "${ALLOWLIST[@]:-}"; do
    [[ -n "$allowed" && "$path" == "$allowed" ]] && return 0
  done
  return 1
}

matches_pattern() {
  local path="$1"
  local base
  base="$(basename -- "$path")"
  for pattern in "${PATTERNS[@]}"; do
    # shellcheck disable=SC2053 -- intentional glob match, not literal compare
    if [[ "$base" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

# A Solana keypair file is a bare JSON array of 64 byte values, and it can be
# called ANYTHING -- `usdc-authority.json` matches no pattern above and is a
# real, spendable key. Name matching alone therefore cannot be the whole
# guard: it catches the conventional names and misses every other one.
#
# This reads a tracked file only far enough to decide its SHAPE and never
# prints, logs or echoes a byte of it. `head -c` bounds the read so a large
# tracked file costs nothing here.
is_solana_keypair_json() {
  local path="$1"
  [[ "$path" == *.json ]] || return 1
  [[ -f "$path" ]] || return 1
  local head_bytes
  head_bytes="$(head -c 4096 -- "$path" 2>/dev/null | tr -d '[:space:]')"
  # `[n,n,...]`, digits and commas only. A config JSON has braces, quotes or
  # letters and is rejected before the element count is ever considered.
  [[ "$head_bytes" =~ ^\[[0-9,]+\]?$ ]] || return 1
  local stripped="${head_bytes#[}"
  stripped="${stripped%]}"
  local count
  count="$(awk -F',' '{print NF}' <<<"$stripped")"
  [[ "$count" -eq 64 ]]
}

violations=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if is_allowlisted "$path"; then
    continue
  fi
  if matches_pattern "$path" || is_solana_keypair_json "$path"; then
    violations+=("$path")
  fi
done < <(git ls-files)

if [[ "${#violations[@]}" -gt 0 ]]; then
  echo "Tracked key-shaped file(s) found (paths only, contents never printed):" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "If this is really not a secret, add it to ALLOWLIST in $0 with a comment explaining why." >&2
  exit 1
fi

echo "No tracked key-shaped files found (checked names and Solana-keypair content)."
