# Reconciling a devnet box's checkout with `main`

Issue #1004. Both devnet boxes' `/root/connector` checkouts sit at **`39f72a6e`** with uncommitted
tracked modifications, so `git pull` refuses on either one and `fleet-ops`'s reconcile/deploy path
cannot move the checkout at all. This is the runbook that gets them to a clean `main` without
losing the handful of values that legitimately exist only on the box.

It is written for someone who wants to know what each command destroys **before** running it. Every
step says what it changes, and every step is followed by the check that proves it worked. The only
service touched before the last section is Watchtower, which is stopped in step 2 so it cannot
recreate a container mid-reconcile; everything that serves traffic keeps running until the bring-up
section, which is separate on purpose. Getting the checkout clean and redeploying from it are two
decisions, not one.

## The three classes

Every difference between a box and `main` is one of:

- **(a) Already committed, or obsolete** — discard on the box. Most of what `git status` shows is
  not drift at all; it is the box being 22 commits behind (9 of them touching `infra/`) while the
  same change landed in the repo, or config for the retired apex that `main` deleted outright.
- **(b) Genuinely box-local** — must survive the pull. Secrets, generated key material, and the live
  on-chain facts the repo commits a placeholder for on purpose.
- **(c) Uncaptured drift** — had to be committed before this runbook could be honest. Found one; see
  below. It is in `main` now, so on the box it is class (a).

## Inventory, taken against `main` on 2026-08-16

Both boxes: `HEAD 39f72a6e`, branch `main`, remote `https://github.com/toon-protocol/connector.git`,
no stashes.

### relay — `97.107.134.182`

