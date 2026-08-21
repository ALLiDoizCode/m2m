# Development workflow commands for Connector
# Run 'make help' to see all available commands

.PHONY: help build test lint clean local-build local-up local-down local-logs local-rehearse local-verify rust-build rust-test anvil-up anvil-down anvil-logs solana-up solana-down solana-logs solana-mint-usdc solana-build solana-test solana-deploy-devnet infra-up infra-down mina-build mina-test mina-deploy-devnet

# Default target - show help
help:
	@echo "Connector Development Commands"
	@echo "=============================="
	@echo ""
	@echo "Build:"
	@echo "  make rust-build           Build the Rust connector workspace"
	@echo "  make build                Build the npm workspaces (devnet faucet tooling)"
	@echo ""
	@echo "Testing:"
	@echo "  make rust-test            Run the Rust workspace tests"
	@echo "  make test                 Run the npm workspace tests"
	@echo "  make lint                 Run linter"
	@echo ""
	@echo "Local Blockchain (EVM):"
	@echo "  make anvil-up             Start Anvil + Faucet (docker compose --profile evm)"
	@echo "  make anvil-down           Stop Anvil + Faucet"
	@echo "  make anvil-logs           Follow EVM docker compose logs"
	@echo ""
	@echo "Local Blockchain (Solana):"
	@echo "  make solana-up            Start Solana test validator (docker compose --profile solana)"
	@echo "  make solana-down          Stop Solana validator"
	@echo "  make solana-logs          Follow Solana docker compose logs"
	@echo "  make solana-mint-usdc     Re-seed the mock-USDC mint (auto-run by solana-up/infra-up)"
	@echo ""
	@echo ""
	@echo "App behind connector: composition lives in the app repos"
	@echo "  (relay/store deploy/docker-compose.yml = connector + that app)."
	@echo ""
	@echo "Local Blockchain (All Chains):"
	@echo "  make infra-up             Start every chain the connector settles on (EVM + Solana)"
	@echo "  make infra-down           Stop them (volumes preserved)"
	@echo ""
	@echo "Solana Program:"
	@echo "  make solana-build         Build Solana payment channel program"
	@echo "  make solana-test          Run Solana program tests"
	@echo "  make solana-deploy-devnet Deploy Solana program to devnet"
	@echo ""
	@echo "Mina zkApp (NOT a connector settlement chain -- ADR 0002):"
	@echo "  make mina-build           Build Mina payment channel zkApp"
	@echo "  make mina-test            Run Mina zkApp tests"
	@echo "  make mina-deploy-devnet   Deploy Mina zkApp to devnet"
	@echo ""
	@echo "Local topologies (the shipped image against real chains):"
	@echo "  make local-up             Build the image, start the chains, provision keys, run it"
	@echo "  make local-rehearse       Send a real packet through it; non-zero unless fulfilled"
	@echo "  make local-verify         up + rehearse + down, as CI runs it"
	@echo "  make local-down           Stop it"
	@echo "  make local-logs           Follow its logs"
	@echo "  LOCAL_TOPOLOGY=<name>     Which topology: solo (default), two-hop, mixed-chain"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean                Remove build artifacts"

# Build the Rust connector workspace — the connector itself (ADR 0017).
rust-build:
	cargo build --workspace

# Run the Rust workspace tests, matching ci.yml's Rust Workspace Gate.
rust-test:
	cargo test --workspace --exclude payment-channel

# Build the surviving npm workspaces (devnet faucet tooling).
build:
	npm run build

# Run the surviving npm workspace tests.
test:
	npm test

# NOTE: "app behind the connector" composition lives in the APP repos
# (relay/store `deploy/docker-compose.yml` = connector + that app). The connector
# repo builds only the connector image.

# Run linter
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf packages/mina-zkapp/dist

# Local Blockchain — EVM (Anvil + Faucet)
anvil-up:
	docker compose --profile evm up -d

anvil-down:
	docker compose --profile evm down

anvil-logs:
	docker compose --profile evm logs -f

# Local Blockchain — Solana (Test Validator + Program Deploy)
# solana-build first: the validator loads target/deploy/payment_channel.so into
# GENESIS (infra/solana/entrypoint.sh's --bpf-program), so the .so must exist
# before the container starts. Without it the validator comes up with no
# payment-channel program at all and every settlement call fails.
solana-up: solana-build
	docker compose --profile solana up -d
	$(MAKE) solana-mint-usdc

solana-down:
	docker compose --profile solana down

solana-logs:
	docker compose --profile solana logs -f

