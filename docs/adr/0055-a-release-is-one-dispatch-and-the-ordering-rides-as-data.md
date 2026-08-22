# A release is one dispatch, and the deploy ordering rides as data

**Status:** Proposed. Not accepted, not live. The workflow it describes is written
(`.github/workflows/release-connector.yml`) and asserted by
`crates/connector-bin/tests/fleet_release_gate.rs`, but no release has been cut with it and
`:rust-release` has not moved under it. Extends [0041](0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md);
reverses nothing in it. **0041's own Status line is deliberately untouched** — this folder's
convention has a record name its amender, but 0041 is Accepted and this one is not, and marking a
live record as amended by a proposal would make the proposal look binding. Add the back-reference
when this is accepted, not before.

**Scope:** deployment law for this fleet — not protocol. See the [ADR index](README.md).

A connector release is **one human dispatch and nothing else that a human does.** The dispatch
chooses a build; everything after it — build, version, GitHub Release, the config-compatibility
gate, the tag move, the health probe — is automated, in that order, in one run. The build is
named by a **monotonic release handle** (`2026.08.21.1`: UTC date, then that day's ordinal), never
by a semver version. The one fact a version number is usually overloaded to carry — "this deploy
has an ordering" — rides instead as a machine-readable field on the release,
`config-change-required: true|false`, which `promote-to-fleet.yml` reads and **refuses on** when it
is true and the committed box configs have not been landed and applied first.

What is automated is the labour. What is not automated, and must never be, is the choice of build.

## Context

### The five mechanical acts and the one judgement

Before this record, cutting a connector release meant: wait for the green-`main` build; find its
`rust-sha-` tag; decide what to call this state of the world; write that down somewhere;
dispatch `promote-to-fleet`; check the fleet came back. Six acts, of which five are mechanical and
one is a judgement — **which build should front the live devnet.** Each of the five had its own way
of being skipped, and "write that down somewhere" had no somewhere at all: there is no changelog,
no release series, and nothing that says what a given `:rust-release` digest was supposed to be.

Automating the five is uncontroversial. Automating the sixth is the thing this record is most
careful about, because it has already been done once by accident.

### Why a green `main` still must not deploy

[ADR 0041](0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md) Decision 3
is unambiguous:

> The connector image does not follow rule 1 by checking — it is not auto-deployed at all.
> `:rust-release` moves only by an explicit `promote-to-fleet` dispatch.

Its reasoning is specific to this image rather than a general preference for gates. `connector-rust`
is the client edge on **both** devnet boxes — every paid write on the devnet enters through it — and
`announce` runs the same image. One bad digest takes the whole devnet's paid-write path dark on two
machines at once. A bad `swap:release` takes down one maker sidecar; this does not compare.

That is not hypothetical either. connector#990 shipped
`type=raw,value=rust-release,enable={{is_default_branch}}` in the publish workflow, both boxes were
repointed at that tag under a label-scoped Watchtower, and every green merge reached the live client
edge on two machines within ~60 seconds, unvalidated. It was reverted, and
`the_build_workflow_publishes_candidates_and_never_moves_the_promotion_tag` has guarded the one-line
version of that mistake ever since.

A release workflow is the **multi-line** version of the same mistake waiting to happen. It builds,
versions, publishes and promotes; it is exactly one `workflow_run:` trigger away from being
auto-on-green with four extra steps in the middle, and that trigger would look like a convenience
rather than a reversal. So the constraint is stated here and asserted in the gate:
`release-connector.yml` is `workflow_dispatch` and nothing else, and
`the_release_workflow_is_dispatch_only` fails the build if a trigger is added.

### Why not semver

The obvious version scheme is the one the retired TypeScript connector had:
`semantic-release`, `X.Y.Z`, the contract in
[`CONNECTOR_RELEASE_CONTRACT.md`](../../CONNECTOR_RELEASE_CONTRACT.md). It is the wrong scheme here,
and `deploy/connector-rust/README.md` already said so about the image tags before this record
existed:

> There is no semver tag series here: no crate under `crates/` has a release process yet, and
> inventing one for the image alone would claim a stability contract the binary hasn't earned.

Every crate under `crates/` is `0.1.0`. Nothing in this repository decides what a MINOR means for
this binary, and no downstream is promised anything by one. A version series is a promise about
compatibility; publishing one the project has not made is worse than publishing no number at all,
because somebody eventually pins against it and reads a guarantee into the digits.

(`package.json` says `"version": "3.3.0"`. That is TypeScript-era residue belonging to the npm
packages under `packages/`, it is not this binary's version, and it is deliberately left alone.)

A dated ordinal says exactly what it knows: when this state of the world was cut, and in what order.
It is monotonic by construction, it sorts with `sort -V`, and it makes no claim it cannot keep.

### The fact a MAJOR bump is usually smuggled in to carry

The real argument for semver in a deployment context is rarely about API compatibility. It is
about **ordering**: a MAJOR is a flag that says "read the notes before you deploy this". That fact
is worth carrying. It is just badly carried by an integer, because no workflow can act on it.

ADR 0041 rule 2 states the ordering obligation directly:

> If no safe default exists, the key's introduction is a breaking deploy: the committed box config
> is updated and applied **first**, and the tag moves after.

And ADR 0041's own Context explains why stating it was not enough. swap#134's PR body said the same
sentence, about its own key, in the clearest possible terms —

> `/root/connector/infra/linode-relay/swap.config.json` on the relay box needs one added key
> **before** the new image boots, or the maker will refuse to start with `INVALID_CONFIG`.

— and the relay's maker crash-looped anyway. Not because the sentence was wrong or unclear, but
because a PR body is not read at the moment a tag moves. Nothing was watching, and there was
nothing for anything to watch.

So the ordering rides as a field a workflow can read. `config-change-required: true` on a release is
a claim, and `promote-to-fleet.yml` makes the claim cost something.

### What the ordering gate checks, and what it still cannot see

Two obligations follow from `config-change-required: true`. An earlier draft of this record made the
first a check and the second an **attestation** — a required string, recorded in the run summary and
believed. That was wrong, and it was wrong by this project's own standard: ADR 0041's thesis is that
"the enforceable half has to be a check on the config the fleet actually has", so an unverifiable
string is exactly the unenforceable half that record says is not sufficient. It cost every release
some friction and bought an audit line nobody could rely on. Both halves are checks now.

**One: the committed box configs must actually have changed** across the range this promotion
crosses. `git diff` over `infra/linode-relay/connector-rust.toml` and
`infra/linode-store/connector-rust.toml` between the incumbent's commit and the candidate's. A
release that says the fleet needs a config change while those files sat untouched is the 2026-08-16
shape exactly — the fix applied to the box and never committed, so a redeploy from the tree
reproduces the outage.

**Two: the boxes must actually have it**, evidenced by a named `fleet-ops.yml` `config-apply` run
that is then verified. Five conditions, each its own refusal, because each is a way a named run can
be real, green, and still not evidence:

| Checked                                                            | The run it rejects                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the run exists and its `path` is `.github/workflows/fleet-ops.yml` | a run id from some other workflow, or one that does not exist                                                                                                  |
| `conclusion == success`                                            | an apply that failed — it applied nothing                                                                                                                      |
| `operation == config-apply`                                        | `box-status`, `config-read`, `pin-verify`, `restart`, `deploy`, `announce` — none of which writes a config file                                                |
| `apply == true`                                                    | **a dry run.** The most dangerous of the five: a genuine `config-apply` with `apply=false` reads the box, prints the diff, writes nothing, and concludes green |
| the run **started after** the config's commit, per box             | an apply that predates the commit and therefore applied the previous file — the same outage with a receipt attached                                            |

Coverage is per box. Where both boxes' configs moved — the common case, since their settlement
blocks are deliberately identical — one run naming one box is a refusal, and `config_applied_run`
takes a list.

**Where that evidence comes from, and why the run has to state it.** A `workflow_dispatch` run's
inputs are not on the run object: it has no `inputs` key. `box`, `operation` and `apply` therefore
have to be recovered from somewhere, and the first version of this gate recovered them from the
runner's echo of `fleet-ops.yml`'s **job-level `env:` block** into the run log, read through
`actions: read`. That worked, and it aged badly by construction: logs are retained for 90 days, the
gate refuses what it cannot read, and so a real apply became unverifiable simply by getting old —
recoverable only by re-running an apply against a live box to freshen the evidence for something
that had already happened.

So `fleet-ops.yml` now **states the three facts on the run itself**, through a `run-name:` that
renders as `fleet-ops <operation> on <box> (apply=<true|false>)` and becomes the run's
`display_title`. That is on the run object and lasts as long as the run does. Only the three inputs
the gate checks appear in it, and all three are `choice` or `boolean`, so every field comes from a
fixed set; the free-form `service` input is deliberately left out, because free text inside a title
something else parses is how one run is made to read as another. Editing that file was not free —
it is on the live ops path — but the alternative was a gate whose evidence expires.

The log scrape stays, as the **fallback**, and is not vestigial: every `fleet-ops` run that existed
when the `run-name:` landed has `display_title` equal to the bare workflow name `fleet-ops` —
verified against twelve real runs rather than assumed — and the scrape is the only thing that
verifies one of those at all. The gate tries the title, falls through to the log, and refuses when
neither answers. Neither source is a GitHub contract; both are consequences of how `fleet-ops.yml`
is written. `the_apply_verification_prefers_the_run_name_fleet_ops_carries` renders that file's own
`run-name:` and runs the promotion's own parser over it, and
`the_apply_verification_reads_what_fleet_ops_actually_records` fails the build if the `env:` block
moves — both in `crates/connector-bin/tests/fleet_release_gate.rs`.

The title is not **stronger** evidence than the log. It is rendered from the same operator-supplied
inputs, so it proves exactly what the log proved; what changes is how long it lasts.

**What is still not proved, stated plainly rather than implied away:**

- **That the box's file is still that content now.** The gate proves a successful apply of the
  committed config happened after the config commit. A hand-edit on the box afterwards is invisible
  to it, and hand-edits are precisely what ADR 0041's Consequences section warns are the historical
  norm for these files.
- **Pre-`run-name:` runs whose logs have aged out.** A run cut since the `run-name:` landed states
  its box, operation and apply flag in its `display_title`, which does not expire. A run cut before
  it does not, and falls back to logs GitHub retains for 90 days; past that the gate **refuses**
  rather than assuming — an apply nobody can read is an apply nobody can check. That is the right
  direction to fail, and for those older runs it still means re-running the apply.
- **Forgery, in the narrow sense.** The evidence is log text, and a `fleet-ops` input is
  operator-supplied. This is not a privilege boundary and is not treated as one: anyone who can
  dispatch `fleet-ops` can dispatch a promotion. The gate defends against forgetfulness and against
  a plausible-looking wrong run, not against someone deliberately constructing a false one.
- **A wrong `no`.** See the Consequences below — the answer is now compulsory, but it is still a
  judgement, and a wrong one is only partly caught.

### Why promotion stays one workflow

`release-connector.yml` **calls** `promote-to-fleet.yml` rather than retagging. There is exactly one
thing in this repository that moves `:rust-release`, and it runs identically whether a human
dispatched it or a release did. A second copy of the five pre-move checks would be the copy that
does not run on an ordinary day, and that is the one that rots. The same reasoning makes the release
build through `publish-connector-rust-image.yml` rather than owning a second `docker build`: one
build definition, one Dockerfile contract, one amd64-only decision, one ADR 0009 refusal check.

## Decision

1. **A connector release is a `workflow_dispatch` and nothing else.**
   `.github/workflows/release-connector.yml` has no `push`, no `schedule` and no `workflow_run`
   trigger, and acquiring one would be a reversal of ADR 0041 Decision 3, not a convenience.
2. **Everything after the dispatch is automated, in one run**: build → handle → GitHub Release →
   the ADR 0041 config-boot gate → the tag move → `fleet-health.yml`.
3. **A release is named by a monotonic handle**, `YYYY.MM.DD.N` in UTC, where `N` is the 1-based
   ordinal of that day's releases. Not semver. The handle is also an immutable image alias
   (`rust-2026.08.21.1`) and the value of the image's `org.opencontainers.image.version` label.
4. **Deploy ordering rides as data**, not as an overloaded integer. Each release body carries
   `config-change-required: true|false` on a line of its own, and the question that produces it is
   **compulsory** — the dispatch input is a `choice` whose first and preselected option is a
   sentinel the workflow refuses by name, so an unanswered release is refused before it is built.
   There is no default, because there is no safe one.
5. **`promote-to-fleet.yml` refuses** when a release it crosses declares
   `config-change-required: true` and either the committed box configs did not change across that
   range, or the named `fleet-ops` `config-apply` run does not verify. Verification is five
   conditions — right workflow, `success`, `operation=config-apply`, `apply=true` (not a dry run),
   and started after the config's commit — checked per box, and failing closed when the evidence
   cannot be read. The check runs on a rollback too, over the range being undone.
6. **`:rust-release` is moved by `promote-to-fleet.yml` and by nothing else**, and a build is
   produced by `publish-connector-rust-image.yml` and by nothing else. The release workflow calls
   both; it reimplements neither.

## Consequences

**A release becomes a thing that exists.** There was no answer to "what is running on the fleet, and
what was it meant to be" beyond a seven-character hex prefix. There now is one, with a reason
attached, a digest, and a commit — and `docker inspect` on a box answers it without consulting GHCR.

**The handle is spent even when the promotion refuses.** If the ordering gate stops the run, the
build is published and the release exists while the boxes keep serving the previous build. That is
ADR 0041's "the fleet can be left behind deliberately" and it is the intended outcome, not a
half-failure: the recovery is to land and apply the config and then dispatch `promote-to-fleet.yml`
directly with the `rust-sha-` tag the release names, not to re-run the release and burn a second
handle on the same code. `promote: false` asks for the same state on purpose.

**The ordering question cannot be skipped, only answered.** An earlier draft of this record
accepted a `type: boolean` defaulting to `false`, and wrote the resulting gap down as a limitation.
That was the wrong trade and the passage is replaced rather than softened: defaulting to `false`
means a forgetful operator silently gets the old behaviour, and fail-open on the ordering question
is the exact shape of the 2026-08-16 outage — nobody decided the ordering did not matter, nobody was
even asked. A checkbox cannot be tri-state, so the input is a `choice` whose first option is a
sentinel (`-- select --`). GitHub always preselects the first option, so the form arrives
pre-filled with an answer the `version` job rejects by name, before a build is spent. An absent
answer is now indistinguishable from a wrong one, which is the point.

**A wrong answer is still possible, and is only partly caught.** `config_change_required` remains a
judgement: nothing can derive "this binary needs a new key" from the repository. A wrong `yes` costs
a refused promotion and is self-correcting. A wrong `no` is the dangerous one, and it is caught in
part by the gate beneath — a build that genuinely needs a key the committed files lack fails ADR
0041's boot gate with `missing field`. What a wrong `no` still gets past is the applied-to-the-box
half, because that half is only reached when the answer is `yes`. Compelling the answer removes the
silent case; it does not remove the mistaken one.

**The release handle is not a promotion input.** `promote-to-fleet.yml` accepts `rust-sha-<7 hex>`
and refuses `rust-2026.08.21.1`, even though the alias is immutable and would be safe. One accepted
shape means one thing for the ancestry check to parse a commit out of, and the handle carries no
commit. The refusal names the release and points at the `rust-sha-` tag in its body rather than
merely rejecting the input.

**Two workflows became reusable, and that has a concurrency consequence.**
`publish-connector-rust-image.yml`'s concurrency group is now selected by trigger: a push to `main`
keeps superseding in-flight builds (the 46-minute queue observed 2026-07-29 is the reason that
behaviour exists), while a release build gets a group of its own keyed by run id, so an unrelated
merge cannot cancel it. A cancelled release build would otherwise leave a handle and a GitHub
Release naming an image that was never pushed.

**This is a target record.** Written and asserted, but not exercised as a whole: no release has
been cut and `:rust-release` has not moved under it. It becomes true when a first release is
dispatched and both boxes come back green.

The refusal paths themselves are not merely reasoned about. The apply-run verification was run
against five real `fleet-ops` runs — a `config-read`, a failed `deploy`, a dry-run `deploy`, a
nonexistent id, and a malformed token, each correctly refused — and against ten synthetic cases
covering the true positive, both-boxes coverage, a dry-run apply, a wrong-workflow run, an apply
predating the config commit, and unreadable logs. The sentinel step was run over its own six cases.
When the evidence moved onto the run title, the same loop — sliced out of the committed workflow
rather than retyped — was run over eight more: a title-verified apply with the logs deliberately
returning `410 Gone` (proving the title path needs no log at all), a title-verified dry run and a
title-verified `box-status`, each refused; a bare `fleet-ops` title falling back to a log that
carries a real apply, and to one that carries a dry run; a bare title with the logs gone, refused
naming both dead ends; and a wrong-workflow and a failed run, refused before either source is
consulted. What remains unexercised is the whole path end to end, on a real release, against the
live fleet.
