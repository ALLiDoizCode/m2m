# Fleet release and health

How a merge becomes a running devnet box, what stops a bad one, and how you find out when
something is down.

Decision records: [ADR 0041](../adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md),
[ADR 0066](../adr/0066-a-node-repository-pins-the-connector-nothing-here-moves-a-tag-onto-a-box.md).
Epic: toon-meta#403.

---

## The shape of it

The three boxes are no longer one shape. The **faucet** box still deploys from this repo
(`infra/linode-faucet/`, built on-box) and this document's release/rollback sections apply to it
only where noted. The **relay** and **store** (`ario`) boxes each deploy the connector from their
own repository's `deploy/` bundle — `toon-protocol/relay`, `toon-protocol/store` — pinning it by
release handle in exactly one place there. **Nothing in this repository moves a tag onto either
box any more** (ADR 0066): `fleet-ops.yml` no longer offers `box=relay`/`box=ario`, and
`promote-to-fleet.yml` is deleted.

`swap`, `store` and `relay` (the apps, not the connector boxes) keep the auto-on-green regime
toon-meta#403 accepted for devnet — a green merge in their own repos reaches the live box within
about a minute, under a label-scoped `containrrr/watchtower:1.7.1` (`--label-enable --interval 60
--cleanup`) each box runs. Watchtower does **no** health gating: it pulls, recreates, and
considers itself done. Whether the process then stayed up, or served anything, is not a question
it asks — which is why the health section below exists and is unaffected by any of this.

## Cutting a connector release

`release-connector.yml` still builds the image, cuts a dated release handle
(`2026.08.21.1` — UTC date, then that day's ordinal, never semver: see
[ADR 0055](../adr/0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md)) and opens a
GitHub Release naming the `rust-sha-<short>` tag to adopt. That is now the **whole** job:

```sh
gh workflow run release-connector.yml \
  -f reason="claim-state fix, verified on the relay"
```

Run it **on the commit you want released** — `gh workflow run --ref <branch-or-sha>` — and it must
be on `main`. It is `workflow_dispatch`-only, and stays that way: adding an automatic trigger would
reverse ADR 0041 Decision 3, which is still binding — `connector-rust` is the client edge on both
boxes, so an unreviewed digest reaching either is still a real risk even with no promotion left
here to guard against it.