# Re-seed the deterministic mock-USDC mint after a validator (re)create. The
# validator entrypoint runs `solana-test-validator --reset` on every start
# (see infra/solana/entrypoint.sh), which wipes the mint along with the rest
# of the chain state -- previously this required manually re-running
# infra/solana/create-usdc-mint.sh on the host, so every faucet USDC drip
# failed with TokenAccountNotFoundError until someone noticed (issue #351).
# The script is idempotent: it skips creation if the mint exists and always
# tops up the treasury.
#
# This FAILS the target when the mint cannot be seeded. It used to end in
# `|| echo "WARNING: ..."`, which is the silent-skip ADR 0007 bans in the same
# words it bans a chain-less test reporting `passed`: a `solana-up` that
# prints a warning and exits 0 leaves a validator with no USDC mint, and the
# committed `token_address` in every local connector config then names an
# account that does not exist. That surfaces later as an opaque settlement
# failure instead of here, as a missing CLI.
#
# It runs on the HOST because the beeman validator image ships no `spl-token`.
# That is the one non-container dependency in the local stack; see the script's
# own header.
solana-mint-usdc:
	@echo "Waiting for Solana validator to be ready..."
	@for i in $$(seq 1 60); do \
		docker compose --profile solana exec -T solana-validator curl -sf http://localhost:8899/health 2>/dev/null | grep -q ok && break; \
		sleep 2; \
	done
	@command -v spl-token >/dev/null 2>&1 || { \
		echo "ERROR: spl-token is not on PATH. The mock-USDC mint cannot be seeded, and a"; \
		echo "       validator without it cannot settle -- refusing to report success."; \
		echo "       Install the SPL token CLI: cargo install spl-token-cli"; \
		exit 1; \
	}
	@command -v solana >/dev/null 2>&1 || { \
		echo "ERROR: solana is not on PATH. Install the Solana CLI: https://solana.com/docs/intro/installation"; \
		exit 1; \
	}
	./infra/solana/create-usdc-mint.sh http://localhost:8899

# Local Blockchain — every chain the Rust connector actually settles on.
#
# There is no Mina profile. ADR 0002 drops Mina from the Rust connector (o1js
# proof generation is JavaScript-only and a Node sidecar was refused), so a
# local Mina node has no connector to serve -- the `mina-lightnet` service that
# used to live here was dialled by nothing in this repository, and the faucet's
# Mina leg points at PUBLIC devnet, not at it. `packages/mina-zkapp` is the
# separately deployed zkApp and keeps its own build/test/deploy targets below.
#
# infra-down intentionally does NOT pass -v (preserves existing per-profile volumes).
infra-up: solana-build
	docker compose --profile evm --profile solana up -d
	$(MAKE) solana-mint-usdc

infra-down:
	docker compose --profile evm --profile solana down

# ─────────────────────────────────────────────────────────────────────────────
# Local topologies (local/) -- the SHIPPED IMAGE, run against real containerised
# chains. Not a substitute for `make rust-test`, which covers the connector's
# behaviour far better by spawning its own chains per test (ADR 0007). This
# covers the one thing that cannot: that the image boots on a mounted config
# and serves a packet.
# ─────────────────────────────────────────────────────────────────────────────
LOCAL_TOPOLOGY ?= solo
LOCAL_COMPOSE := docker compose -f docker-compose.yml -f local/$(LOCAL_TOPOLOGY)/compose.yml \
	--profile evm --profile solana --profile $(LOCAL_TOPOLOGY)

# The connector services each topology runs, listed rather than discovered.
# `up -d --wait` with no arguments would start every service in the enabled
# profiles -- which includes the `faucet`, an app-layer service local/ has no
# business running (local/README.md, "Connector layer only"). Naming them keeps
# that decision visible instead of leaving it to a profile's membership.
LOCAL_NODES_solo := connector
LOCAL_NODES_two-hop := connector-a connector-b
LOCAL_NODES_mixed-chain := connector-a connector-b connector-c
LOCAL_NODES = $(LOCAL_NODES_$(LOCAL_TOPOLOGY))

# The image the topologies run. Built from this working tree, deliberately: the
# question is whether THIS commit's image boots, and pulling a published tag
# would answer it about some other commit.
local-build:
	docker build -f deploy/connector-rust/Dockerfile -t connector-rust:local .

