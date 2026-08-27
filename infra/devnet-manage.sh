#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TOON devnet lifecycle manager — provision, deploy, tear down, or probe the
# devnet fleet: Store-DVM / Relay.
#
# The apex ("toon"/g.toon proxy box) is GONE (issue #872, toon-meta#310 /
# toon-meta#313's live cutover): the fleet is two connector-bearing boxes now
# -- store and relay -- plus the separate, connector-less faucet box
# (connector#898). There is no forwarding hop and no peering left to verify;
# `g.toon` remains the namespace root in the wire protocol but nothing
# answers at it any more, so this script cannot target it either.
#
# The self-hosted EVM/Solana/Mina chain boxes this script once managed were
# deleted 2026-07-19 — the devnet settles on PUBLIC chains now (Base Sepolia,
# public Solana devnet); see infra/linode/endpoints.json's
# own note. Recreating them here would be a live footgun (issue #819), not a
# restoration, so they are gone from this file too.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#   ./devnet-manage.sh up        Provision boxes + deploy all nodes
#   ./devnet-manage.sh store     Provision + deploy ONLY the store (DVM) box
#   ./devnet-manage.sh relay     Provision + deploy ONLY the relay box
#   ./devnet-manage.sh faucet    Provision ONLY the faucet box (no connector — connector#898)
#   ./devnet-manage.sh faucet-cutover  Repoint faucet.devnet at the faucet box (run AFTER it's live)
#   ./devnet-manage.sh faucet-resize   Resize the faucet box to its NODE_TYPES plan (brief downtime)
#   ./devnet-manage.sh down      Stop containers (boxes stay, restart is fast)
#   ./devnet-manage.sh destroy   Delete all Linode boxes (loses chain state)
#   ./devnet-manage.sh status    Probe every public HTTPS endpoint
#   ./devnet-manage.sh redeploy  Pull latest images + restart containers
#   ./devnet-manage.sh ips       Print current box IPs
#   ./devnet-manage.sh dns       Sync Porkbun A-records to current box IPs
#
# There is no `endpoints` verb any more (issue #1135). It printed a JSON
# document assembled from three box labels that no longer exist
# (`toon-devnet-evm`, `toon-devnet-sol`, `toon-devnet-store` -- the store box's
# label is `ario`, see NODE_LABELS below), naming the self-hosted chains this
# header already says were deleted, their mock tokens, the retired
# `proxy.store.` edge, and a Solana payment-channel program id that was never
# deployed to public devnet and was already superseded on the self-hosted
# validator the day it was committed (the id itself, and its provenance, are
# recorded in the guard named below -- it is deliberately not repeated here, so
# there is one copy of a retired literal rather than two).
# `infra/linode/README.md` had already recorded the generator as retired -- this
# copy of it simply outlived that decision in a second file.
# `infra/linode/endpoints.json` is the hand-maintained record; read it, or
# `./devnet-manage.sh ips` for the boxes' current addresses.
# `crates/connector-settlement-solana/tests/solana_program_ids.rs` is what now
# fails the build if any committed file names a program id that is neither of
# the two this repository records.
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
# fleet was `toon` (apex, label "toon") + `ario` (store, label "ario") + the
# `relay` box (label "relay") — all g6-standard-2. Issue #872 (toon-meta#310 /
# toon-meta#313's live cutover) destroyed the apex; `toon` is no longer a key
# this script can create, deploy, or target. The `store` key's label reads
# "ario", not "toon-devnet-store" — get_box_ip would find nothing under the
# old name and `create_box` would stand up a SECOND store box.
declare -A NODE_LABELS=( [store]=ario [relay]=relay [faucet]=faucet )
# Sizing: the store box was measured on 2026-08-27 using ~125MB of RAM across
# all six of its containers, on a 4GB plan. g6-nanode-1 (1GB, 1 vCPU, 25GB) is
# ample for it and costs $5/mo against $24.
#
# The faucet is a nanode for the same reason and on the same evidence: it runs
# no connector, no chain and no validator — nginx, certbot and a Node process
# serving two HTTP drip routes, measured the same day at 99MB resident and
# 6.2GB of disk. It was sized to match the connector boxes only because its
# Mina leg compiled zk circuits at boot and needed the memory to do it; ADR
# 0065 deleted that leg, and the plan with it. The relay has NOT been measured
# and stays on g6-standard-2 until it is.
#
# NOTE: create_box returns early if a box with the label already exists, so
# changing a value here does NOT resize a live box. `./devnet-manage.sh
# faucet-resize` is the path for the FAUCET — deliberately that box only, since
# store and relay each run the connector, which is the client edge on both
# machines (ADR 0041), and resizing one of those is not a thing to reach for a
# generic command to do. Resizing the store is still a hand-made Linode API
# call (POST /linode/instances/<id>/resize with allow_auto_disk_resize) against
# a box whose disk usage already fits the smaller plan.
declare -A NODE_TYPES=(  [store]=g6-nanode-1 [relay]=g6-standard-2 [faucet]=g6-nanode-1 )
# Root passwords are GENERATED PER CREATE and thrown away — never committed,
# never printed, never reused. Nothing needs them: every path into a box in this
# file is `ssh -i "$SSH_KEY"` (see ssh_run below), and infra/harden-ssh.sh turns
# password authentication off on the box during bootstrap. The Linode API
# requires *a* root_pass on create, so we satisfy it with entropy.
#
# This replaces a hardcoded map of four passwords that lived in this file, in
# this PUBLIC repository, from 2026-06-23. Those values are in git history
# forever, so the boxes that were created with them MUST be rotated on the box
# — changing this file is not sufficient. See
# docs/operators/devnet-ssh-hardening.md.
#
# Linode rejects a password that does not span at least three of {lowercase,
# uppercase, digit, punctuation}. A purely random alphanumeric string misses a
# class often enough to matter (~1 create in 200), and the resulting API error
# would be baffling, so one of each is placed by construction and the rest is
# entropy.
new_root_pass() {
  local body
  body=$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 29)
  # One guaranteed lowercase, uppercase and digit, then shuffle so the fixed
  # classes are not always in the same position.
  printf '%s\n' "a" "R" "7" "$body" | tr -d '\n' | fold -w1 | shuf | tr -d '\n'
}

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

