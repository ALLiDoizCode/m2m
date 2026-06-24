# Development workflow commands for Connector
# Run 'make help' to see all available commands

.PHONY: help build test lint clean anvil-up anvil-down anvil-logs solana-up solana-down solana-logs solana-build solana-test solana-deploy-devnet mina-up mina-down mina-logs standalone-test standalone-test-docker standalone-test-allowlist infra-up infra-down mina-build mina-test mina-deploy-devnet

# Default target - show help
help:
	@echo "Connector Development Commands"
	@echo "=============================="
	@echo ""
	@echo "Build:"
	@echo "  make build                Build all packages"
	@echo ""
	@echo "Testing:"
	@echo "  make test                 Run all tests"
	@echo "  make test-unit            Run unit tests only"
	@echo "  make standalone-test      Run standalone-mode E2E (smoke + settlement; requires anvil-up)"
	@echo "  make standalone-test-docker Run container-based standalone E2E (builds image + docker compose)"
	@echo "  make standalone-test-allowlist   Run Tier-3 admin-API allowlist E2E (BLS + connector in separate containers)"
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

# Build all packages
build:
	npm run build

# Run all tests
test:
	npm test

# Run unit tests only
test-unit:
	npm run test:unit --workspace=packages/connector

# Run standalone-mode E2E suite (smoke + settlement).
# Requires `make anvil-up` to have run first (settlement test hits real Anvil).
standalone-test:
	@if ! curl -s -o /dev/null -X POST http://localhost:8545 -H "Content-Type: application/json" \
		-d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'; then \
		echo "ERROR: Anvil not reachable on :8545 — run 'make anvil-up' first" >&2; \
		exit 1; \
	fi
	EVM_INTEGRATION=true npm run test:standalone --workspace=packages/connector

# Run container-based standalone E2E — builds the connector Docker image,
# brings up the compose stack (2 connector containers + 2 BLS containers),
# exercises the admin API + BTP + local delivery across container boundaries.
# The test itself owns compose lifecycle; we only need docker available.
standalone-test-docker:
	docker compose --profile standalone-e2e build
	STANDALONE_DOCKER=true npm run test:standalone-docker --workspace=packages/connector

# Run Tier-3 admin-API allowlist E2E — BLS + connector in separate containers
# on one compose bridge network. Admin port NOT published to host; BLS
# reaches it via compose DNS; connector's `allowedIPs` accepts bridge subnet.
# Zero-secret "local BLS" topology; cheap and deterministic.
standalone-test-allowlist:
	docker compose --profile standalone-allowlist build
	STANDALONE_DOCKER=true npm run test:standalone-allowlist --workspace=packages/connector

# NOTE: "app behind the connector" composition now lives in the APP repos
# (relay/store `deploy/docker-compose.yml` = connector + that app). The connector
# repo builds only the connector image; verify an app edge with the acceptance
# probes (scripts/app/ci-acceptance-probe*.ts) against the app repo's compose.

# Run linter
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf packages/connector/dist packages/shared/dist packages/mina-zkapp/dist

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

solana-down:
	docker compose --profile solana down

solana-logs:
	docker compose --profile solana logs -f

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
