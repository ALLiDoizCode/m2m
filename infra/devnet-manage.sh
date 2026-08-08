#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TOON devnet lifecycle manager — provision, deploy, tear down, or probe the
# devnet fleet: TOON connector (apex) / Store-DVM / Relay.
#
# The self-hosted EVM/Solana/Mina chain boxes this script once managed were
# deleted 2026-07-19 — the devnet settles on PUBLIC chains now (Base Sepolia,
# public Solana devnet, public Mina devnet); see infra/linode/endpoints.json's
# own note. Recreating them here would be a live footgun (issue #819), not a
# restoration, so they are gone from this file too.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#   ./devnet-manage.sh up        Provision boxes + deploy all nodes
#   ./devnet-manage.sh store     Provision + deploy ONLY the store (DVM) box
#   ./devnet-manage.sh relay     Provision + deploy ONLY the relay box
#   ./devnet-manage.sh down      Stop containers (boxes stay, restart is fast)
#   ./devnet-manage.sh destroy   Delete all Linode boxes (loses chain state)
#   ./devnet-manage.sh status    Probe every public HTTPS endpoint
#   ./devnet-manage.sh redeploy  Pull latest images + restart containers
#   ./devnet-manage.sh verify-routes  Assert apex forwards g.proxy.relay.store + g.proxy.store → store-box
#   ./devnet-manage.sh ips       Print current box IPs
#   ./devnet-manage.sh dns       Sync Porkbun A-records to current box IPs
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
# DOMAIN is the devnet subdomain suffix — baked into nginx server_names, TLS
# cert names and each box's .env for envsubst. It is NOT the Porkbun-registered
# zone: Porkbun's `dns/editByNameType/<domain>/...` needs the bare registered
# domain, and `devnet.toonprotocol.dev` isn't one ("ERROR Invalid domain").
# PORKBUN_DOMAIN is that zone; update_dns() uses it, never DOMAIN (issue #819 —
# as written against DOMAIN, every update_dns call failed).
DOMAIN="${DOMAIN:-devnet.toonprotocol.dev}"
PORKBUN_DOMAIN="${PORKBUN_DOMAIN:-toonprotocol.dev}"
BRANCH="${BRANCH:-feat/devnet-multi-node}"
REPO_URL="https://github.com/toon-protocol/connector.git"
LINODE_API="https://api.linode.com/v4"
PORKBUN_API="https://api.porkbun.com/api/json/v3"

# Node definitions: label | type | root password.
# Live-verified 2026-08-06 against the Linode API (issue #819 comment): the
# fleet is `toon` (apex, label "toon") + `ario` (store, label "ario") + the
# new `relay` box (label "relay") — all g6-standard-2. The `store` key's
# label used to read "toon-devnet-store", which does not match the live
# "ario" label; get_box_ip would find nothing and `create_box` would stand up
# a SECOND store box.
declare -A NODE_LABELS=( [toon]=toon [store]=ario [relay]=relay )
declare -A NODE_TYPES=(  [toon]=g6-standard-2 [store]=g6-standard-2 [relay]=g6-standard-2 )
declare -A NODE_PASSWORDS=( [toon]="T00nDevN3t!N0DE2026" [store]="T00nDevN3t!ST0RE2026" [relay]="T00nDevN3t!RELAY2026" )

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

create_box() {  # key: toon|store|relay
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
  local r; r=$(porkbun "dns/editByNameType/$PORKBUN_DOMAIN/A/$sub" "$body")
  if printf '%s' "$r" | grep -q '"SUCCESS"'; then echo "  DNS $sub → $ip"; return; fi
  porkbun "dns/create/$PORKBUN_DOMAIN" "$body" | jq -r '"  DNS \(.status) \("'"$sub"'") → '"$ip"'"'
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
TOON_MNEMONIC=$mnemonic
LOG_LEVEL=info
ENV
    chmod +x infra/linode-store/bootstrap.sh infra/linode-store/init-letsencrypt.sh infra/linode-store/firewall.sh
    ./infra/linode-store/bootstrap.sh
  "
}