create_box() {  # key: store|relay|faucet
  local label="${NODE_LABELS[$1]}" type="${NODE_TYPES[$1]}"
  existing_ip="$(get_box_ip "$label")"
  if [ -n "$existing_ip" ]; then
    echo "  $label already exists ($existing_ip) — skipping create"
    return 0
  fi
  echo "  Creating $label ($type)..."
  linode_post "linode/instances" -d "{
    \"type\": \"$type\", \"region\": \"us-east\", \"image\": \"linode/ubuntu24.04\",
    \"root_pass\": \"$(new_root_pass)\",
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
  # byte-identical: it is the relay app's own Nostr identity, and clients
  # already discovered it under this pubkey (infra/linode-relay/.env.example).
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
  for key in store relay; do
    local label="${NODE_LABELS[$key]}"
    local ip; ip=$(get_box_ip "$label")
    printf "  %-20s %s\n" "$label" "${ip:-not-found}"
  done
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
case "${1:-help}" in

up)
  TOON_MNEMONIC="${TOON_MNEMONIC:-giant goat guide develop boy wolf target embody leave sunny paddle neutral}"
  echo "==> [1/4] Provision boxes"
  for key in store relay; do create_box "$key"; done
  for key in store relay; do wait_box_running "${NODE_LABELS[$key]}"; done

  STORE_IP=$(get_box_ip "${NODE_LABELS[store]}")
  RELAY_IP=$(get_box_ip "${NODE_LABELS[relay]}")

  echo "==> [2/4] Update DNS"
  # `proxy.ario` is the store box's paid edge, matching the g.toon.ario
  # prefix it serves. It replaced `proxy.store.devnet` on 2026-08-05; that
  # name is RETIRED -- record deleted, dropped from the certificate and from
  # nginx's server_name. Do not re-add it here: recreating the record would
  # resurrect a name nothing serves, and the next `certbot renew` would still
  # not cover it.
  update_dns "proxy.ario.devnet"    "$STORE_IP"
  update_dns "dvm.devnet"           "$STORE_IP"
  update_dns "proxy.relay.devnet"   "$RELAY_IP"
  # `relay-ws.devnet` points at the RELAY box (#820 / #815), off its own
  # SEPARATELY issued cert lineage (#830 — never bundled into one
  # all-or-nothing SAN request): infra/linode-relay/nginx/conf.d/node.conf +
  # infra/linode-relay/init-letsencrypt.sh. The apex it used to point at
  # (before that split landed) is gone entirely as of issue #872.
  update_dns "relay-ws.devnet"      "$RELAY_IP"

  echo "==> [3/4] Deploy all nodes (parallel)"
  deploy_store_node "$STORE_IP" "$TOON_MNEMONIC" &
  PID_STORE=$!

  deploy_relay_node "$RELAY_IP" "$TOON_MNEMONIC" &
  PID_RELAY=$!

  wait $PID_STORE && echo "  ✅ Store done" || echo "  ❌ Store failed"
  wait $PID_RELAY && echo "  ✅ Relay done" || echo "  ❌ Relay failed"

  echo "==> [4/4] Status check"
  "$0" status
  ;;

