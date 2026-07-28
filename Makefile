# Development workflow commands for Connector
# Run 'make help' to see all available commands

.PHONY: help build test lint clean rust-build rust-test anvil-up anvil-down anvil-logs solana-up solana-down solana-logs solana-mint-usdc solana-build solana-test solana-deploy-devnet mina-up mina-down mina-logs infra-up infra-down mina-build mina-test mina-deploy-devnet

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
	@echo "Local Blockchain (Mina):"
	@echo "  make mina-up              Start Mina lightnet (docker compose --profile mina)"
	@echo "  make mina-down            Stop Mina lightnet"
	@echo "  make mina-logs            Follow Mina docker compose logs"
	@echo ""
		@echo ""
	@echo "App behind connector: composition lives in the app repos"
	@echo "  (relay/store deploy/docker-compose.yml = connector + that app)."
	@echo ""
	@echo "Local Blockchain (All Chains):"
	@echo "  make infra-up             Start all chains (EVM + Solana + Mina)"
	@echo "  make infra-down           Stop all chains (EVM + Solana + Mina; volumes preserved)"
	@echo ""
	@echo "Solana Program:"
	@echo "  make solana-build         Build Solana payment channel program"
	@echo "  make solana-test          Run Solana program tests"
	@echo "  make solana-deploy-devnet Deploy Solana program to devnet"
	@echo ""
	@echo "Mina zkApp:"
	@echo "  make mina-build           Build Mina payment channel zkApp"
	@echo "  make mina-test            Run Mina zkApp tests"
	@echo "  make mina-deploy-devnet   Deploy Mina zkApp to devnet"
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
solana-up:
	docker compose --profile solana up -d
	$(MAKE) solana-mint-usdc

solana-down:
	docker compose --profile solana down

solana-logs:
	docker compose --profile solana logs -f

# Re-seed the deterministic mock-USDC mint after a validator (re)create. The
# validator entrypoint runs `solana-test-validator --reset` on every start
# (see infra/solana/entrypoint.sh), which wipes the mint along with the rest
# of the chain state — previously this required manually re-running
# infra/solana/create-usdc-mint.sh on the host, so every faucet USDC drip
# failed with TokenAccountNotFoundError until someone noticed (issue #351).
# The script is idempotent (skips creation if the mint exists, always tops up
# the treasury) and non-fatal here if spl-token/solana aren't on PATH yet,
# matching infra/linode/devnet.sh's mint_usdc() for the hosted devnet.
solana-mint-usdc:
	@echo "Waiting for Solana validator to be ready..."
	@for i in $$(seq 1 60); do \
		docker compose --profile solana exec -T solana-validator curl -sf http://localhost:8899/health 2>/dev/null | grep -q ok && break; \
		sleep 2; \
	done
	@./infra/solana/create-usdc-mint.sh http://localhost:8899 \
		|| echo "WARNING: USDC mint bootstrap failed (need spl-token + solana CLIs on PATH and a healthy validator)."

# Local Blockchain — Mina (Lightnet)
mina-up:
	docker compose --profile mina up -d

mina-down:
	docker compose --profile mina down

mina-logs:
	docker compose --profile mina logs -f

# Local Blockchain — All Chains (EVM + Solana + Mina)
# infra-down intentionally does NOT pass -v (preserves existing per-profile volumes).
infra-up: solana-build
	docker compose --profile evm --profile solana --profile mina up -d
	$(MAKE) solana-mint-usdc

infra-down:
	docker compose --profile evm --profile solana --profile mina down

# Solana Payment Channel Program
# Prepend the Solana CLI bin dir (ships `cargo-build-sbf`) to PATH so the build
# works even when that dir isn't on the caller's PATH (issue #238). Harmless if
# already present or absent.
SOLANA_BIN := $(HOME)/.local/share/solana/install/active_release/bin
solana-build:
	cd packages/solana-program && PATH="$(SOLANA_BIN):$$PATH" cargo build-sbf

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