deploy_relay_node() {  # ip, toon_mnemonic
  # Modeled on deploy_store_node — infra/linode-relay/ mirrors infra/linode-store/
  # file for file (issue #816). RELAY_NOSTR_SECRET_KEY must carry over
  # byte-identical from deploy_toon_node's heredoc above: it is the relay
  # app's own Nostr identity, and clients already discovered it under this
  # pubkey (infra/linode-relay/.env.example).
  local ip=$1 mnemonic=$2
  wait_ssh "$ip"
  ssh_run "$ip" "
    set -e
    command -v git >/dev/null || apt-get install -y git curl
    [ -d /root/connector ] || git clone -b '$BRANCH' '$REPO_URL' /root/connector
    cd /root/connector && git pull --ff-only origin '$BRANCH' 2>/dev/null || true
    cat > infra/linode-relay/.env <<'ENV'
DOMAIN=$DOMAIN
LETSENCRYPT_STAGING=0
LETSENCRYPT_EMAIL=dev.jonathan.green@gmail.com
TOON_MNEMONIC=$mnemonic
RELAY_NOSTR_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000002
LOG_LEVEL=info
ENV
    chmod +x infra/linode-relay/bootstrap.sh infra/linode-relay/init-letsencrypt.sh infra/linode-relay/firewall.sh
    ./infra/linode-relay/bootstrap.sh
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
  for key in toon store relay; do
    local label="${NODE_LABELS[$key]}"
    local ip; ip=$(get_box_ip "$label")
    printf "  %-20s %s\n" "$label" "${ip:-not-found}"
  done
}