store)
  # Targeted: provision + deploy ONLY the store (DVM) box. Use this to add the
  # store node without `up` re-running bootstrap on the live chain/toon boxes
  # (which would re-pull images and re-provision the chain services).
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

faucet)
  # Targeted: provision ONLY the faucet box (toon-meta#310 §4, connector#898).
  # No TOON_MNEMONIC, no deploy_*_node call, and — unlike `store`/`relay`
  # above — no automatic DNS repoint here either: this box has no connector
  # (§4.5) and its USDC-only secrets are generated FRESH ON THE BOX by a
  # human (§4.4, never copied from box 1), so there is nothing this script
  # can write into a `.env` heredoc the way deploy_relay_node does for
  # RELAY_NOSTR_SECRET_KEY. And per the ordering §6.2 runbook, faucet.devnet
  # must not be flipped at provision time — the record moves only once the
  # NEW box is live, funded and proven serving, which is what stops this
  # command from prescribing the outage the runbook exists to prevent. (It
  # held the record on box 1 until then; that box is gone as of issue #872,
  # so the cutover below has already run.) `./devnet-manage.sh
  # faucet-cutover` (below) is what repoints it — see
  # docs/operators/faucet-box-bringup.md.
  echo "==> [1/2] Provision faucet box"
  create_box faucet
  wait_box_running "${NODE_LABELS[faucet]}"
  FAUCET_IP=$(get_box_ip "${NODE_LABELS[faucet]}")
  echo "==> [2/2] Provisioned at ${FAUCET_IP:-<not found>}"
  echo "Next (human, on the box): clone the repo, cd infra/linode-faucet,"
  echo "cp .env.example .env and fill in fresh keys, then run ./bootstrap.sh."
  echo "See docs/operators/faucet-box-bringup.md."
  ;;

faucet-cutover)
  # Separate, explicit action (toon-meta#310 §6.2 step 9 / toon-meta#313):
  # repoints faucet.devnet at the faucet box. Deliberately its own command,
  # not folded into `up`/`dns`/`faucet` above — run this ONLY after the new
  # box is live, funded and has served real traffic; see the ordered runbook
  # in docs/operators/faucet-box-bringup.md.
  FAUCET_IP=$(get_box_ip "${NODE_LABELS[faucet]}")
  [ -n "$FAUCET_IP" ] || { echo "ERROR: faucet box not found — run './devnet-manage.sh faucet' first." >&2; exit 1; }
  update_dns "faucet.devnet" "$FAUCET_IP"
  ;;