**Adopting the build is a node repository's own change, not a step here.** Open a PR in
`toon-protocol/relay` or `toon-protocol/store` bumping its pinned connector tag to the `rust-sha-`
tag (or the release's `rust-<handle>` alias) the release names. That repo's own guard — a test that
fails if a second copy of the pin appears anywhere — is what keeps the pin singular; there is no
config-compatibility boot gate here to run first, because the config that pin boots against no
longer lives in this repository.

`:rust-release` is **frozen**. It used to be a promotion tag moved only by an explicit
`promote-to-fleet.yml` dispatch after booting the candidate against both boxes' committed
`connector-rust.toml`; ADR 0066 retired that mechanism because there is nothing left in this repo
for it to check. Do not wire anything to move it — a floating tag moving unsupervised shipped once
(#990) and was reverted, and there is even less reason to repeat it now.

## Rolling the faucet back

The faucet is the one box this repo still redeploys directly:

```sh
gh workflow run fleet-ops.yml -f operation=deploy -f service=faucet -f apply=true
```

For relay, store, and the auto-on-green apps (`swap`, `store`, `relay`), a rollback is that repo's
own concern: for an auto-on-green app, retag its own `:release` onto a known-good `sha-*` build and
let that box's Watchtower pick it up; for the connector on relay/store, bump the pin in
`toon-protocol/relay` / `toon-protocol/store` to an earlier `rust-sha-` build.

---

## What stops a config-breaking change

This is the failure that motivated the connector's promotion regime in the first place, and it is
still worth knowing even though the mechanism it produced is retired. On 2026-08-16 swap#134 added
a **required** `chainProviders[].tokenNetworkAddress`. It merged green, `swap:release` moved,
Watchtower recreated `swap-node`, and the maker crash-looped on `INVALID_CONFIG` — because the
box's bind-mounted `swap.config.json` is not in the image and nobody had added the key. It was down
until a human happened to look.

For `swap` (still auto-on-green, still deployed via a config this repo commits), the rule (ADR 0041) is unchanged:

| Where                                                      | Catches                                                              | When          |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `swap`'s `publish-swap-image.yml`, before `:release` moves | a new required key, **in the PR that adds it** — the tag stays put   | pre-deploy    |
| `fleet-health.yml`'s `config-compat` job                   | a mismatch that got in anyway, or a bad edit to the committed config | ≤15 min, cron |

**If you are adding a config key to an app that still deploys against a config this repo commits
(today, only `swap`):** give it a default. If it genuinely has no safe default (swap#134's did not
— defaulting it would have made the maker announce a contract that reverts for every client), then
it is a **breaking deploy**: land the key in the committed config here first, apply it, and only
then merge the app change.

For the connector on relay and store, this discipline is now each node repository's own to keep —
the config a build must boot against lives there, not here.

---

## Health checks and alerts

`.github/workflows/fleet-health.yml` runs every 15 minutes and on demand — schedule or dispatch
only (ADR 0066 removed the `workflow_call` trigger it used to fire after a promotion, along with
the promotion itself). It is strictly read-only on the boxes.

It does **not** take a hardcoded service list. It discovers "every container carrying the Watchtower
enable label" — precisely the set that can change without a human. A labelled service with no probe
defined is a **failure**, not a skip: opting a service into auto-redeploy without saying how to tell
whether it is serving is the omission the file exists to refuse.

Three things are checked, because each catches what the others cannot:

1. **Container state, sampled twice.** A crash-loop shows as `Up 3 seconds` on any single look; a
   rising `RestartCount` across the probe is the giveaway.
2. **A real serving probe.** `Up` is not evidence.
3. **The public edge, from the runner.** This is the one that catches connector#993's stale-nginx
   upstream: a recreate changes the container's Docker network IP, and an nginx that resolved the
   old one 502s to the world while loopback on the box looks perfect. Only an off-box request
   crosses nginx.

### The probes, and why these

| Service           | Probe                                      | Why                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector-rust`  | `GET 127.0.0.1:4000/ilp/identity` → 200    | The Rust connector has no `/health` — `/health`, `/healthz`, `/status`, `/` all 404, and `/metrics` is 404 on relay but 401 on store. `/ilp/identity` 200s only once the process is serving **and** has read its signer key. `fleet-ops.yml` already uses it. |
| `swap-node`       | `GET 127.0.0.1:8080/health` → 200          | `blsPort`, loopback-published. No public swap health surface exists.                                                                                                                                                                                          |
| `relay`, `store`  | container `HEALTHCHECK` verdict            | These two define one; reading Docker's verdict beats restating their probe here.                                                                                                                                                                              |
| `announce`        | `[announce] OK` in the last 15 min of logs | A loop publisher: no port, no healthcheck. Its printed verdict is the only honest signal. 15 min covers ~3 of its 240s iterations, so one slow publish is not an alert.                                                                                       |
| relay public edge | `proxy.relay…/ilp/identity` → 200          | crosses nginx                                                                                                                                                                                                                                                 |
| relay public edge | `relay-ws…/` → **426**                     | 426 Upgrade Required is the honest liveness signal for a WebSocket-only endpoint. A 200 there would mean something _other_ than the relay is answering.                                                                                                       |
| store public edge | `proxy.ario…/ilp/identity` → 200           | crosses nginx                                                                                                                                                                                                                                                 |

### How you find out

A failing run opens — or comments on — a single rolling issue in this repo:

> **`[fleet-health] devnet fleet is unhealthy`**, labelled `needs:human` + `bug`

`needs:human` is the org's existing human-queue label (toon-meta#347), so the alert lands in a queue
that is already swept rather than inventing a channel of its own. Opening an issue also notifies
everyone watching the repo, which a failed scheduled run does not do reliably — GitHub mails only
the cron's last editor.

The issue carries the full probe table and the rollback commands. **A later green run comments the
recovery and closes it**, so the issue's open/closed state _is_ the fleet's current verdict; you
never have to work out whether an old alert is still live. One issue, not one per failing run: a
fleet that stays down for an hour would otherwise open four.

### Known gap, not alerted on

`dvm.devnet.toonprotocol.dev` — the store app's public name — currently fails hostname verification.
DNS resolves to the store box and nginx routes the name correctly, but the box serves a certificate
whose only `subjectAltName` is `proxy.ario.devnet.toonprotocol.dev`; it was never reissued to cover
`dvm`. The store app therefore has no working public URL, and its health is observable only on-box.

It is deliberately **not** a fleet-health probe: it would alert forever on a pre-existing certificate
gap rather than on a deploy, which is how a monitor gets ignored. The runbook below closes the gap;
**add the probe only once it is applied**, not before.

## The store box's `dvm.` name has no certificate

### The verdict: reissue the certificate, do not retire the name

`dvm.devnet.toonprotocol.dev` is **not** vestigial, and the evidence was gathered before proposing
either direction (issue #1004):

- The repo already intends it to work, in four committed places: the `map $host $backend` entry
  (`infra/linode-store/nginx/conf.d/node.conf`) that routes it to `store:3400`, both `server_name`
  lines in the same file, the `DOMAINS=(…)` array in `infra/linode-store/init-letsencrypt.sh`, and
  three `update_dns "dvm.devnet" "$STORE_IP"` call sites plus a `status` probe and an `endpoints`
  JSON field in `infra/devnet-manage.sh`. Exactly one thing is out of step — the certificate.
- **The name still serves.** `curl -k https://dvm.devnet.toonprotocol.dev/health` returns the store
  app's live `DvmHealthResponse` (verified 2026-08-16). Only certificate _name verification_ fails,
  so every client that validates — which is all of them — is locked out.
- **It is the store app's only public liveness surface.** `proxy.ario…/ilp/identity` proves the
  _connector_ is up, not the app behind it. Retiring `dvm.` would delete the very thing this
  document calls a gap.
- **It is not a free door.** `store:3400` is the BLS health server, and `startStore`'s Hono app
  registers exactly one route on it: `GET /health`. This is a different port from `store:3300`, the
  payment-oblivious handler that serves `POST /store` — the free door removed on 2026-08-05 (see
  `node.conf`'s own `location /store` gravestone). Putting a valid certificate on `dvm.` exposes a
  read-only health JSON and nothing else.

Retiring it instead would mean edits in six committed places plus a DNS change, in a strict order
(`init-letsencrypt.sh`'s `DOMAINS` **first**, DNS record last — a lineage that lists a name which no
longer resolves fails HTTP-01 for _every_ name on it, taking the live paid edge down at the renewal
mark), to remove a surface nothing else provides. Reissuing costs one certbot run.

### The one repo-side defect this exposed

`init-letsencrypt.sh` issued under `--cert-name "${PRIMARY}"` = `proxy.ario.${DOMAIN}`, while the live
box's `nginx/conf.d/node.conf` loads `/etc/letsencrypt/live/proxy.store.devnet.toonprotocol.dev/`
(the inherited pre-rename lineage, kept on purpose). Running the script on that box as committed
would have issued a correct certificate into a **second** lineage nginx never reads — a silent
no-op. The script now takes a `CERT_NAME` override, defaulting to `PRIMARY` so a fresh box is
unaffected.

### Box commands (operator runs these; all four are on the store box)

```bash
ssh root@45.79.173.113
cd /root/connector
```

**1. Confirm the starting state** — one SAN, and the lineage nginx actually loads.

```bash
docker run --rm -v linode-store_store_certbot_conf:/etc/letsencrypt \
  --entrypoint sh certbot/certbot -c \
  'openssl x509 -noout -subject -dates -ext subjectAltName \
     -in /etc/letsencrypt/live/proxy.store.devnet.toonprotocol.dev/fullchain.pem'
```

Expect `subject=CN=proxy.ario.devnet.toonprotocol.dev` and a `Subject Alternative Name` listing only
`DNS:proxy.ario.devnet.toonprotocol.dev`. If it already lists `DNS:dvm.devnet.toonprotocol.dev`,
stop — the gap is closed and only the nginx reload in step 3 is outstanding.

**2. Expand the existing lineage.** This is `certonly … --expand` rather than
`./infra/linode-store/init-letsencrypt.sh`, deliberately: that script's not-ok path calls
`seed_dummy`, which **overwrites the live `fullchain.pem`/`privkey.pem` with a self-signed pair**
before it deletes and re-requests the lineage. If issuance then failed, the next nginx reload would
serve a self-signed certificate on `proxy.ario…` — the live paid edge. `certonly --expand` never
touches the lineage on disk unless issuance succeeds.

```bash
docker compose -f infra/linode-store/docker-compose.store.yml \
  run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/certbot \
  --cert-name proxy.store.devnet.toonprotocol.dev \
  -d proxy.ario.devnet.toonprotocol.dev \
  -d dvm.devnet.toonprotocol.dev \
  --expand --agree-tos --no-eff-email --non-interactive
```

_What this can destroy:_ on success, the lineage's `live/` symlinks move to a new certificate — the
previous one stays in `archive/` and nothing else on the box is touched. On failure, nothing changes
at all. No container is restarted. `--expand` is required because the name set differs from the
existing certificate's; without it certbot refuses rather than guessing. No `--email`: the account
(`4d89f17f…`) already exists in the volume and passing an address could rewrite it. Do **not** add
`--staging`; the live lineage is production-issued.

Re-run step 1 to confirm two SANs before continuing.

**3. Reload nginx** — it holds the certificate in memory from load time, so step 2 alone changes
nothing that a client sees.

```bash
docker compose -f infra/linode-store/docker-compose.store.yml exec nginx nginx -t
docker compose -f infra/linode-store/docker-compose.store.yml exec nginx nginx -s reload
```

`nginx -t` first: a reload with a bad config leaves the old worker serving, but there is no reason to
find out that way. Neither command restarts the container or drops a connection.

**4. Verify from off-box** (run this from your workstation, not the box):

```bash
curl -sS https://dvm.devnet.toonprotocol.dev/health   # no -k
curl -sS https://proxy.ario.devnet.toonprotocol.dev/ilp/identity
```

The first must return the store's health JSON **without** `-k`. The second is the regression check
that the paid edge still validates on its own name — it shares the lineage, so it is the thing an
expansion could break.

### Follow-up, only after step 4 passes

Add `https://dvm.devnet.toonprotocol.dev/health` to `.github/workflows/fleet-health.yml`'s probe set
(and delete the "deliberately not probed" comment above the probe list), and drop the "Known gap"
section above. Shipping the probe before the certificate is fixed is the failure mode that section
exists to avoid.

### Unrelated defect found while confirming the dependents

`rig`'s `DEVNET_DVM_URL` (`packages/rig/src/cli/name.ts`) defaults `--via` to
`https://dvm.devnet.toonprotocol.dev` for `rig name buy` / `rig name set` on devnet, and posts to
`${via}/store`. That path cannot work through this hostname even with a valid certificate: `dvm.`
maps to `store:3400`, the health server, while `POST /store` is served on `store:3300` and is not
exposed under any hostname (it was deleted as a free door on 2026-08-05). Fixing the certificate does
not fix the brokered ArNS buy. Tracked as toon-protocol/rig#101, which reaches the same conclusion
from the connector side — no node serves an unpaid `POST /store`, by design — and where this box's
half of the evidence is recorded.