# Post-deploy regression guard for the apex routing table. The apex once dropped
# its store forward routes and paid writes to g.proxy.relay.store silently 404'd on
# the relay (the TOON client's DEFAULT write dest is g.proxy.relay.store, which —
# being MORE specific than the locally-terminated g.proxy.relay route — falls
# through to that terminate route under longest-prefix matching unless an explicit
# forward route exists). This queries the apex connector's LIVE route table via its
# keyless admin API from inside the toon box's docker network and asserts the store
# forward routes survived the deploy. Exits non-zero on a missing/mis-pointed route
# so a redeploy that drops them fails LOUDLY instead of silently misrouting.
#   g.proxy.relay.store -> store-box   (the client default write dest)
#   g.proxy.store       -> store-box
verify_routes() {
  local ip; ip=$(get_box_ip "${NODE_LABELS[toon]}")
  if [ -z "$ip" ]; then
    echo "  ❌  verify-routes: toon (apex) box not found" >&2
    return 1
  fi
  echo "==> Verifying apex route table (g.proxy.relay.store, g.proxy.store → store-box)"
  # Discover the connector container (compose names it *connector*) and dump the
  # live admin route table from inside the box's docker network (port 8081, keyless,
  # bound to the docker bridge only — not reachable from off-box).
  local routes_json
  routes_json="$(ssh_run "$ip" '
    c="$(docker ps --filter name=connector --format "{{.Names}}" | head -1)"
    [ -z "$c" ] && { echo "NO_CONNECTOR_CONTAINER" >&2; exit 3; }
    docker exec "$c" wget -qO- http://127.0.0.1:8081/admin/routes
  ' 2>/dev/null || true)"

  if [ -z "$routes_json" ] || printf '%s' "$routes_json" | grep -q NO_CONNECTOR_CONTAINER; then
    echo "  ❌  verify-routes: could not read /admin/routes from the apex connector" >&2
    return 1
  fi

  # GET /admin/routes returns Array<{prefix,nextHop,priority}>; use python3 for a
  # robust JSON check (avoids brittle ordering-dependent greps).
  local ok=1 prefix
  for prefix in g.proxy.relay.store g.proxy.store; do
    if printf '%s' "$routes_json" | ROUTES_PREFIX="$prefix" python3 -c '
import json, os, sys
prefix = os.environ["ROUTES_PREFIX"]
try:
    routes = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("  bad JSON from /admin/routes: %s\n" % e)
    sys.exit(2)
routes = routes.get("routes", routes) if isinstance(routes, dict) else routes
match = next((r for r in routes if r.get("prefix") == prefix), None)
if match is None:
    sys.exit(1)
sys.exit(0 if match.get("nextHop") == "store-box" else 1)
'; then
      echo "  ✅  route $prefix → store-box"
    else
      echo "  ❌  route $prefix → store-box  (MISSING or wrong nextHop)"
      ok=0
    fi
  done

  if [ "$ok" != 1 ]; then
    echo "  FAIL: apex routing regression — a required store forward route is missing." >&2
    echo "        Re-apply infra/linode-node/connector.yaml and redeploy the toon node." >&2
    return 1
  fi
  echo "  PASS: apex store forward routes intact."
  return 0
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
case "${1:-help}" in

up)
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  echo "==> [1/4] Provision boxes"
  for key in toon store relay; do create_box "$key"; done
  for key in toon store relay; do wait_box_running "${NODE_LABELS[$key]}"; done

  TOON_IP=$(get_box_ip "${NODE_LABELS[toon]}")
  STORE_IP=$(get_box_ip "${NODE_LABELS[store]}")
  RELAY_IP=$(get_box_ip "${NODE_LABELS[relay]}")

  echo "==> [2/4] Update DNS"
  update_dns "proxy.devnet"         "$TOON_IP"
  update_dns "faucet.devnet"        "$TOON_IP"
  # `proxy.ario` is the store box's paid edge, matching the g.toon.ario
  # prefix it serves. It replaced `proxy.store.devnet` on 2026-08-05; that
  # name is RETIRED -- record deleted, dropped from the certificate and from
  # nginx's server_name. Do not re-add it here: recreating the record would
  # resurrect a name nothing serves, and the next `certbot renew` would still
  # not cover it.
  update_dns "proxy.ario.devnet"    "$STORE_IP"
  update_dns "dvm.devnet"           "$STORE_IP"
  update_dns "proxy.relay.devnet"   "$RELAY_IP"
  # `relay-ws.devnet` points at the RELAY box, not the apex (#820 / #815).
  # It used to point at the apex because the apex's TLS lineage was NAMED
  # relay-ws.devnet.toonprotocol.dev and carried proxy.devnet + faucet.devnet
  # as SANs on it, so moving the record before the SAN came off would have
  # failed renewal for all three sixty days later. Both preconditions are now
  # met in this tree: the apex's nginx no longer names relay-ws in any
  # server_name or backend map, its lineage is re-primaried on
  # proxy.devnet.toonprotocol.dev (infra/linode-node/nginx/conf.d/node.conf,
  # infra/linode-node/init-letsencrypt.sh) and the relay container is gone
  # from that box. The relay box serves relay-ws itself, off a SEPARATELY
  # issued cert lineage of its own (#830 — never bundled into one
  # all-or-nothing SAN request): infra/linode-relay/nginx/conf.d/node.conf +
  # infra/linode-relay/init-letsencrypt.sh.
  update_dns "relay-ws.devnet"      "$RELAY_IP"

  echo "==> [3/4] Deploy all nodes (parallel)"
  deploy_toon_node "$TOON_IP" "$TOON_MNEMONIC" &
  PID_TOON=$!

  deploy_store_node "$STORE_IP" "$TOON_MNEMONIC" &
  PID_STORE=$!

  deploy_relay_node "$RELAY_IP" "$TOON_MNEMONIC" &
  PID_RELAY=$!

  wait $PID_TOON  && echo "  ✅ TOON done"  || echo "  ❌ TOON failed"
  wait $PID_STORE && echo "  ✅ Store done" || echo "  ❌ Store failed"
  wait $PID_RELAY && echo "  ✅ Relay done" || echo "  ❌ Relay failed"

  echo "==> [4/4] Status check"
  "$0" status

  echo "==> [post-deploy] Route guard"
  verify_routes
  ;;

