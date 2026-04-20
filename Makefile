# Development workflow commands for Connector
# Run 'make help' to see all available commands

.PHONY: help build test lint clean anvil-up anvil-down anvil-logs solana-up solana-down solana-logs solana-build solana-test solana-deploy-devnet mina-up mina-down mina-logs ator-up ator-down ator-logs ator-test standalone-test standalone-test-docker standalone-test-ator-public standalone-test-ator-p2p standalone-test-allowlist infra-up infra-down mina-build mina-test mina-deploy-devnet

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
	@echo "  make standalone-test-ator-public Run container-based standalone + public ATOR proxy E2E"
	@echo "  make standalone-test-ator-p2p    Run peer-to-peer ILP via public ATOR hidden services (SLOW)"
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
	@echo "Local Blockchain (ATOR):"
	@echo "  make ator-up              Start local ATOR network (3 DirAuth + 3 relay + 1 HS)"
	@echo "  make ator-down            Stop ATOR network + purge named volumes (-v)"
	@echo "  make ator-logs            Follow ATOR docker compose logs"
	@echo "  make ator-test            Run real-binary ATOR integration suite (requires ator-up)"
	@echo ""
	@echo "Local Blockchain (All Chains):"
	@echo "  make infra-up             Start all chains (EVM + Solana + Mina + ATOR)"
	@echo "  make infra-down           Stop all chains (EVM + Solana + Mina + ATOR; volumes preserved)"
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

# Run container-based standalone + public ATOR E2E — single connector container
# configured with transport=socks5 pointing at a live public Anyone proxy.
# Requires outbound internet (reaches real Anyone exit nodes).
# Gated behind STANDALONE_DOCKER=true + ATOR_PUBLIC=1 (set by this target).
standalone-test-ator-public:
	docker compose --profile standalone-ator-public build
	STANDALONE_DOCKER=true ATOR_PUBLIC=1 npm run test:standalone-ator-public --workspace=packages/connector

# Run peer-to-peer ILP over PUBLIC ATOR with two connector containers,
# each with its own anon sidecar hosting a hidden service. Proves the
# highest-fidelity standalone topology: container boundaries, anon binary,
# real public network, real HS rendezvous.
#
# SLOW (~3-7 minutes wall clock, public HS descriptor propagation dominates)
# and flaky by nature (public network). Nightly-dispatch only — do NOT add
# to PR CI. Gates: STANDALONE_DOCKER=1 + ATOR_PUBLIC_P2P=1.
standalone-test-ator-p2p:
	docker compose --profile standalone-ator-p2p build
	STANDALONE_DOCKER=1 ATOR_PUBLIC_P2P=1 npm run test:standalone-ator-p2p --workspace=packages/connector

# Run Tier-3 admin-API allowlist E2E — BLS + connector in separate containers
# on one compose bridge network. Admin port NOT published to host; BLS
# reaches it via compose DNS; connector's `allowedIPs` accepts bridge subnet.
# Zero-secret "local BLS" topology; cheap and deterministic.
standalone-test-allowlist:
	docker compose --profile standalone-allowlist build
	STANDALONE_DOCKER=true npm run test:standalone-allowlist --workspace=packages/connector

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

# Local Blockchain — ATOR (3 DirAuth + 3 relay + 1 HS; pinned anon v0.4.10.0-beta)
ator-up:
	docker compose --profile ator up -d

ator-down:
	docker compose --profile ator down -v

ator-logs:
	docker compose --profile ator logs -f

# make ator-test — requires `make ator-up` to have run first (does NOT auto-bring-up).
# Exits 0 with "no tests found" until 36.3/36.4 land the real-binary jest suites.
ator-test:
	@HOST_PORT="$$(docker compose port hs1 9050 2>/dev/null | awk -F: '{print $$2}')"; \
	if [ -z "$$HOST_PORT" ]; then \
		echo "ERROR: hs1 SOCKS port not reachable — run 'make ator-up' first" >&2; \
		exit 1; \
	fi; \
	echo "ATOR_SOCKS_PORT=$$HOST_PORT"; \
	ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=$$HOST_PORT \
	ECHO_HOST=hs1 WSS_ECHO_HOST=hs1 ECHO_PORT=5000 WSS_ECHO_PORT=5000 \
		npm run test:integration -w packages/connector -- --passWithNoTests --testPathPattern 'transport-ator-'

# Local Blockchain — All Chains (EVM + Solana + Mina + ATOR)
# infra-down intentionally does NOT pass -v (preserves existing per-profile volumes).
# Use per-profile *-down for volume purge (e.g. `make ator-down` removes ATOR volumes).
infra-up:
	docker compose --profile evm --profile solana --profile mina --profile ator up -d

infra-down:
	docker compose --profile evm --profile solana --profile mina --profile ator down

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