# Chains first, then keys (they need a chain to be funded ON), then the
# connector (it needs the key files to exist before it will start). That order
# is why this is not one `up`.
# Both `--wait`s below are load-bearing rather than tidy.
#
# On the chains: anvil's health gate is "the TokenNetworkRegistry has code", so
# waiting is what makes the deploy complete before keys.sh mints against it.
# Without it `up -d` returns as soon as the containers start, and every step
# after races DeployLocal.s.sol -- a `cast send` of `mint(...)` to a codeless
# address does not revert, so the funding silently does nothing and the
# connector then dies resolving getTokenNetwork().
#
# On the connectors: this target's contract is that when it returns, the
# topology can be SENT TO. Their health gate is a real request to the client
# edge, so returning before that passes hands `local-rehearse` a connector that
# is merely "Started" -- the distinction ADR 0041 had to learn for the fleet:
# the container being Up is not sufficient evidence. In a multi-node topology
# each node also waits on the one it dials, so `--wait` here means every hop on
# the path is serving, not just the one the packet is handed to.
local-up: local-build solana-build
	@test -n "$(LOCAL_NODES)" || { \
		echo "ERROR: LOCAL_TOPOLOGY='$(LOCAL_TOPOLOGY)' has no LOCAL_NODES_ entry in this Makefile."; \
		echo "       Known topologies: solo two-hop mixed-chain."; \
		exit 1; \
	}
	$(LOCAL_COMPOSE) up -d --wait anvil solana-validator
	$(MAKE) solana-mint-usdc
	cargo build --release -p connector
	./local/keys.sh $(LOCAL_TOPOLOGY)
	$(LOCAL_COMPOSE) up -d --wait $(LOCAL_NODES)

# `-v`, and that matters. The named volumes here hold the connectors' claim
# journals, and both local chains wipe their own state on every start -- so
# keeping the journals across a down/up pairs a live watermark with a chain
# that no longer has the history behind it. Concretely it also makes the
# rehearsal's money assertion vacuous: a peered topology's sender proves the
# peering was paid by reading the payee's journal, and a journal left behind by
# the LAST run satisfies that read without this run having paid anything.
local-down:
	$(LOCAL_COMPOSE) down -v

local-logs:
	$(LOCAL_COMPOSE) logs -f

# The assertion. `connector send --expect-fulfill` exits non-zero on anything
# that is not a correctly-fulfilled packet, so this target's exit status is the
# verdict -- there is no output to grep and nothing that can pass by printing.
#
# A topology with a peering asks its `sender` for a second thing, because
# `--expect-fulfill` structurally cannot cover it: a peer claim's verdict rides
# back in `Toon-Claim-Ack` and never gates the packet, so a peering whose every
# claim was refused still fulfils. Those senders read the payee's own claim
# journal afterwards and exit non-zero if the crossing was carried for free.
local-rehearse:
	$(LOCAL_COMPOSE) --profile sender run --rm sender

# Bring it up, prove it, tear it down. What CI runs.
#
# The logs are dumped HERE rather than in a workflow step, because by the time
# a workflow step runs the containers are already gone -- `local-down` removes
# them, and it has to run on the failure path too or CI leaks a stack.
local-verify:
	$(MAKE) local-up
	@$(MAKE) local-rehearse; status=$$?; \
	if [ $$status -ne 0 ]; then \
		echo "=== rehearsal FAILED (exit $$status) -- logs follow ==="; \
		$(LOCAL_COMPOSE) logs --no-color --tail=200 || true; \
	fi; \
	$(MAKE) local-down; \
	exit $$status

# Solana Payment Channel Program
# Prepend the Solana CLI bin dir (ships `cargo-build-sbf`) to PATH so the build
# works even when that dir isn't on the caller's PATH (issue #238). Harmless if
# already present or absent.
SOLANA_BIN := $(HOME)/.local/share/solana/install/active_release/bin
solana-build:
	cd packages/solana-program && PATH="$(SOLANA_BIN):$$PATH" cargo build-sbf --tools-version v1.52

solana-test:
	cd packages/solana-program && PATH="$(SOLANA_BIN):$$PATH" cargo test-sbf

solana-deploy-devnet:
ifndef DEPLOYER_KEYPAIR
	$(error DEPLOYER_KEYPAIR is not set. Usage: make solana-deploy-devnet DEPLOYER_KEYPAIR=path/to/keypair.json [UPGRADE_AUTHORITY=path/to/authority.json] [PROGRAM_ID=<pubkey>])
endif
	./tools/solana/deploy.sh --network devnet --keypair $(DEPLOYER_KEYPAIR) \
		$(if $(UPGRADE_AUTHORITY),--upgrade-authority $(UPGRADE_AUTHORITY)) \
		$(if $(PROGRAM_ID),--program-id $(PROGRAM_ID))

# Mina Payment Channel zkApp
mina-build:
	npm run build --workspace=packages/mina-zkapp

mina-test:
	npm run test --workspace=packages/mina-zkapp

mina-deploy-devnet:
ifndef DEPLOYER_KEY
	$(error DEPLOYER_KEY is not set. Usage: make mina-deploy-devnet DEPLOYER_KEY=<base58-private-key>)
endif
	MINA_DEPLOYER_KEY=$(DEPLOYER_KEY) npx ts-node tools/mina/deploy-zkapp.ts --network https://api.minascan.io/node/devnet/v1/graphql