| Path                                                             | Class             | Disposition                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/linode-relay/connector-rust.toml`                         | (a)               | `peer_expose`, `[[peers]] apex-relay`, `[[peer_channels]]` incl. the real funded `channel_id`. The apex is gone (#872/#960) and `main` removes the peering and its `apex-relay.secret` mount together. **Do not carry the live channel id forward** — its counterparty no longer exists. Discard. |
| `infra/linode-relay/docker-compose.relay.announce.yml`           | (a)               | `:rust-release` repoint (#1006) + the `wait_for_edge`/backoff loop (#997) + the dropped `apex-relay.secret` mount. Byte-equivalent to `main` modulo the mount. Discard.                                                                                                                           |
| `infra/linode-relay/docker-compose.relay.rust.yml`               | (a)               | `:rust-release` repoint (#1006). Discard.                                                                                                                                                                                                                                                         |
| `infra/linode-relay/docker-compose.relay.yml`                    | (a)               | `relay:release` repoint (#1006). Discard.                                                                                                                                                                                                                                                         |
| `infra/linode-relay/nginx/conf.d/node.conf`                      | (a)               | Variable upstreams + the two `/swap/ilp*` locations (#999). `main` spells the variable `$upstream` where the box has `$u`; same semantics. Discard.                                                                                                                                               |
| `infra/linode-relay/docker-compose.relay.swap.yml`               | (a) after this PR | Staged-add (`AM`). Everything in it is in `main` **except** `working_dir: /app/state`, which was class (c) — see below. Discard once this PR is merged.                                                                                                                                           |
| `infra/linode-relay/swap.config.json`                            | **(b)**           | Staged-add (`AM`). Carries the real leg-B `channels."evm:84532"[0].channelId` and `inventory."evm:84532"`. `main` commits the `0xdead…c0de` placeholder and `"0"` on purpose. **Re-apply after the pull.**                                                                                        |
| `docker-compose.relay.{announce,connector,watchtower}-label.yml` | (a)               | Untracked, and not in `main` — so they do not block the pull. `main` puts the Watchtower labels inline on the services themselves (#1006), which makes these three redundant. Delete after the pull.                                                                                              |
| `*.key`, `*.secret`, `.env`, `*.bak*`                            | (b)               | Gitignored by design. **Nothing in this runbook touches them** — `git reset --hard` does not remove untracked or ignored files.                                                                                                                                                                   |
| the `watchtower` container                                       | (a)               | Hand-run with `docker run` (no compose labels, unpinned `containrrr/watchtower`). `main` commits `docker-compose.relay.watchtower.yml` pinned at `1.7.1`. Needs the old container removed before adopting it — see the bring-up section.                                                          |

`main` also **adds** three files this box has never had: `connector-rust.swap-announce.toml`,
`docker-compose.relay.swap-announce.yml`, `docker-compose.relay.watchtower.yml`. The pull creates
them; only the watchtower one is brought up here.

### store — `45.79.173.113`

| Path                                                                                     | Class                          | Disposition                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/linode-store/connector-rust.toml` → `[[peers]]`/`[[peer_channels]]`/`peer_expose` | (a)                            | Same retired `apex-store` peering as the relay's. Discard.                                                                                                                                                                                                                                   |
| `infra/linode-store/connector-rust.toml` → `[announce] pay_channel`                      | **(b)**                        | The real funded channel. `main` commits `0xdead…c0de` deliberately (#822/#853/#871) and `the_store_announce_pay_channel_is_a_clearly_marked_placeholder` asserts it stays one. **Re-apply after the pull.**                                                                                  |
| `infra/linode-store/connector-rust.toml` → `[operator]`                                  | **(b), and the dangerous one** | `bearer_token` and `write_keys` are live credentials that exist **nowhere but this file**. `main` has no `[operator]` section at all, so a pull without a backup destroys the operator surface irrecoverably and silently. See "Class (b) at a tracked path" below.                          |
| `infra/linode-store/docker-compose.store.{announce,rust,yml}.yml`                        | (a)                            | `:release` repoints and Watchtower labels (#1006), plus `apex-store.secret` mounts `main` removes with the peering. Discard.                                                                                                                                                                 |
| `infra/linode-store/nginx/conf.d/node.conf`                                              | (a)                            | Variable upstream (#999); `$u` vs `main`'s `$upstream`. Discard.                                                                                                                                                                                                                             |
| `docker-compose.store.watchtower.yml`                                                    | (a), **blocks the pull**       | Untracked on the box, **tracked in `main`** — so `git pull` aborts with "untracked working tree file would be overwritten" before it changes anything. `main`'s version pins `containrrr/watchtower:1.7.1` (the box runs an unpinned tag) and moves the service label inline. Move it aside. |
| `docker-compose.store.connector-label.yml`                                               | (a)                            | Untracked, not in `main`, redundant once labels are inline. Delete after the pull.                                                                                                                                                                                                           |
| `docker-compose.store.announce.yml.bak2-pre997-1786897318`                               | (b)                            | An operator snapshot. It showed as untracked rather than ignored because `.gitignore`'s `*.bak-*` requires the `-` immediately after `.bak`; this PR adds `*.bak[0-9]*`. Harmless either way — leave it.                                                                                     |
| `*.key`, `*.secret`, `.env`, `*.bak*`                                                    | (b)                            | Gitignored. Untouched.                                                                                                                                                                                                                                                                       |

### The one class (c) find

`infra/linode-relay/docker-compose.relay.swap.yml` carried **`working_dir: /app/state`** on the box
and nowhere in the repo. It is load-bearing: the maker's embedded ConnectorNode opens its three
SQLite ledgers at literal `./data/...` paths — issued claims, received (redeemable) claims, and the
peer registry — so CWD alone decides whether they land on the `swap_node_state` volume or in the
container's writable layer. `swap-node` is this fleet's one Watchtower auto-redeploy target, so
"writable layer" means "discarded on the next `swap:release` publish". Committed in this PR and
guarded by `the_swap_node_runs_with_its_state_volume_as_cwd`.

## Class (b) at a tracked path — the standing hazard

Three of the box-local values live at paths git tracks, so **a pull would clobber them and a
`git checkout --`/`git reset --hard` would destroy them**. That is not a property of this
reconcile; it is true of every future one, and it is why step 0 below is a backup rather than a
convenience.

| Value                                   | File (tracked)                           | Why it is exposed                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[operator] bearer_token`, `write_keys` | `infra/linode-store/connector-rust.toml` | `RawOperatorConfig` takes both as **inline string literals**. Every other secret on this fleet is a path to a gitignored file (`[signer] key_file`, `[settlement.*.key] key_file`, `[[peers]] credential.secret_file`), which is exactly what lets those configs be committed verbatim. | **connector#1003** — add `bearer_token_file` / `write_keys_file`, validated the way `secret_file` is. Owned by another agent; not done here. Until it lands, this section has no committed representation and a reconcile deletes it. |
| `[announce] pay_channel`                | `infra/linode-store/connector-rust.toml` | Deliberate placeholder convention, guarded by a test. Not a secret — an on-chain id — so the exposure is data loss, not disclosure.                                                                                                                                                     | Either a `pay_channel_file` indirection alongside #1003's, or accept the re-apply step and keep it documented here. A `.gitignore` change cannot help: the file must stay tracked.                                                    |
| `channels[].channelId`, `inventory`     | `infra/linode-relay/swap.config.json`    | Same placeholder convention. The file is bind-mounted `:ro`, so the maker never writes back to it — the drift is entirely hand-applied, and re-applying by hand is the whole mechanism.                                                                                                 | Same shape of fix. Worth noting the maker's own mutable state is already elsewhere (`statePath` on the volume), so only these two literals need to move.                                                                              |

Do **not** try to solve this with `.gitignore` or `git update-index --skip-worktree`: both make the
box's copy invisible to `git status`, which converts a loud conflict into silent divergence — the
failure mode #1004 exists to end.

## Runbook

Do one box at a time and finish it before starting the other. The relay is the lower-risk of the two
(its only class (b) value is a swap config the maker rereads on restart); do it first.

Throughout: `$BK` is a backup directory **outside** the checkout, so it does not become new untracked
noise inside it.

### Step 0 — snapshot, on both boxes, before anything

```bash
ssh root@97.107.134.182          # then repeat everything for root@45.79.173.113
export BK=/root/reconcile-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BK"
cd /root/connector
git rev-parse HEAD | tee "$BK/HEAD.txt"
git status --porcelain=v1 | tee "$BK/status-before.txt"
cp -a infra/linode-relay "$BK/"      # store box: infra/linode-store
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | tee "$BK/containers-before.txt"
```

_Destroys:_ nothing. `cp -a` copies the **whole** directory including the gitignored key material and
`.env`, which is the point — after this, no later command in this runbook can lose anything.

_Verify:_ `ls "$BK"/linode-*/ | wc -l` is non-zero and `cat "$BK/HEAD.txt"` reads `39f72a6e…`. If
HEAD is not `39f72a6e`, stop — this inventory was taken against that commit and someone has moved
the box since.

> Keep `$BK` for the session. It contains real key material, so remove it (`rm -rf "$BK"`) once the
> box is verified healthy, and never copy it off the box.

### Step 1 — extract the class (b) values you will re-type

**store box only:**

```bash
grep -n 'pay_channel' infra/linode-store/connector-rust.toml
sed -n '/^\[operator\]/,$p' infra/linode-store/connector-rust.toml > "$BK/operator-section.toml"
wc -l "$BK/operator-section.toml"
```

**relay box only:**

```bash
python3 -c "import json;d=json.load(open('infra/linode-relay/swap.config.json'));\
print(d['channels']['evm:84532'][0]['channelId']);print(d['inventory']['evm:84532'])"
```

_Destroys:_ nothing; all reads.

_Verify:_ `operator-section.toml` is 3 lines (`[operator]`, `bearer_token`, `write_keys`) and starts
with `[operator]`. The relay prints a real `0x…` channel id and a non-zero inventory. Do not paste
either into a terminal you are recording, a ticket, or a chat.

### Step 2 — stop Watchtower on this box

```bash
docker stop watchtower
docker ps --filter name=watchtower
```

_Destroys:_ nothing. It suspends automatic redeploys for the duration. Do this **before** touching
the checkout: steps 4 and 5 briefly take `swap.config.json` off disk, and a Watchtower recreate
inside that window would find the bind-mount source missing — Docker then creates a **directory** at
that path, which both breaks the maker and makes the pull fail. The container comes back (relay:
replaced by the committed compose file; store: recreated by compose) in the bring-up section.

_Verify:_ the `docker ps` prints no running `watchtower`.

### Step 3 — unstage the relay's two staged adds

**relay box only.** `docker-compose.relay.swap.yml` and `swap.config.json` are in the index but not
in `HEAD` (`AM` in `git status`). That matters, because `git reset --hard` treats an index-only file
as a tracked file to be removed and **deletes it from the worktree** — including the live
`swap.config.json` the running maker is bind-mounted onto. Take them out of the index first so the
reset leaves them alone.

```bash
git rm --cached -q infra/linode-relay/docker-compose.relay.swap.yml infra/linode-relay/swap.config.json
git status --porcelain=v1
```

_Destroys:_ nothing on disk — `--cached` is index-only.

_Verify:_ both files now show as `??` rather than `AM`, and both still exist:
`ls -l infra/linode-relay/swap.config.json`.

### Step 4 — clear the tracked modifications

```bash
git reset --hard
git status --porcelain=v1
```

_Destroys:_ **every uncommitted change to a tracked file**, including the store's `[operator]`
section and `pay_channel`. This is the irreversible step, and step 0's `cp -a` is the only thing
standing behind it. It does **not** touch untracked or ignored files, so `*.key`, `*.secret`, `.env`,
the `*.bak*` snapshots, the `*-label.yml` overlays and (after step 3) the relay's two swap files all
survive.

_Verify:_ `git status --porcelain=v1` now lists **only `??` lines** — no ` M`, no `AM`. On the relay
that is the three `*-label.yml` files plus the two swap files from step 3. On the store it is
`docker-compose.store.watchtower.yml`, `docker-compose.store.connector-label.yml` and the `.bak2-`
snapshot.

### Step 5 — move the colliders aside and pull, back to back

`git pull` refuses — before changing anything — if an incoming file already exists untracked. On this
fleet that is three files. Run the `mv` and the `git pull` together: the pull puts `main`'s version
of each one straight back, so the gap where the path does not exist is one command long.

**relay box:**

```bash
mv infra/linode-relay/docker-compose.relay.swap.yml "$BK/box-swap.yml"
mv infra/linode-relay/swap.config.json              "$BK/box-swap.config.json"
git pull --ff-only origin main
```

**store box:**

```bash
mv infra/linode-store/docker-compose.store.watchtower.yml "$BK/box-store-watchtower.yml"
git pull --ff-only origin main
```

then, on either:

```bash
git log --oneline -1
git status --porcelain=v1
git diff HEAD --stat
```

_Destroys:_ nothing — the `mv` targets are inside `$BK`, which already holds a copy from step 0, and
`--ff-only` guarantees no merge commit and no conflict resolution. The running containers are
unaffected by the `mv`: a bind mount resolves to the inode the container was started with, so moving
the file changes nothing until that container is recreated — which is why step 2 stopped Watchtower,
the one thing that could recreate one unasked.

If the pull refuses, **stop and read the message**; do not reach for `--force`, `--rebase` or
`-X theirs`. A refusal here means the box has a commit the remote does not, which this inventory did
not find and which needs a human before it is thrown away.

_Verify:_ `git log --oneline -1` is the current `main` tip, `git status --porcelain=v1` shows a clean
tree apart from the leftover `??` overlays, and `git diff HEAD --stat` is empty. All three moved
paths exist again, now as `main`'s versions.

### Step 6 — put the class (b) values back

**store box** — edit `infra/linode-store/connector-rust.toml`:

1. Replace the `[announce] pay_channel = "0xdead…c0de"` line with the real value from step 1.
2. Append the three lines of `$BK/operator-section.toml` at the end of the file.

```bash
cat "$BK/operator-section.toml" >> infra/linode-store/connector-rust.toml
$EDITOR infra/linode-store/connector-rust.toml   # pay_channel
git diff --stat
```

**relay box** — put back the two `swap.config.json` literals. Take `main`'s file (it gained
`tokenNetworkAddress`, `blsPort: 8090` and new comments the box copy lacks) and edit the two values
into it — **do not** copy the box's old file back over it.

```bash
$EDITOR infra/linode-relay/swap.config.json      # channels[0].channelId, inventory
python3 -c "import json;json.load(open('infra/linode-relay/swap.config.json'))" && echo 'valid JSON'
git diff --stat
```

_Destroys:_ nothing.

_Verify:_ `git diff --stat` names **exactly one file** — `infra/linode-store/connector-rust.toml` on
the store, `infra/linode-relay/swap.config.json` on the relay — and nothing else. Any second file is
a mistake; `git checkout -- <that file>` and look again. Then confirm the values landed:

```bash
# store — `main` has exactly one `0xdeaddead…` (the pay_channel); after the edit there are none
grep -c '0xdeaddead' infra/linode-store/connector-rust.toml   # expect 0
grep -q '^\[operator\]' infra/linode-store/connector-rust.toml && echo 'operator present'
# relay — `main` has two (channelId and settlementPrivateKey); after the edit, one
grep -c '0xdeaddead' infra/linode-relay/swap.config.json      # expect 1 (settlementPrivateKey)
```

The relay's `settlementPrivateKey` placeholder stays as-is: the maker replaces it in memory from the
autogenerated identity (`SWAP_AUTOGEN_IDENTITY`), so a `0xdead…` there is correct on disk.

### Step 7 — delete the now-redundant label overlays

`main` puts the Watchtower labels inline on the services themselves, so these only add a file to the
`-f` list that contributes nothing.

```bash
# relay
rm -f infra/linode-relay/docker-compose.relay.{announce,connector,watchtower}-label.yml
# store
rm -f infra/linode-store/docker-compose.store.connector-label.yml
```

_Destroys:_ four one-service YAML fragments, each already copied into `$BK` by step 0. The running
containers keep their labels until they are recreated; the recreate in the next section applies the
same labels from the committed files.

_Verify:_ `git status --porcelain=v1` shows only the `.bak2-` snapshot on the store and nothing on
the relay, plus the single ` M` from step 6.

## Bring-up from the reconciled checkout

Separate from the reconcile, and the point where services actually restart.

> **Always spell the `-f` set; never run a bare `docker compose`.** The live projects are
> `linode-relay` and `linode-store`, and the project name comes from the directory of the **first
> `-f` file**, not from your shell's CWD — verified on the relay box with Compose v5.4.0, where
> `docker compose -f infra/linode-relay/docker-compose.relay.yml config` from `/root/connector` and
> `docker compose -f docker-compose.relay.yml config` from `infra/linode-relay` both report
> `name: linode-relay`. So the repo-root form the compose headers and `fleet-ops.yml` use, and the
> `cd`-into-the-box-directory form below, are equivalent; use either.
>
> A **bare** `docker compose` in `/root/connector` is the one that goes wrong: it resolves the
> repo-root dev-stack file and reports `name: connector`, a different project with no
> `connector-rust` service in it (issue #948, and `fleet-ops.yml`'s own comment on the same point).
>
> Also never pass `--remove-orphans`: each `-f` set covers only part of the project, so it would
> delete the services the current set does not name.

### relay

```bash
cd /root/connector/infra/linode-relay
docker compose -f docker-compose.relay.yml -f docker-compose.relay.rust.yml config -q
docker compose -f docker-compose.relay.yml -f docker-compose.relay.rust.yml up -d
docker compose -f docker-compose.relay.rust.yml -f docker-compose.relay.announce.yml up -d announce
docker compose -f docker-compose.relay.swap.yml up -d swap-node
```

Then adopt the committed Watchtower, which needs the hand-run container gone first — it carries no
compose labels, so compose cannot find it and would leave you with two Watchtowers polling the same
tags:

```bash
docker rm -f watchtower
docker compose -f docker-compose.relay.yml -f docker-compose.relay.rust.yml \
               -f docker-compose.relay.swap.yml -f docker-compose.relay.watchtower.yml \
               up -d watchtower
```

_Destroys:_ the running containers are recreated (a few seconds of downtime each) and the unpinned
Watchtower is replaced by `containrrr/watchtower:1.7.1`. Named volumes — `connector_rust_state`,
`relay_announce_state`, `swap_node_state` — are **not** touched by `up -d`.

**Do not bring up `swap-announce`.** `main` adds `docker-compose.relay.swap-announce.yml` and
`connector-rust.swap-announce.toml`, which this box has never run; that is a bring-up in its own
right (`docs/operators/swap-node-bringup.md`), not part of reconciling a checkout.

### store

```bash
cd /root/connector/infra/linode-store
docker compose -f docker-compose.store.yml -f docker-compose.store.rust.yml config -q
docker compose -f docker-compose.store.yml -f docker-compose.store.rust.yml up -d
docker compose -f docker-compose.store.rust.yml -f docker-compose.store.announce.yml up -d announce
docker compose -f docker-compose.store.yml -f docker-compose.store.rust.yml \
               -f docker-compose.store.announce.yml -f docker-compose.store.watchtower.yml \
               up -d watchtower
```

The store's existing `watchtower` (stopped in step 2) **does** carry
`com.docker.compose.project=linode-store`, so compose adopts and recreates it in place — no
`docker rm -f` needed, unlike the relay's. It loses the explicit
`container_name: watchtower` and comes back as `linode-store-watchtower-1`.

### Verify the fleet, from off-box

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://proxy.relay.devnet.toonprotocol.dev/ilp/identity
curl -sS -o /dev/null -w '%{http_code}\n' https://proxy.ario.devnet.toonprotocol.dev/ilp/identity
curl -sS -o /dev/null -w '%{http_code}\n' https://relay-ws.devnet.toonprotocol.dev/   # expect 426
```

and on each box, that the announce loop published rather than backing off:

```bash
docker logs --since 10m linode-relay-announce-1 2>&1 | grep -E '\[announce\] (OK|FAILED)' | tail -3
docker logs --since 10m linode-store-announce-1 2>&1 | grep -E '\[announce\] (OK|FAILED)' | tail -3
```

The store's operator surface is the one thing no public probe covers, and it is the thing step 6
restored by hand — check it explicitly, on-box:

```bash
docker logs --since 5m linode-store-connector-rust-1 2>&1 | grep -i operator
```

Finally, `.github/workflows/fleet-health.yml` on its next 15-minute run is the independent check;
`docs/operators/fleet-release-and-health.md` explains what it probes and what it does when a probe
fails.

## After both boxes are clean

`git status` on each box should be one modified file and nothing else, permanently — that is the
steady state until connector#1003 lands and the `[operator]`/`pay_channel` values can move behind
`*_file` paths. Once that is true, `fleet-ops`'s reconcile path works again and the fleet is
reproducible from committed config, which is the whole point of #1004.

**When #1003 does land**, step 6's store half changes shape rather than going away: the
`[operator]` section becomes committed config naming two paths, and the reconcile step becomes
"write the two secret files onto the box" — gitignored, so `git status` stops mentioning them at
all. Re-read this section then; the values themselves are still only ever recoverable from `$BK` or
from a rotation.

Remove the backup: `rm -rf "$BK"` on each box. It holds real key material.
