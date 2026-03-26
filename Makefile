# Development workflow commands for Connector
# Run 'make help' to see all available commands

.PHONY: help build test lint clean anvil-up anvil-down anvil-logs solana-build solana-test solana-deploy-devnet

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
	@echo "  make lint                 Run linter"
	@echo ""
	@echo "Local Blockchain:"
	@echo "  make anvil-up             Start Anvil + Faucet (docker compose)"
	@echo "  make anvil-down           Stop Anvil + Faucet"
	@echo "  make anvil-logs           Follow docker compose logs"
	@echo ""
	@echo "Solana Program:"
	@echo "  make solana-build         Build Solana payment channel program"
	@echo "  make solana-test          Run Solana program tests"
	@echo "  make solana-deploy-devnet Deploy Solana program to devnet"
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

# Run linter
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf packages/connector/dist packages/shared/dist

# Local Blockchain (Anvil + Faucet)
anvil-up:
	docker compose up -d

anvil-down:
	docker compose down

anvil-logs:
	docker compose logs -f

# Solana Payment Channel Program
solana-build:
	cd packages/solana-program && cargo build-sbf

solana-test:
	cd packages/solana-program && cargo test-sbf

solana-deploy-devnet:
ifndef DEPLOYER_KEYPAIR
	$(error DEPLOYER_KEYPAIR is not set. Usage: make solana-deploy-devnet DEPLOYER_KEYPAIR=path/to/keypair.json [UPGRADE_AUTHORITY=path/to/authority.json] [PROGRAM_ID=<pubkey>])
endif
	./tools/solana/deploy.sh --network devnet --keypair $(DEPLOYER_KEYPAIR) \
		$(if $(UPGRADE_AUTHORITY),--upgrade-authority $(UPGRADE_AUTHORITY)) \
		$(if $(PROGRAM_ID),--program-id $(PROGRAM_ID))
