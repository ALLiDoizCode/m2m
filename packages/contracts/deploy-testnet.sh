#!/bin/bash
# Deploy to Base Sepolia testnet with verification
source .env
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
