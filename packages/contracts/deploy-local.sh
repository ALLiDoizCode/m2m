#!/bin/bash
# Deploy to local Anvil instance
source .env
forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast
