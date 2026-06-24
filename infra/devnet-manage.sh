#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TOON devnet lifecycle manager — provision, deploy, tear down, or probe the
# five-node devnet (EVM / Solana / Mina / TOON connector / Store-DVM).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#   ./devnet-manage.sh up        Provision boxes + deploy all nodes
#   ./devnet-manage.sh store     Provision + deploy ONLY the store (DVM) box
#   ./devnet-manage.sh down      Stop containers (boxes stay, restart is fast)
#   ./devnet-manage.sh destroy   Delete all Linode boxes (loses chain state)
#   ./devnet-manage.sh status    Probe every public HTTPS endpoint
#   ./devnet-manage.sh redeploy  Pull latest images + restart containers
#   ./devnet-manage.sh ips       Print current box IPs
#   ./devnet-manage.sh endpoints Generate endpoints.json from live nodes
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"            # connector repo root

# ── Load credentials ─────────────────────────────────────────────────────────
# Creds live in ~/.bashrc as export statements; load them whether interactive or not.
for var in LINODE_CLI_TOKEN PORKBUN_API_KEY PORKBUN_SECRET; do
  [ -n "${!var:-}" ] && continue
  val="$(grep -E "^[[:space:]]*export[[:space:]]+${var}=" ~/.bashrc | tail -1 | sed "s/.*=${var}=*//" | tr -d '"' || true)"
  [ -n "$val" ] && export "$var=$val"
done
: "${LINODE_CLI_TOKEN:?Need LINODE_CLI_TOKEN in ~/.bashrc}"
: "${PORKBUN_API_KEY:?Need PORKBUN_API_KEY in ~/.bashrc}"
: "${PORKBUN_SECRET:?Need PORKBUN_SECRET in ~/.bashrc}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
DOMAIN="${DOMAIN:-devnet.toonprotocol.dev}"
BRANCH="${BRANCH:-feat/devnet-multi-node}"
# STORE_TOON_MNEMONIC — the store (DVM) box connector's settlement seed. The
# store box PEERS with the apex, so this MUST be set (env-required; guarded in the
# `up` and `store` deploy paths) and MUST differ from the apex TOON_MNEMONIC, or
# the bilateral peer channel self-settles to 0xC0E55…. NOT committed. Its acct-0
# addresses (filled into the connector.yaml peer/route entries) are:
#   evm  0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e
#   sol  4AhgNKLgXi9NygSL85xrA1hcm3beHtXTHiEWQMhUMBvt
#   mina B62qn3RVqmEqg8k27yND4692JVTdaTAKdebCspSKck23WoDudFEbWbt
REPO_URL="https://github.com/toon-protocol/connector.git"
LINODE_API="https://api.linode.com/v4"
PORKBUN_API="https://api.porkbun.com/api/json/v3"

# Node definitions: label | type | profile | boot-script-path | subdomains
declare -A NODE_LABELS=( [evm]=toon-devnet-evm [sol]=toon-devnet-sol [mina]=toon-devnet-mina [toon]=toon [store]=toon-devnet-store )
declare -A NODE_TYPES=(  [evm]=g6-standard-1   [sol]=g6-standard-2  [mina]=g6-standard-4   [toon]=g6-standard-1 [store]=g6-standard-1 )
declare -A NODE_PASSWORDS=( [evm]="T00nDevN3t!EVM2026" [sol]="T00nDevN3t!SOL2026" [mina]="T00nDevN3t!MINA2026" [toon]="T00nDevN3t!N0DE2026" [store]="T00nDevN3t!ST0RE2026" )

# ── Linode helpers ─────────────────────────────────────────────────────────
linode_get() { curl -sf -H "Authorization: Bearer $LINODE_CLI_TOKEN" "$LINODE_API/$1"; }
linode_post() { local path=$1; shift; curl -sf -X POST -H "Authorization: Bearer $LINODE_CLI_TOKEN" -H "Content-Type: application/json" "$LINODE_API/$path" "$@"; }
linode_delete() { curl -sf -X DELETE -H "Authorization: Bearer $LINODE_CLI_TOKEN" "$LINODE_API/$1"; }
porkbun() { local path=$1 body=$2; curl -sf -X POST -H "Content-Type: application/json" "$PORKBUN_API/$path" -d "$body"; }

get_box_ip() {  # label → ipv4 or empty
  linode_get "linode/instances" | jq -r ".data[] | select(.label == \"$1\") | .ipv4[0]" 2>/dev/null || true
}
get_box_id() {
  linode_get "linode/instances" | jq -r ".data[] | select(.label == \"$1\") | .id" 2>/dev/null || true
}
get_box_status() {
  linode_get "linode/instances" | jq -r ".data[] | select(.label == \"$1\") | .status" 2>/dev/null || echo "not-found"
}

wait_box_running() {
  local label=$1
  echo "  Waiting for $label to be running..."
  for _ in $(seq 1 60); do
    [ "$(get_box_status "$label")" = "running" ] && return 0
    sleep 5
  done
  echo "ERROR: $label never reached running status" >&2; return 1
}

create_box() {  # key: evm|sol|mina|toon
  local key=$1 label="${NODE_LABELS[$1]}" type="${NODE_TYPES[$1]}"
  existing_ip="$(get_box_ip "$label")"
  if [ -n "$existing_ip" ]; then
    echo "  $label already exists ($existing_ip) — skipping create"
    return 0
  fi
  echo "  Creating $label ($type)..."
  linode_post "linode/instances" -d "{
    \"type\": \"$type\", \"region\": \"us-east\", \"image\": \"linode/ubuntu24.04\",
    \"root_pass\": \"${NODE_PASSWORDS[$key]}\",
    \"authorized_keys\": [\"$(cat "$SSH_KEY.pub")\"],
    \"label\": \"$label\", \"tags\": [\"toon-devnet\"], \"booted\": true
  }" | jq -r '"  Created \(.label) → \(.ipv4[0])"'
}

update_dns() {  # subdomain → ip
  local sub=$1 ip=$2
  local auth="{\"apikey\":\"$PORKBUN_API_KEY\",\"secretapikey\":\"$PORKBUN_SECRET\"}"
  local body; body=$(printf '%s' "$auth" | jq ". + {\"name\": \"$sub\", \"type\": \"A\", \"content\": \"$ip\", \"ttl\": \"600\"}")
  # Try edit-in-place first (avoids duplicate records). For a BRAND-NEW subdomain
  # the edit 4xx's, so `|| true` keeps `set -e` from killing us before the create
  # fallback runs. (curl -sf returns empty on failure → grep below is false.)
  local r; r=$(porkbun "dns/editByNameType/$DOMAIN/A/$sub" "$body" 2>/dev/null || true)
  if printf '%s' "$r" | grep -q '"SUCCESS"'; then echo "  DNS $sub → $ip"; return; fi
  porkbun "dns/create/$DOMAIN" "$body" 2>/dev/null | jq -r '"  DNS \(.status) \("'"$sub"'") → '"$ip"'"' || echo "  DNS create failed for $sub"
}

ssh_run() {   # ip, command
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=30 "root@$1" "$2"
}

wait_ssh() {
  local ip=$1
  for _ in $(seq 1 30); do
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 "root@$ip" true 2>/dev/null && return 0
    sleep 5
  done
  echo "ERROR: can't SSH to $ip" >&2; return 1
}

deploy_chains_box() {  # ip, profile, nginx_template, cert_primary, cert_domains
  local ip=$1 profile=$2 tmpl=$3 primary=$4 domains=$5
  wait_ssh "$ip"
  ssh_run "$ip" "
    set -e
    command -v git >/dev/null || apt-get install -y git curl
    [ -d /root/connector ] || git clone -b '$BRANCH' '$REPO_URL' /root/connector
    cd /root/connector && git pull --ff-only origin '$BRANCH' 2>/dev/null || true
    cat > infra/linode/.env <<'ENV'
DOMAIN=$DOMAIN
COMPOSE_PROFILES=$profile
NGINX_TEMPLATE=$tmpl
CERT_PRIMARY=$primary
CERT_DOMAINS="$domains"
LETSENCRYPT_EMAIL=dev.jonathan.green@gmail.com
LETSENCRYPT_STAGING=0
PUBLIC_IFACE=eth0
ENV
    chmod +x infra/linode/bootstrap.sh infra/linode/init-letsencrypt.sh infra/linode/firewall.sh
    cd infra/linode && ./bootstrap.sh
  "
}

deploy_toon_node() {  # ip, toon_mnemonic
  local ip=$1 mnemonic=$2
  wait_ssh "$ip"
  ssh_run "$ip" "
    set -e
    command -v git >/dev/null || apt-get install -y git curl
    [ -d /root/connector ] || git clone -b '$BRANCH' '$REPO_URL' /root/connector
    cd /root/connector && git pull --ff-only origin '$BRANCH' 2>/dev/null || true
    cat > infra/linode-node/.env <<'ENV'
DOMAIN=$DOMAIN
LETSENCRYPT_STAGING=0
LETSENCRYPT_EMAIL=dev.jonathan.green@gmail.com
TOON_MNEMONIC=$mnemonic
MINA_FAUCET_KEY=
RELAY_NOSTR_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000002
LOG_LEVEL=info
ENV
    chmod +x infra/linode-node/bootstrap.sh infra/linode-node/init-letsencrypt.sh infra/linode-node/firewall.sh
    ./infra/linode-node/bootstrap.sh
  "
}

deploy_store_node() {  # ip, toon_mnemonic
  local ip=$1 mnemonic=$2
  wait_ssh "$ip"
  ssh_run "$ip" "
    set -e
    command -v git >/dev/null || apt-get install -y git curl
    [ -d /root/connector ] || git clone -b '$BRANCH' '$REPO_URL' /root/connector
    cd /root/connector && git pull --ff-only origin '$BRANCH' 2>/dev/null || true
    cat > infra/linode-store/.env <<'ENV'
DOMAIN=$DOMAIN
LETSENCRYPT_STAGING=0
LETSENCRYPT_EMAIL=dev.jonathan.green@gmail.com
TOON_MNEMONIC=\"$mnemonic\"
LOG_LEVEL=info
ENV
    chmod +x infra/linode-store/bootstrap.sh infra/linode-store/init-letsencrypt.sh infra/linode-store/firewall.sh
    ./infra/linode-store/bootstrap.sh
  "
}

probe() {  # url, label
  if curl -fsS -m 10 -o /dev/null "$1" 2>/dev/null; then
    printf "  ✅  %-40s %s\n" "$2" "$1"
  else
    printf "  ❌  %-40s %s\n" "$2" "$1"
  fi
}

print_ips() {
  for key in evm sol mina toon store; do
    local label="${NODE_LABELS[$key]}"
    local ip; ip=$(get_box_ip "$label")
    printf "  %-20s %s\n" "$label" "${ip:-not-found}"
  done
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
case "${1:-help}" in

up)
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  : "${STORE_TOON_MNEMONIC:?Set STORE_TOON_MNEMONIC — the store box's DISTINCT settlement seed (must differ from the apex TOON_MNEMONIC; expected acct-0 evm 0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e)}"
  echo "==> [1/4] Provision boxes"
  for key in evm sol mina toon store; do create_box "$key"; done
  for key in evm sol mina toon store; do wait_box_running "${NODE_LABELS[$key]}"; done

  EVM_IP=$(get_box_ip toon-devnet-evm)
  SOL_IP=$(get_box_ip toon-devnet-sol)
  MINA_IP=$(get_box_ip toon-devnet-mina)
  TOON_IP=$(get_box_ip toon)
  STORE_IP=$(get_box_ip toon-devnet-store)

  echo "==> [2/4] Update DNS"
  update_dns "evm-rpc.devnet"       "$EVM_IP"
  update_dns "solana-rpc.devnet"    "$SOL_IP"
  update_dns "solana-ws.devnet"     "$SOL_IP"
  update_dns "mina.devnet"          "$MINA_IP"
  update_dns "mina-accounts.devnet" "$MINA_IP"
  update_dns "relay-ws.devnet"      "$TOON_IP"
  update_dns "proxy.devnet"         "$TOON_IP"
  update_dns "faucet.devnet"        "$TOON_IP"
  update_dns "proxy.store.devnet"   "$STORE_IP"
  update_dns "dvm.devnet"           "$STORE_IP"

  echo "==> [3/4] Deploy all nodes (parallel)"
  deploy_chains_box "$EVM_IP"  "evm"    "evm.conf.template" \
    "evm-rpc.$DOMAIN" "evm-rpc.$DOMAIN" &
  PID_EVM=$!

  deploy_chains_box "$SOL_IP"  "solana" "sol.conf.template" \
    "solana-rpc.$DOMAIN" "solana-rpc.$DOMAIN solana-ws.$DOMAIN" &
  PID_SOL=$!

  deploy_chains_box "$MINA_IP" "mina"   "mina.conf.template" \
    "mina.$DOMAIN" "mina.$DOMAIN mina-accounts.$DOMAIN" &
  PID_MINA=$!

  deploy_toon_node "$TOON_IP" "$TOON_MNEMONIC" &
  PID_TOON=$!

  deploy_store_node "$STORE_IP" "$STORE_TOON_MNEMONIC" &
  PID_STORE=$!

  wait $PID_EVM   && echo "  ✅ EVM done"   || echo "  ❌ EVM failed"
  wait $PID_SOL   && echo "  ✅ Sol done"   || echo "  ❌ Sol failed"
  wait $PID_MINA  && echo "  ✅ Mina done"  || echo "  ❌ Mina failed"
  wait $PID_TOON  && echo "  ✅ TOON done"  || echo "  ❌ TOON failed"
  wait $PID_STORE && echo "  ✅ Store done" || echo "  ❌ Store failed"

  echo "==> [4/4] Status check"
  "$0" status
  ;;

store)
  # Targeted: provision + deploy ONLY the store (DVM) box. Use this to add the
  # store node without `up` re-running bootstrap on the live chain/toon boxes
  # (which would re-pull images and re-provision the Mina lightnet).
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  : "${STORE_TOON_MNEMONIC:?Set STORE_TOON_MNEMONIC — the store box's DISTINCT settlement seed (must differ from the apex TOON_MNEMONIC; expected acct-0 evm 0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e)}"
  echo "==> [1/3] Provision store box"
  create_box store
  wait_box_running "${NODE_LABELS[store]}"
  STORE_IP=$(get_box_ip toon-devnet-store)
  echo "==> [2/3] Update DNS"
  update_dns "proxy.store.devnet" "$STORE_IP"
  update_dns "dvm.devnet"         "$STORE_IP"
  echo "==> [3/3] Deploy store node"
  deploy_store_node "$STORE_IP" "$STORE_TOON_MNEMONIC"
  "$0" status
  ;;

down)
  echo "==> Stopping containers on all nodes"
  for key in evm sol mina toon store; do
    local_label="${NODE_LABELS[$key]}"
    ip=$(get_box_ip "$local_label") || continue
    [ -z "$ip" ] && echo "  $local_label: not found" && continue
    echo "  Stopping $local_label ($ip)..."
    ssh_run "$ip" "
      cd /root/connector 2>/dev/null || exit 0
      if [ '$key' = 'toon' ]; then
        docker compose -f infra/linode-node/docker-compose.node.yml down 2>/dev/null || true
      elif [ '$key' = 'store' ]; then
        docker compose -f infra/linode-store/docker-compose.store.yml down 2>/dev/null || true
      else
        . infra/linode/.env 2>/dev/null || true
        docker compose -f docker-compose.yml -f infra/linode/docker-compose.linode.yml \
          --profile \$COMPOSE_PROFILES down 2>/dev/null || true
      fi
    " && echo "  $local_label stopped" || echo "  $local_label: could not stop"
  done
  ;;

destroy)
  echo "==> Deleting all devnet boxes (irreversible)"
  read -r -p "Are you sure? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
  for key in evm sol mina toon store; do
    local_label="${NODE_LABELS[$key]}"
    id=$(get_box_id "$local_label") || continue
    [ -z "$id" ] && echo "  $local_label: not found" && continue
    linode_delete "linode/instances/$id" && echo "  Deleted $local_label ($id)"
  done
  ;;