store)
  # Targeted: provision + deploy ONLY the store (DVM) box. Use this to add the
  # store node without `up` re-running bootstrap on the live chain/toon boxes
  # (which would re-pull images and re-provision the Mina lightnet).
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  echo "==> [1/3] Provision store box"
  create_box store
  wait_box_running "${NODE_LABELS[store]}"
  STORE_IP=$(get_box_ip "${NODE_LABELS[store]}")
  echo "==> [2/3] Update DNS"
  update_dns "proxy.ario.devnet"  "$STORE_IP"
  update_dns "dvm.devnet"         "$STORE_IP"
  echo "==> [3/3] Deploy store node"
  deploy_store_node "$STORE_IP" "$TOON_MNEMONIC"
  "$0" status
  ;;

relay)
  # Targeted: provision + deploy ONLY the relay box, modeled on `store` above.
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  echo "==> [1/3] Provision relay box"
  create_box relay
  wait_box_running "${NODE_LABELS[relay]}"
  RELAY_IP=$(get_box_ip "${NODE_LABELS[relay]}")
  echo "==> [2/3] Update DNS"
  update_dns "proxy.relay.devnet" "$RELAY_IP"
  # relay-ws.devnet belongs to this box too, post-#820 — see the `up)` case's
  # comment for why it used to sit on the apex and what had to land first.
  update_dns "relay-ws.devnet"    "$RELAY_IP"
  echo "==> [3/3] Deploy relay node"
  deploy_relay_node "$RELAY_IP" "$TOON_MNEMONIC"
  "$0" status
  ;;

down)
  echo "==> Stopping containers on all nodes"
  for key in toon store relay; do
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
        docker compose -f infra/linode-relay/docker-compose.relay.yml down 2>/dev/null || true
      fi
    " && echo "  $local_label stopped" || echo "  $local_label: could not stop"
  done
  ;;

destroy)
  echo "==> Deleting all devnet boxes (irreversible)"
  read -r -p "Are you sure? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
  for key in toon store relay; do
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
  probe "https://faucet.$DOMAIN/health"          "faucet"
  probe "https://proxy.$DOMAIN/health"           "proxy/connector"
  probe "https://relay-ws.$DOMAIN"               "relay-ws"
  # store/relay nginx has no `/health` location (only the apex's does, mapped
  # to /ilp/identity server-side) -- probing /health on either 404s even when
  # the box is healthy. /ilp/identity is the same unauthenticated liveness
  # read the operator runbook and both boxes' own CORS location use.
  probe "https://proxy.ario.$DOMAIN/ilp/identity"  "store (ario) proxy/connector"
  probe "https://dvm.$DOMAIN/health"               "store dvm"
  probe "https://proxy.relay.$DOMAIN/ilp/identity" "relay proxy/connector"
  ;;