faucet-resize)
  # Move the LIVE faucet box onto NODE_TYPES[faucet]. Deliberately its own
  # verb and faucet-only: `store` and `relay` run the connector, which is the
  # client edge on both machines (ADR 0041), and resizing one of those is not a
  # thing to do by reaching for a generic command.
  #
  # Linode resizes by shutting the box down, migrating it and booting it again
  # — the faucet is OFFLINE for the duration, typically 10-20 minutes. The
  # compose stack comes back on its own (`restart: unless-stopped`); nothing
  # here needs to redeploy it.
  TARGET_TYPE="${NODE_TYPES[faucet]}"
  FAUCET_LABEL="${NODE_LABELS[faucet]}"
  FAUCET_ID=$(get_box_id "$FAUCET_LABEL")
  [ -n "$FAUCET_ID" ] || { echo "ERROR: faucet box not found." >&2; exit 1; }

  CURRENT_TYPE=$(linode_get "linode/instances/$FAUCET_ID" | jq -r '.type')
  if [ "$CURRENT_TYPE" = "$TARGET_TYPE" ]; then
    echo "==> faucet is already $TARGET_TYPE — nothing to do."
    exit 0
  fi

  # allow_auto_disk_resize below can only shrink a SINGLE ext filesystem (plus
  # swap). On any other layout Linode either refuses or leaves the disk at its
  # old size and the resize fails late; check first and say so, rather than
  # discovering it mid-migration with the box already down.
  DISKS=$(linode_get "linode/instances/$FAUCET_ID/disks")
  EXT_COUNT=$(echo "$DISKS" | jq '[.data[] | select(.filesystem != "swap")] | length')
  if [ "$EXT_COUNT" != "1" ]; then
    echo "ERROR: faucet has $EXT_COUNT non-swap disks; automatic disk resize handles exactly 1." >&2
    echo "Resize its disks by hand in the Linode UI first, then re-run." >&2
    exit 1
  fi

  # A shrink cannot succeed if the data does not fit the target plan's disk.
  TARGET_DISK=$(curl -sf "$LINODE_API/linode/types/$TARGET_TYPE" | jq -r '.disk')
  USED_DISK=$(echo "$DISKS" | jq '[.data[].size] | add')
  if [ -n "$TARGET_DISK" ] && [ "$USED_DISK" -gt "$TARGET_DISK" ]; then
    echo "ERROR: allocated disk is ${USED_DISK}MB but $TARGET_TYPE provides ${TARGET_DISK}MB." >&2
    exit 1
  fi

  echo "==> Resizing $FAUCET_LABEL ($FAUCET_ID): $CURRENT_TYPE -> $TARGET_TYPE"
  echo "    The faucet will be DOWN for roughly 10-20 minutes."
  linode_post "linode/instances/$FAUCET_ID/resize" \
    -d "{\"type\": \"$TARGET_TYPE\", \"allow_auto_disk_resize\": true}" >/dev/null
  wait_box_running "$FAUCET_LABEL"

  NEW_TYPE=$(linode_get "linode/instances/$FAUCET_ID" | jq -r '.type')
  echo "==> $FAUCET_LABEL is now $NEW_TYPE"
  echo "    Containers restart themselves; give them a moment, then:"
  probe "https://faucet.$DOMAIN/health" "faucet health"
  echo "    Re-check the drip legs too — /api/info must still report them ready."
  ;;

down)
  # store/relay only — the faucet box is brought up and down on the box
  # itself (infra/linode-faucet/bootstrap.sh), not from here. Same for
  # `redeploy` below. See docs/operators/faucet-box-bringup.md. The apex
  # ("toon") that used to sit alongside them here is gone (issue #872).
  echo "==> Stopping containers on the store/relay nodes"
  for key in store relay; do
    local_label="${NODE_LABELS[$key]}"
    ip=$(get_box_ip "$local_label") || continue
    [ -z "$ip" ] && echo "  $local_label: not found" && continue
    echo "  Stopping $local_label ($ip)..."
    ssh_run "$ip" "
      cd /root/connector 2>/dev/null || exit 0
      if [ '$key' = 'store' ]; then
        docker compose -f infra/linode-store/docker-compose.store.yml down 2>/dev/null || true
      else
        docker compose -f infra/linode-relay/docker-compose.relay.yml down 2>/dev/null || true
      fi
    " && echo "  $local_label stopped" || echo "  $local_label: could not stop"
  done
  ;;