status)
  echo "Boxes:"
  print_ips
  echo
  echo "Public endpoints:"
  probe "https://evm-rpc.$DOMAIN"               "evm-rpc"
  probe "https://solana-rpc.$DOMAIN/health"      "solana-rpc"
  probe "https://mina.$DOMAIN/graphql"           "mina-graphql"
  probe "https://mina-accounts.$DOMAIN/list-acquired-accounts" "mina-accounts"
  probe "https://faucet.$DOMAIN/health"          "faucet"
  probe "https://proxy.$DOMAIN/health"           "proxy/connector"
  probe "https://relay-ws.$DOMAIN"               "relay-ws"
  probe "https://proxy.store.$DOMAIN/health"     "store proxy/connector"
  probe "https://dvm.$DOMAIN/health"             "store dvm"
  ;;

redeploy)
  echo "==> Redeploying containers on all nodes (pulls latest images)"
  for key in evm sol mina toon store; do
    local_label="${NODE_LABELS[$key]}"
    ip=$(get_box_ip "$local_label") || continue
    [ -z "$ip" ] && echo "  $local_label: not found" && continue
    echo "  Redeploying $local_label ($ip)..."
    if [ "$key" = "toon" ]; then
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && docker compose -f infra/linode-node/docker-compose.node.yml pull && docker compose -f infra/linode-node/docker-compose.node.yml up --build -d" &
    elif [ "$key" = "store" ]; then
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && docker compose -f infra/linode-store/docker-compose.store.yml pull && docker compose -f infra/linode-store/docker-compose.store.yml up -d" &
    else
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && source infra/linode/.env && docker compose -f docker-compose.yml -f infra/linode/docker-compose.linode.yml --profile \$COMPOSE_PROFILES pull && docker compose -f docker-compose.yml -f infra/linode/docker-compose.linode.yml --profile \$COMPOSE_PROFILES up -d" &
    fi
  done
  wait
  "$0" status
  ;;

ips) print_ips ;;

dns)
  echo "==> Syncing Porkbun DNS to current box IPs"
  EVM_IP=$(get_box_ip toon-devnet-evm)
  SOL_IP=$(get_box_ip toon-devnet-sol)
  MINA_IP=$(get_box_ip toon-devnet-mina)
  TOON_IP=$(get_box_ip toon)
  STORE_IP=$(get_box_ip toon-devnet-store)
  [ -n "$EVM_IP" ]  && update_dns "evm-rpc.devnet" "$EVM_IP"       || echo "  toon-devnet-evm not found"
  [ -n "$SOL_IP" ]  && update_dns "solana-rpc.devnet" "$SOL_IP"    || echo "  toon-devnet-sol not found"
  [ -n "$SOL_IP" ]  && update_dns "solana-ws.devnet" "$SOL_IP"     || true
  [ -n "$MINA_IP" ] && update_dns "mina.devnet" "$MINA_IP"         || echo "  toon-devnet-mina not found"
  [ -n "$MINA_IP" ] && update_dns "mina-accounts.devnet" "$MINA_IP"|| true
  [ -n "$TOON_IP" ] && update_dns "relay-ws.devnet" "$TOON_IP"     || echo "  toon not found"
  [ -n "$TOON_IP" ] && update_dns "proxy.devnet" "$TOON_IP"        || true
  [ -n "$TOON_IP" ] && update_dns "faucet.devnet" "$TOON_IP"       || true
  [ -n "$STORE_IP" ] && update_dns "proxy.store.devnet" "$STORE_IP" || echo "  toon-devnet-store not found"
  [ -n "$STORE_IP" ] && update_dns "dvm.devnet" "$STORE_IP"        || true
  echo "Done."
  ;;