redeploy)
  echo "==> Redeploying containers on all nodes (pulls latest images)"
  for key in toon store relay; do
    local_label="${NODE_LABELS[$key]}"
    ip=$(get_box_ip "$local_label") || continue
    [ -z "$ip" ] && echo "  $local_label: not found" && continue
    echo "  Redeploying $local_label ($ip)..."
    # The apex still declares the TypeScript `connector` service in its base
    # compose file (issue #872 is its removal; out of scope here) -- redeploy
    # must bring up the RUST connector on the public door (verified live:
    # `GET /ilp/identity` answers, nginx 410s the transitional `/rust/` prefix
    # because Rust took over `location /`) without starting that service,
    # which is pinned to `ghcr.io/toon-protocol/connector:3.36.3-solchan.0`,
    # an image purged from GHCR -- a blanket `pull`/`up -d` over the whole
    # file fails outright on it (issue #851).
    #
    # Naming services is NOT enough to exclude it: `nginx` declares
    # `depends_on: connector` in the base file (docker-compose.node.yml), and
    # `up` pulls a named service's dependencies into the graph anyway.
    # `required: false` does not help -- it tolerates a dependency that is
    # missing or unhealthy, it does not stop compose from creating one that IS
    # declared, so the purged image is still fetched and the whole `up` aborts
    # on `manifest unknown`, taking nginx and connector-rust down with it.
    # `--no-deps` is what actually excludes it. (`pull` needs no such flag:
    # it ignores dependencies already.) `compose`/`services` are split out
    # only so these lines stay readable: the leg names its file set twice
    # (`pull` then `up`) and its service set twice, and the two must not
    # drift from each other.
    #
    # store and relay have no TypeScript service left to dodge (issue #901
    # deleted the store's, along with its now-dangling `nginx` `depends_on`;
    # the relay leg never had one, issue #816) -- both simply compose their
    # base file with their Rust overlay and bring up every service in the
    # file set, no service list and no `--no-deps` needed.
    if [ "$key" = "toon" ]; then
      compose="docker compose -f infra/linode-node/docker-compose.node.yml -f infra/linode-node/docker-compose.node.rust.yml"
      services="relay faucet nginx certbot connector-rust"
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && $compose pull $services && $compose up --build -d --no-deps $services" &
    elif [ "$key" = "store" ]; then
      compose="docker compose -f infra/linode-store/docker-compose.store.yml -f infra/linode-store/docker-compose.store.rust.yml"
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && $compose pull && $compose up -d" &
    else
      # Always both files together, since the connector-rust service is only
      # defined in the overlay -- see the store leg's note above, which this
      # leg's shape is now identical to.
      compose="docker compose -f infra/linode-relay/docker-compose.relay.yml -f infra/linode-relay/docker-compose.relay.rust.yml"
      ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && $compose pull && $compose up -d" &
    fi
  done
  wait
  "$0" status

  echo "==> [post-deploy] Route guard"
  verify_routes
  ;;

verify-routes) verify_routes ;;

ips) print_ips ;;

dns)
  echo "==> Syncing Porkbun DNS to current box IPs"
  TOON_IP=$(get_box_ip "${NODE_LABELS[toon]}")
  STORE_IP=$(get_box_ip "${NODE_LABELS[store]}")
  RELAY_IP=$(get_box_ip "${NODE_LABELS[relay]}")
  [ -n "$TOON_IP" ] && update_dns "proxy.devnet" "$TOON_IP"        || echo "  ${NODE_LABELS[toon]} not found"
  [ -n "$TOON_IP" ] && update_dns "faucet.devnet" "$TOON_IP"       || true
  [ -n "$STORE_IP" ] && update_dns "proxy.ario.devnet" "$STORE_IP"  || echo "  ${NODE_LABELS[store]} not found"
  [ -n "$STORE_IP" ] && update_dns "dvm.devnet" "$STORE_IP"        || true
  [ -n "$RELAY_IP" ] && update_dns "proxy.relay.devnet" "$RELAY_IP" || echo "  ${NODE_LABELS[relay]} not found"
  # relay-ws.devnet follows the relay box, not the apex, post-#820 — see the
  # `up)` case's comment.
  [ -n "$RELAY_IP" ] && update_dns "relay-ws.devnet" "$RELAY_IP"    || true
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
      "evm": "0xF29fD62C4848B9573C9b90adbF61b664F386d9CF",
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
      "evm": "0xF29fD62C4848B9573C9b90adbF61b664F386d9CF",
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
  # Selected by pattern, not by line number: the header above grows, and a
  # fixed `sed -n '2,10p'` range starts printing prose instead of commands the
  # moment it does.
  echo "TOON devnet lifecycle manager. Usage:"
  grep -E '^#   \./devnet-manage\.sh ' "$0" | sed 's/^#//'
  exit 1
  ;;
esac