destroy)
  # Covers the two CONNECTOR-BEARING boxes only. The faucet box (connector#898)
  # is provisioned by its own targeted case above and is not in this loop, so a
  # `destroy` here cannot take the faucet down with the fleet — delete it
  # explicitly if that is what you want. The apex ("toon") this loop once
  # covered too was destroyed live under toon-meta#313 and removed from this
  # script by issue #872 -- there is no key left here for it to target.
  echo "==> Deleting the store/relay devnet boxes (irreversible; NOT the faucet box)"
  read -r -p "Are you sure? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
  for key in store relay; do
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
  probe "https://relay-ws.$DOMAIN"               "relay-ws"
  # store/relay nginx has no `/health` location -- probing /health on either
  # 404s even when the box is healthy. /ilp/identity is the same
  # unauthenticated liveness read the operator runbook and both boxes' own
  # CORS location use.
  probe "https://proxy.ario.$DOMAIN/ilp/identity"  "store (ario) proxy/connector"
  probe "https://dvm.$DOMAIN/health"               "store dvm"
  probe "https://proxy.relay.$DOMAIN/ilp/identity" "relay proxy/connector"
  ;;

redeploy)
  echo "==> Redeploying containers on all nodes (pulls latest images)"
  for key in store relay; do
    local_label="${NODE_LABELS[$key]}"
    ip=$(get_box_ip "$local_label") || continue
    [ -z "$ip" ] && echo "  $local_label: not found" && continue
    echo "  Redeploying $local_label ($ip)..."
    # Neither surviving box has a TypeScript service left to dodge (issue
    # #901 deleted the store's, along with its now-dangling `nginx`
    # `depends_on`; the relay leg never had one, issue #816; the apex's own
    # copy of this hazard is gone with the apex itself, issue #872) -- both
    # simply compose their base file with their Rust overlay and bring up
    # every service in the file set, no service list and no `--no-deps`
    # needed.
    if [ "$key" = "store" ]; then
      compose="docker compose -f infra/linode-store/docker-compose.store.yml -f infra/linode-store/docker-compose.store.rust.yml"
    else
      compose="docker compose -f infra/linode-relay/docker-compose.relay.yml -f infra/linode-relay/docker-compose.relay.rust.yml"
    fi
    ssh_run "$ip" "cd /root/connector && git pull --ff-only 2>/dev/null || true && $compose pull && $compose up -d" &
  done
  wait
  "$0" status
  ;;

ips) print_ips ;;

dns)
  echo "==> Syncing Porkbun DNS to current box IPs"
  STORE_IP=$(get_box_ip "${NODE_LABELS[store]}")
  RELAY_IP=$(get_box_ip "${NODE_LABELS[relay]}")
  [ -n "$STORE_IP" ] && update_dns "proxy.ario.devnet" "$STORE_IP"  || echo "  ${NODE_LABELS[store]} not found"
  [ -n "$STORE_IP" ] && update_dns "dvm.devnet" "$STORE_IP"        || true
  [ -n "$RELAY_IP" ] && update_dns "proxy.relay.devnet" "$RELAY_IP" || echo "  ${NODE_LABELS[relay]} not found"
  # relay-ws.devnet follows the relay box, post-#820 — see the `up)` case's
  # comment. The apex it used to follow before that split is gone (#872).
  [ -n "$RELAY_IP" ] && update_dns "relay-ws.devnet" "$RELAY_IP"    || true
  echo "Done."
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