endpoints)
  EVM_IP=$(get_box_ip toon-devnet-evm)
  SOL_IP=$(get_box_ip toon-devnet-sol)
  MINA_IP=$(get_box_ip toon-devnet-mina)
  TOON_IP=$(get_box_ip toon)
  STORE_IP=$(get_box_ip toon-devnet-store)
  # Pull the live Mina zkApp addresses the toon node was provisioned with (the
  # lightnet deploy is per-recreate, so read them from the box's connector.yaml).
  MINA_TOKEN=""; MINA_TOKENID=""; MINA_CHANNEL=""
  if [ -n "$TOON_IP" ]; then
    MINA_YAML="$(ssh_run "$TOON_IP" "sed -n '/chainType: mina/,/txFeeNanomina/p' /root/connector/infra/linode-node/connector.yaml" 2>/dev/null || true)"
    MINA_TOKEN="$(printf '%s' "$MINA_YAML"   | grep -E "tokenAddress:"  | sed -E "s/.*'(B62[^']+)'.*/\1/" || true)"
    MINA_TOKENID="$(printf '%s' "$MINA_YAML" | grep -E "tokenId:"       | sed -E "s/.*'([0-9]+)'.*/\1/"  || true)"
    MINA_CHANNEL="$(printf '%s' "$MINA_YAML" | grep -E "zkAppAddress:"  | sed -E "s/.*'(B62[^']+)'.*/\1/" || true)"
  fi
  cat <<JSON
{
  "_note": "TOON devnet — separate nodes per chain. Generated by devnet-manage.sh.",
  "evm": {
    "rpcUrl": "https://evm-rpc.${DOMAIN}",
    "chainId": 31337,
    "tokenAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "tokenDecimals": 6,
    "registryAddress": "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    "nodeIp": "${EVM_IP}"
  },
  "solana": {
    "rpcUrl": "https://solana-rpc.${DOMAIN}",
    "wsUrl": "wss://solana-ws.${DOMAIN}",
    "programId": "7CLmNaK9z6QgUWQpCFdeUTqfwXeZH5ssohAKtyXKY4Hp",
    "tokenMint": "H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H",
    "tokenDecimals": 6,
    "nodeIp": "${SOL_IP}"
  },
  "mina": {
    "graphqlUrl": "https://mina.${DOMAIN}/graphql",
    "accountsUrl": "https://mina-accounts.${DOMAIN}",
    "tokenAddress": "${MINA_TOKEN}",
    "tokenId": "${MINA_TOKENID}",
    "paymentChannelZkApp": "${MINA_CHANNEL}",
    "tokenDecimals": 6,
    "nodeIp": "${MINA_IP}",
    "_note": "zkApps deployed to the lightnet by provision-mina-lightnet.sh on each up (lightnet resets on recreate)"
  },
  "toon": {
    "relayWs": "wss://relay-ws.${DOMAIN}",
    "proxyIlp": "https://proxy.${DOMAIN}/ilp",
    "faucetUrl": "https://faucet.${DOMAIN}",
    "ilpAddress": "g.proxy.relay",
    "settlementAddresses": {
      "evm": "0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab",
      "solana": "A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK",
      "mina": "B62qkEx3MsKtaEJqJMg8ZC2eXtz8FNpZy4huVpBnnUHVRUEf5f1vqdq"
    },
    "nodeIp": "${TOON_IP}"
  },
  "store": {
    "proxyIlp": "https://proxy.store.${DOMAIN}/ilp",
    "dvmHealth": "https://dvm.${DOMAIN}/health",
    "ilpAddress": "g.proxy.store",
    "relayHopAddress": "g.proxy.relay.store",
    "dvmKinds": [5094],
    "settlementAddresses": {
      "evm": "0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab",
      "solana": "A3FG5y6rfBNJQrsGYTNNR7UHAXCREPJgV362LdTQGNwK",
      "mina": "B62qkEx3MsKtaEJqJMg8ZC2eXtz8FNpZy4huVpBnnUHVRUEf5f1vqdq"
    },
    "nodeIp": "${STORE_IP}"
  },
  "faucet": {
    "evmUrl": "https://faucet.${DOMAIN}/api/request",
    "solanaUrl": "https://faucet.${DOMAIN}/api/solana/request",
    "minaUrl": "https://faucet.${DOMAIN}/api/mina/request"
  }
}
JSON
  ;;

help|*)
  sed -n '2,10p' "$0"
  exit 1
  ;;
esac
