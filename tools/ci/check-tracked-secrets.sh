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

# Explicit allowlist for tracked files that are key-SHAPED by name but hold
# no real secret. Every entry needs a comment saying why. Empty today: the
# one file that used to be here (the Solana program keypair above) was
# untracked, not allowlisted, since program keypairs are exactly the class
# this guard exists to catch.
ALLOWLIST=(
  # path/to/file.key  # why this one is safe to track
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

violations=()
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if matches_pattern "$path" && ! is_allowlisted "$path"; then
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

echo "No tracked key-shaped files found."
