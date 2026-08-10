#!/usr/bin/env sh
# Write the throwaway key material docker-compose.local.yml mounts. LOCAL ONLY:
# the settlement key below is anvil's own published default account 0, which is
# public knowledge -- it is a test fixture, not a secret, and must never appear
# in a config that points at a real chain. Neither file is committed.
set -eu
cd "$(dirname "$0")"
mkdir -p secrets
# The connector's own identity key (ADR 0012: a location, never the key itself).
[ -f secrets/signer.key ] || openssl rand -hex 32 > secrets/signer.key
# anvil default account 0 -- the deployer that owns the local settlement topology.
printf 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' > secrets/settlement.key
printf 'secrets/ written\n'
