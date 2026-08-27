//! Guards the fleet's release gate: the release dispatch, the promotion tag,
//! the config-compatibility rule, the deploy-ordering rule, and the health
//! probe's coverage. [ADR
//! 0041](../../../docs/adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md)
//! and [ADR
//! 0055](../../../docs/adr/0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md).
//!
//! Deliberately a SEPARATE harness from `devnet_configs_load.rs` rather than
//! more cases appended to it. That file asserts what the committed *overlays*
//! pin; this one asserts what the committed *pipeline* does with those pins,
//! and the two are edited by different work for different reasons (a pin bump
//! versus a workflow change). Keeping them apart is also why a live-drift
//! reconciliation of the overlays and this gate can land independently
//! without either one's assertions rewriting the other's.
//!
//! Most cases here are regression tests for something that actually happened
//! on 2026-08-16, and each one names it. The cases added with ADR 0055 are the
//! exception and are honest about it: they guard a shape that has not failed
//! yet, because the shape they guard — a workflow that builds, versions,
//! publishes and promotes in one run — is one trigger away from being the
//! auto-on-green connector#990 already caused once, and the trigger would look
//! like a convenience rather than a reversal.
//!
//! The CodeQL cases at the end are the same kind of thing for a different
//! pipeline: `.github/workflows/codeql.yml` filters one query out of the
//! scan (#1235), and a filter is a list that only ever grows.

use std::collections::BTreeSet;
use std::io::Write;
use std::process::{Command, Stdio};

const PUBLISH_CONNECTOR_WORKFLOW: &str =
    include_str!("../../../.github/workflows/publish-connector-rust-image.yml");
const PROMOTE_WORKFLOW: &str = include_str!("../../../.github/workflows/promote-to-fleet.yml");
const RELEASE_WORKFLOW: &str = include_str!("../../../.github/workflows/release-connector.yml");
const FLEET_OPS_WORKFLOW: &str = include_str!("../../../.github/workflows/fleet-ops.yml");
const FLEET_HEALTH_WORKFLOW: &str = include_str!("../../../.github/workflows/fleet-health.yml");
const CODEQL_WORKFLOW: &str = include_str!("../../../.github/workflows/codeql.yml");
const CODEQL_CONFIG: &str = include_str!("../../../.github/codeql/codeql-config.yml");
const RELAY_SWAP_CONFIG: &str = include_str!("../../../infra/linode-relay/swap.config.json");
const RELAY_SWAP_OVERLAY: &str =
    include_str!("../../../infra/linode-relay/docker-compose.relay.swap.yml");

/// A `docker/metadata-action` `type=raw,value=<tag>` line, ignoring `#`
/// comments -- both workflows above discuss `rust-release` at length in their
/// headers, and a test keyed on the word alone would be asserting prose.
fn raw_metadata_tags(raw: &str) -> BTreeSet<String> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.strip_prefix("type=raw,value="))
        .map(|rest| {
            rest.split(',')
                .next()
                .unwrap_or(rest)
                .trim()
                .trim_end_matches("}}")
                .to_string()
        })
        .collect()
}

/// THE regression test for the contradiction this gate exists to resolve.
///
/// connector#990 shipped `type=raw,value=rust-release,enable={{is_default_branch}}`
/// here, which made `:rust-release` move on every green merge to `main`. Both
/// devnet boxes were then repointed to follow that tag under a label-scoped
/// Watchtower, so every green merge reached the live client edge on two
/// machines inside a minute, unvalidated -- while toon-meta#403 and
/// connector#989's own closing comments (both owner-approved) recorded
/// `:rust-release` as "a deliberate PROMOTION tag ... NOT auto-on-green", and
/// connector#972's then-open pin PR still described a supervised regime.
/// (#972 has since been closed as superseded: this gate, not a `rust-sha-*`
/// literal in the overlays, is what supervises the tag now.)
///
/// The build workflow publishes CANDIDATES. Only `promote-to-fleet.yml` moves
/// the tag the fleet follows. Re-adding it here would silently restore
/// auto-on-green on the one image that fronts every paid write on the devnet.
#[test]
fn the_build_workflow_publishes_candidates_and_never_moves_the_promotion_tag() {
    let tags = raw_metadata_tags(PUBLISH_CONNECTOR_WORKFLOW);

    assert!(
        !tags.contains("rust-release"),
        "publish-connector-rust-image.yml pushes `rust-release` again. That tag \
         is what both devnet boxes' Watchtower follows, so this makes every \
         green merge to main an unvalidated deploy to the live client edge on \
         BOTH boxes -- the exact regression connector#990 caused and ADR 0041 \
         resolved. `:rust-release` is moved by promote-to-fleet.yml only. \
         Tags found: {tags:?}"
    );

    // The candidate tags must still be published, or promotion has nothing to
    // promote: `rust-sha-` is the immutable handle promote-to-fleet.yml
    // requires, and every rollback target is one.
    assert!(
        tags.iter().any(|t| t.starts_with("rust-sha-")),
        "publish-connector-rust-image.yml no longer publishes an immutable \
         `rust-sha-` tag. promote-to-fleet.yml can only promote one of those, \
         and it is also the only thing a rollback can name. Tags found: {tags:?}"
    );
}

/// The top-level `on:` keys of a workflow, by indentation, ignoring comments.
/// The workflows here discuss their triggers at length in prose, so a test
/// keyed on the word `push` alone would be asserting a paragraph.
fn workflow_triggers(raw: &str) -> BTreeSet<String> {
    let mut triggers = BTreeSet::new();
    let mut inside = false;
    for line in raw.lines() {
        if line.trim_start().starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if !inside {
            inside = line == "on:";
            continue;
        }
        // Any further line at column 0 ends the block.
        if !line.starts_with(' ') {
            break;
        }
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if indent == 2 {
            if let Some(key) = trimmed.split(':').next() {
                triggers.insert(key.to_string());
            }
        }
    }
    triggers
}

/// THE regression test for ADR 0055's one hard constraint, which is the
/// second half of one ADR 0041 Decision 3 already states: a release is a
/// human act, and everything after it is automated. Not the act itself.
///
/// `release-connector.yml` builds, versions, publishes a GitHub Release and
/// then promotes — which is to say it is one `workflow_run:` away from being
/// auto-on-green with four extra steps in the middle. connector#990 was the
/// one-line version of that mistake and it reached both live devnet boxes
/// within ~60s of every merge. The reasoning has not changed since:
/// `connector-rust` is the client edge on BOTH boxes, so one bad digest takes
/// the whole devnet's paid-write path dark on two machines at once.
///
/// A `pull_request` trigger would be no better than a `push` one here — this
/// workflow ends in a move of the tag the fleet follows.
#[test]
fn the_release_workflow_is_dispatch_only() {
    let triggers = workflow_triggers(RELEASE_WORKFLOW);
    let expected: BTreeSet<String> = ["workflow_dispatch".to_string()].into_iter().collect();

    assert_eq!(
        triggers, expected,
        "release-connector.yml is triggered by something other than a human \
         dispatch. It ends in a promotion of `:rust-release`, which both \
         devnet boxes' Watchtower follows, so ANY automatic trigger here is \
         auto-on-green for the one image ADR 0041 Decision 3 holds back — the \
         connector is not auto-deployed at all. That shipped once \
         (connector#990) and was reverted."
    );
}

/// The release workflow must not grow its own copy of the promotion.
///
/// Every check standing between a build and the live fleet lives in
/// promote-to-fleet.yml: the immutable-tag shape, on-main provenance, the
/// no-silent-rollback ancestry, the boot against both boxes' committed
/// configs, and the deploy-ordering gate. A retag issued from
/// release-connector.yml would route around all five, and a second copy of
/// them would be the copy that is not exercised on the ordinary path — which
/// is the one that rots. So there is exactly one mover and the release
/// delegates to it.
#[test]
fn the_release_workflow_never_moves_the_fleet_tag_itself() {
    assert!(
        !RELEASE_WORKFLOW.contains("MOVING_TAG"),
        "release-connector.yml knows the name of the moving tag. It has no \
         business with it: it hands a `rust-sha-` tag to promote-to-fleet.yml, \
         which owns `:rust-release` and every check in front of moving it."
    );

    // The workflow DOES retag — it aliases the built manifest under its
    // release handle (`rust-2026.08.21.1`), which is immutable and follows
    // nothing. What it must never do is point a retag at the tag the fleet
    // follows. Prose is not the subject here: the header and the `promote`
    // input's own description both say `:rust-release` out loud, deliberately,
    // and a test that banned the string would be asserting a paragraph.
    for (i, line) in RELEASE_WORKFLOW.lines().enumerate() {
        let retag_shaped =
            line.contains("imagetools") || line.contains("-t ") || line.contains("docker push");
        assert!(
            !(line.contains("rust-release") && retag_shaped),
            "release-connector.yml line {} retags `rust-release`:\n  {}\n\
             `:rust-release` is moved by promote-to-fleet.yml and by nothing \
             else — that is where the immutable-tag shape, the on-main \
             provenance, the no-silent-rollback ancestry, the boot against \
             both boxes' committed configs and the deploy-ordering gate all \
             live. A retag here routes around all five.",
            i + 1,
            line.trim()
        );
    }
    assert!(
        RELEASE_WORKFLOW.contains("uses: ./.github/workflows/promote-to-fleet.yml"),
        "release-connector.yml no longer calls promote-to-fleet.yml. A release \
         that does not end in the gated promotion either does not deploy, or \
         deploys past the gate. If holding the fleet back was the intent, that \
         is the `promote: false` input, not a deleted job."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("workflow_call:"),
        "promote-to-fleet.yml is no longer callable, so release-connector.yml \
         cannot delegate to it. Being callable is what keeps ONE thing moving \
         `:rust-release` across both the direct-dispatch and the release path."
    );
}

/// One build definition, shared with green main.
///
/// A release that ran its own `docker build` would be a second place to keep
/// in step with the Dockerfile, the amd64-only decision (#487's recorded
/// reversal) and the ADR 0009 refuses-without-a-config assertion — and it
/// would be the copy that runs rarely, so its drift would surface on a
/// release day, which is the worst available day for it.
#[test]
fn a_release_builds_through_the_same_workflow_a_green_main_does() {
    assert!(
        PUBLISH_CONNECTOR_WORKFLOW.contains("workflow_call:"),
        "publish-connector-rust-image.yml is no longer callable. \
         release-connector.yml calls it so a release and a green merge produce \
         a build from one definition."
    );
    assert!(
        RELEASE_WORKFLOW.contains("uses: ./.github/workflows/publish-connector-rust-image.yml"),
        "release-connector.yml no longer builds through \
         publish-connector-rust-image.yml. If it grew its own build step there \
         are now two build definitions, and only one of them runs on an \
         ordinary day."
    );
    assert!(
        !RELEASE_WORKFLOW.contains("docker/build-push-action"),
        "release-connector.yml builds an image itself. It must call \
         publish-connector-rust-image.yml instead — see both files' headers \
         and ADR 0055."
    );
}

/// The machine-readable field the release writes and the promotion reads.
///
/// Same class of assertion as
/// [`the_config_compat_gate_reproduces_the_makers_committed_service_environment`]
/// below, and it exists for the same reason: two files describing one fact in
/// two places drift, and this drift reads as a PASS. Rename or reformat the
/// line in release-connector.yml and promote-to-fleet.yml greps for something
/// no release carries, finds nothing, and waves every promotion through while
/// reporting that it checked.
const CONFIG_CHANGE_FIELD: &str = "config-change-required";

#[test]
fn the_release_body_and_the_promotion_gate_agree_on_the_ordering_field() {
    assert!(
        RELEASE_WORKFLOW.contains(&format!("{CONFIG_CHANGE_FIELD}: ${{CONFIG_CHANGE}}")),
        "release-connector.yml no longer writes a `{CONFIG_CHANGE_FIELD}:` \
         line into the release body. That line is ADR 0041 rule 2 in \
         machine-readable form — the ordering swap#134 recorded only in a PR \
         body, where nothing read it — and promote-to-fleet.yml greps for it."
    );
    assert!(
        PROMOTE_WORKFLOW.contains(&format!("any(. == \"{CONFIG_CHANGE_FIELD}: true\")")),
        "promote-to-fleet.yml no longer tests release bodies for a \
         `{CONFIG_CHANGE_FIELD}: true` line. A gate that reads nothing passes \
         everything, and it does so while reporting green — worse than no \
         gate, because somebody is relying on it. Note the shape it looks for \
         is an EXACT line after trimming CR and trailing blanks, which is what \
         release-connector.yml writes; if you loosen one side, loosen both."
    );
}

/// The refusal itself, both halves.
///
/// Declaring `config-change-required: true` obliges two things and neither is
/// optional:
///
/// * the committed box configs actually changed across the range being
///   crossed — otherwise the release claims a config change that exists only
///   on a box, or nowhere. That is the 2026-08-16 shape exactly: swap#134's
///   `tokenNetworkAddress` fix was hand-applied to the relay and never
///   committed, so a redeploy from the tree would have reproduced the outage.
/// * a `fleet-ops.yml config-apply` run is named. Nothing in CI can see the
///   bytes on the box, and the bytes on the box are what Watchtower recreates
///   against. The boot gate proves image-fits-COMMITTED-config and stops
///   there; this is the only thing covering the rest of the distance.
#[test]
fn promotion_refuses_a_declared_config_change_that_was_not_landed_and_applied() {
    assert!(
        PROMOTE_WORKFLOW.contains("git diff --name-only"),
        "promote-to-fleet.yml no longer checks that the committed box configs \
         changed across the range a config-requiring release covers. Without \
         it a release can declare the fleet needs a config change while \
         infra/linode-*/connector-rust.toml sits untouched — the 2026-08-16 \
         outage, where the fix lived only on the box."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("config_applied_run"),
        "promote-to-fleet.yml no longer takes or checks `config_applied_run`. \
         The boot gate proves the image fits the config COMMITTED HERE; it \
         cannot see the box, and Watchtower recreates against the box. Naming \
         the fleet-ops run that applied it is the only evidence available for \
         that gap."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("operation=config-apply"),
        "promote-to-fleet.yml's config-ordering refusal no longer prints the \
         fleet-ops.yml command that resolves it. An error naming the rule but \
         not the remedy is how a gate gets routed around."
    );
}

/// The lines of a `workflow_dispatch` input's own block, by indentation.
fn input_block(raw: &str, name: &str) -> String {
    let needle = format!("      {name}:");
    let Some(start) = raw.find(&needle) else {
        panic!("no `{name}` input found — this test is asserting over a shape that moved");
    };
    let mut out = String::new();
    for (i, line) in raw[start..].lines().enumerate() {
        if i > 0 && !line.trim().is_empty() {
            let indent = line.len() - line.trim_start().len();
            if indent <= 6 {
                break;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Fail-open on the ordering question is the exact shape of the 2026-08-16
/// outage: nobody decided the ordering did not matter, nobody was even asked.
///
/// `config_change_required` was a `type: boolean` defaulting to `false`, so a
/// forgetful operator silently got the old behaviour. A checkbox cannot be
/// tri-state; a `choice` can, because GitHub always preselects the FIRST
/// option — so the first option is a sentinel the workflow refuses by name,
/// and an absent answer becomes indistinguishable from a wrong one.
///
/// The refusal has to be in `version`, before `build`, or a release that will
/// be refused still burns ten minutes of runner first.
#[test]
fn the_release_workflow_refuses_an_unanswered_ordering_question() {
    let block = input_block(RELEASE_WORKFLOW, "config_change_required");

    assert!(
        block.contains("type: choice"),
        "config_change_required is not a `choice`. A `boolean` cannot express \
         \"not answered\" — it arrives as `false`, which is the fail-open the \
         sentinel exists to remove. Block:\n{block}"
    );
    assert!(
        !block.contains("type: boolean"),
        "config_change_required is a boolean again. GitHub renders it as a \
         pre-ticked-or-unticked box, so an operator who reads nothing dispatches \
         `false` — silently claiming this build needs no config change. Block:\n{block}"
    );

    // The sentinel must be the FIRST option, because that is the one GitHub
    // preselects. Any other position and the form still arrives pre-answered.
    let options = block
        .split_once("options:")
        .map(|(_, rest)| rest.to_string())
        .expect("config_change_required has no `options:` list");
    let first = options
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("- "))
        .expect("config_change_required's `options:` list is empty");
    assert!(
        first.contains("-- select --"),
        "config_change_required's first option is `{first}`, not the `-- select --` \
         sentinel. GitHub preselects the first option, so whatever sits there is \
         what an operator who reads nothing submits. Putting a real answer first \
         restores the fail-open."
    );

    assert!(
        RELEASE_WORKFLOW.contains("the ordering question was not answered"),
        "release-connector.yml no longer refuses the sentinel. The choice list \
         alone changes nothing — something has to reject the preselected value."
    );
}

/// The apply evidence's FALLBACK source, and the drift that would silently
/// destroy it.
///
/// A `workflow_dispatch` run's inputs are NOT on the run object: it has no
/// `inputs` key. `fleet-ops.yml` now renders the three the gate cares about
/// into its `run-name:`, which is the durable source and is guarded by
/// [`the_apply_verification_prefers_the_run_name_fleet_ops_carries`] — but
/// every fleet-ops run cut before that landed has `display_title` == the bare
/// workflow name "fleet-ops" (checked against 12 real runs), and for those the
/// only place `box`, `operation` and `apply` survive is the runner's echo of
/// `fleet-ops.yml`'s **job-level `env:` block** into the log.
///
/// So this case does not retire with the `run-name:`; it retires when the last
/// pre-`run-name:` run stops being nameable, which is not a date this file can
/// know. Until then the fallback is the only way an apply from before the
/// change verifies at all, and it is a consequence of how fleet-ops.yml
/// happens to be written rather than a GitHub contract. If those move out of
/// job `env` — inlined per step, renamed, read straight from `inputs` — the
/// log stops carrying them and the fallback stops being able to check
/// anything. It fails closed when it cannot read them, so the live consequence
/// is refused promotions rather than waved-through ones; this case is here so
/// the cause is named at build time instead of at 2am.
///
/// Same class as
/// [`the_config_compat_gate_reproduces_the_makers_committed_service_environment`]:
/// two files depending on one fact, and only one of them knows it.
const FLEET_OPS_LOGGED_INPUTS: &[&str] = &["BOX", "OPERATION", "APPLY"];

#[test]
fn the_apply_verification_reads_what_fleet_ops_actually_records() {
    for key in FLEET_OPS_LOGGED_INPUTS {
        let declared = format!("{key}: ${{{{ inputs.");
        assert!(
            FLEET_OPS_WORKFLOW.contains(&declared),
            "fleet-ops.yml no longer declares `{key}` as job-level `env:` from an \
             input. That echo is the only record of a config-apply run's \
             parameters for every run cut BEFORE this file carried a \
             `run-name:` — the run object has no `inputs` key and those runs' \
             `display_title` is the bare workflow name — so removing it makes \
             an apply from before the change permanently unverifiable, and \
             promote-to-fleet.yml fails closed on exactly that. The `run-name:` \
             covers new runs and does not cover old ones. Restore it; do not \
             delete the check on the strength of the title being there now."
        );
        assert!(
            PROMOTE_WORKFLOW.contains(&format!("field {key}")),
            "promote-to-fleet.yml no longer extracts `{key}` from the fleet-ops \
             run's log. The log is the fallback for runs whose title predates \
             fleet-ops.yml's `run-name:`, so dropping it does not simplify the \
             gate — it makes those runs unverifiable, and the gate refuses what \
             it cannot verify."
        );
    }

    // The extraction has to match the runner's actual line shape: two spaces,
    // the key, a colon, a space. Verified against 12 real fleet-ops runs.
    assert!(
        PROMOTE_WORKFLOW.contains("grep -E \"^  $1: \""),
        "promote-to-fleet.yml's log extraction no longer matches the runner's \
         env-echo line shape (two spaces, KEY, ': '). If the shape it looks for \
         is wrong the gate finds nothing — and because it fails closed, that \
         reads as every promotion being refused rather than as a bug here."
    );
}

/// The durable half of the apply evidence: the run's own title.
///
/// The gate's job is to establish, about a named `fleet-ops` run, which box it
/// touched, which operation it ran, and whether `apply` was really true. A
/// `workflow_dispatch` run object carries none of that — it has no `inputs`
/// key — so the first version of this gate read the runner's echo of
/// fleet-ops.yml's job-level `env:` block out of the run's LOGS. Logs age out
/// (90 days by default) and the gate refuses what it cannot read, so a
/// perfectly good apply became unverifiable simply by getting old, and the
/// only remedy was to re-run an apply against a live box to produce fresher
/// evidence of a thing that had already happened.
///
/// `run-name:` moves the same three facts onto the run object, where they live
/// as `display_title` for as long as the run does. It is not stronger
/// evidence — it is rendered from the same operator-supplied inputs the log
/// echoes, and ADR 0055 is explicit that forgery is not the threat model — it
/// is evidence that does not expire.
///
/// This case exists because the format is now a CONTRACT between two files
/// that do not import each other, which is the same drift
/// [`the_release_body_and_the_promotion_gate_agree_on_the_ordering_field`]
/// guards and it fails the same way: reword the title and the parser matches
/// nothing. That direction is at least fail-closed (the gate falls through to
/// the log and then refuses when it has aged out), but a promotion refused for
/// a reason nobody can see is still a 2am problem, so it is caught here.
///
/// Rather than restating the shape in prose, the case RENDERS fleet-ops.yml's
/// own `run-name:` and runs promote-to-fleet.yml's own parser over it.
const FLEET_OPS_RUN_NAME_PARSE: &str =
    r"s/^fleet-ops ([a-z-]+) on ([a-z]+) \(apply=(true|false)\)$/\1 \2 \3/p";

/// The `run-name:` value fleet-ops.yml commits, quotes stripped.
fn fleet_ops_run_name() -> String {
    let line = FLEET_OPS_WORKFLOW
        .lines()
        .find(|l| l.starts_with("run-name:"))
        .expect(
            "fleet-ops.yml has no top-level `run-name:`. The deploy-ordering gate reads \
             a config-apply run's box/operation/apply off `display_title`, and without \
             this line every run's title is the bare workflow name — which throws the \
             gate back onto logs that expire at 90 days. See ADR 0055.",
        );
    line["run-name:".len()..]
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

/// Run promote-to-fleet.yml's own sed script over a title, exactly as the
/// workflow does. Shelling out rather than reimplementing the regex is the
/// point: a Rust-side copy of the pattern would be a third place for it to
/// drift, and this way the thing under test is the string the gate ships.
fn parse_title_the_way_the_gate_does(title: &str) -> String {
    let mut child = Command::new("sed")
        .arg("-nE")
        .arg(FLEET_OPS_RUN_NAME_PARSE)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("could not run `sed` — it is what promote-to-fleet.yml parses the title with");
    child
        .stdin
        .take()
        .expect("sed stdin")
        .write_all(format!("{title}\n").as_bytes())
        .expect("write title to sed");
    let out = child.wait_with_output().expect("sed exited");
    String::from_utf8(out.stdout)
        .expect("sed output is utf-8")
        .trim()
        .to_string()
}

#[test]
fn the_apply_verification_prefers_the_run_name_fleet_ops_carries() {
    let run_name = fleet_ops_run_name();

    for input in ["inputs.box", "inputs.operation", "inputs.apply"] {
        assert!(
            run_name.contains(input),
            "fleet-ops.yml's `run-name:` does not carry `{input}`: `{run_name}`. All three \
             are what promote-to-fleet.yml has to establish about a named config-apply \
             run, and a title missing one is a title the gate cannot use."
        );
    }

    // `service` is a free-form string input; the other three are `choice` and
    // `boolean`, so their values come from a fixed set. Free text inside a
    // title something else PARSES is how one run is made to read as another,
    // and `service` answers nothing the gate asks.
    assert!(
        !run_name.contains("inputs.service"),
        "fleet-ops.yml's `run-name:` interpolates the free-form `service` input: \
         `{run_name}`. Only the fixed-set inputs belong in a title the ordering gate \
         parses — an operator-typed service name can be made to read as another box."
    );
    assert!(
        !run_name.contains("secrets."),
        "fleet-ops.yml's `run-name:` interpolates a secret: `{run_name}`. A run title is \
         as visible as the run itself, and this workflow holds an SSH key with root on \
         the devnet boxes."
    );

    // Render the committed template the way a real dispatch would, then run
    // the gate's own parser over it. This is the assertion that actually binds
    // the two files: a reworded title fails HERE rather than silently at 2am.
    let rendered = run_name
        .replace("${{ inputs.operation }}", "config-apply")
        .replace("${{ inputs.box }}", "relay")
        .replace("${{ inputs.apply }}", "true");
    assert!(
        !rendered.contains("${{"),
        "rendering fleet-ops.yml's `run-name:` left an unsubstituted expression: \
         `{rendered}`. The template grew an interpolation this test does not know how \
         to fill in, so it is no longer checking what a real run's title looks like."
    );
    assert_eq!(
        parse_title_the_way_the_gate_does(&rendered),
        "config-apply relay true",
        "promote-to-fleet.yml's parser does not read the title fleet-ops.yml renders \
         (`{rendered}`). The two files agree on this format and nothing else connects \
         them; when they disagree the gate falls through to the log scrape and then \
         refuses once those logs have aged out, so the failure surfaces as a promotion \
         that cannot be made rather than as this mismatch."
    );

    // …and the gate has to actually contain that parser, not merely be
    // parseable by one this test made up.
    assert!(
        PROMOTE_WORKFLOW.contains(FLEET_OPS_RUN_NAME_PARSE),
        "promote-to-fleet.yml no longer parses the fleet-ops run title with \
         `{FLEET_OPS_RUN_NAME_PARSE}`. Either it stopped reading `display_title` — \
         which puts every config-requiring promotion back on logs that expire — or the \
         pattern moved and this test is asserting over a shape that no longer exists."
    );
    assert!(
        PROMOTE_WORKFLOW.contains(".display_title"),
        "promote-to-fleet.yml no longer fetches `.display_title` with the run's \
         metadata, so the title it parses is never read."
    );

    // The historical case, which is every fleet-ops run that exists today: a
    // bare workflow name must NOT parse, so the gate falls through to the log
    // rather than inventing a box from a title that says nothing.
    assert_eq!(
        parse_title_the_way_the_gate_does("fleet-ops"),
        "",
        "the gate's title parser matches the bare workflow name `fleet-ops`, which is \
         the `display_title` of every run cut before the `run-name:` landed. Matching \
         it would mean reading a box and an apply flag out of a title that carries \
         neither."
    );

    // …and the fallback those runs depend on is still wired up, with the
    // refusal that fires when neither source can answer.
    assert!(
        PROMOTE_WORKFLOW.contains("actions/runs/$RID/logs"),
        "promote-to-fleet.yml no longer falls back to the fleet-ops run's logs. Every \
         apply that happened before the `run-name:` landed has a bare title, so the \
         scrape is the only thing that verifies one — removing it does not simplify \
         the gate, it refuses yesterday's apply."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("does not carry the box/operation/apply either"),
        "promote-to-fleet.yml no longer refuses when NEITHER the title nor the logs \
         answer. That branch is the whole fail-closed property: two sources that can \
         each come up empty must end in a refusal, never in a default."
    );
}

/// The apply run is VERIFIED, not believed.
///
/// This began as an attestation: a non-empty string, recorded in the summary
/// and trusted. ADR 0041's own thesis refuses that — "the enforceable half has
/// to be a check on the config the fleet actually has" — so an unverifiable
/// string was precisely the unenforceable half that record says is not
/// sufficient. It cost every release some friction and bought an audit line
/// nobody could rely on.
///
/// Five conditions, each its own refusal. Every one of them is a way a named
/// run can be real, green, and still not evidence that the boxes have the
/// config:
///
/// * a run of some other workflow entirely;
/// * a fleet-ops run that failed;
/// * a fleet-ops run that was `box-status`, `config-read`, `deploy` — anything
///   that never writes a config file;
/// * `apply=false`, which is a DRY RUN: it reads the box, prints the diff, and
///   writes nothing. This is the most dangerous of the five, because the run is
///   a genuine `config-apply` and concludes green;
/// * an apply that ran BEFORE the config commit, which applied the previous
///   file — the same outage with a receipt attached.
#[test]
fn promotion_verifies_the_named_apply_run_rather_than_believing_it() {
    let required: &[(&str, &str)] = &[
        (
            "actions/runs/$RID",
            "fetch the named run's metadata at all",
        ),
        (
            "!= '.github/workflows/fleet-ops.yml'",
            "check the run is a run of fleet-ops.yml (not merely that a run id exists)",
        ),
        (
            "!= 'success'",
            "check the run concluded successfully",
        ),
        (
            "!= 'config-apply'",
            "check the run's operation was config-apply and not box-status/config-read/deploy",
        ),
        (
            "ran with apply=false",
            "reject a DRY RUN — a genuine config-apply with apply=false reads the box, prints a diff and writes nothing, and still concludes green",
        ),
        (
            "-gt \"$RWHEN\"",
            "check the apply STARTED AFTER the config commit — an earlier apply applied the previous file",
        ),
    ];

    for (needle, what) in required {
        assert!(
            PROMOTE_WORKFLOW.contains(needle),
            "promote-to-fleet.yml no longer appears to {what} (looked for \
             `{needle}`). Dropping one of these turns the ordering gate back \
             into an attestation — a string that costs a release friction and \
             proves nothing, which is exactly what ADR 0041 says is not \
             sufficient. If the check genuinely cannot be made, say so in ADR \
             0055 rather than leaving the workflow implying it happens."
        );
    }

    // Coverage is per-box: `ario` is the store box's Linode label, which is
    // what fleet-ops.yml's `box` input takes. One run naming one box does not
    // cover a range in which both boxes' configs moved.
    assert!(
        PROMOTE_WORKFLOW.contains("infra/linode-store/connector-rust.toml) B=ario"),
        "promote-to-fleet.yml no longer maps the store box's committed config \
         to the `ario` box label. fleet-ops.yml takes `ario`, not `store`, so a \
         wrong mapping here either refuses a valid apply forever or accepts a \
         relay apply as cover for a store config change."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("\n  actions: read"),
        "promote-to-fleet.yml no longer GRANTS `actions: read` at workflow scope \
         (a commented-out line does not count, which is how this assertion was \
         first written and how mutation testing caught it). Without the scope \
         the ordering gate cannot read the fleet-ops run's logs, and since it \
         fails closed, every config-requiring promotion is refused."
    );
}

/// The handle is a date and an ordinal, and it is not semver.
///
/// deploy/connector-rust/README.md's reasoning about the image tags binds
/// here too: no crate under `crates/` has a release process, every one is
/// `0.1.0`, and a semver series "would claim a stability contract the binary
/// hasn't earned". Someone eventually pins against a version number, and a
/// MAJOR that means nothing is worse than no number at all — so the deploy
/// ordering a MAJOR usually smuggles rides as data instead.
///
/// The other half of the same decision: `:rust-release` still moves only from
/// a `rust-sha-` tag. The handle alias is immutable and would be safe to
/// promote, but one accepted shape means one thing for the ancestry check to
/// parse a commit out of, and the handle carries no commit.
#[test]
fn the_release_handle_is_a_dated_ordinal_and_never_a_semver_series() {
    assert!(
        RELEASE_WORKFLOW.contains("date -u +%Y.%m.%d"),
        "release-connector.yml no longer cuts its handle from a UTC date. A \
         local date makes the series non-monotonic for anyone west of \
         Greenwich, and a handle that is not a date is a version number \
         wearing a disguise. See ADR 0055."
    );
    assert!(
        !RELEASE_WORKFLOW.contains("semantic-release"),
        "release-connector.yml reaches for a semver series. Every crate under \
         `crates/` is 0.1.0 with no release process; a version here would \
         claim a stability contract the binary has not earned. See ADR 0055 \
         and deploy/connector-rust/README.md."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("^rust-[0-9]{4}"),
        "promote-to-fleet.yml no longer recognises a release-handle alias in \
         order to refuse it BY NAME. It is refused because the handle carries \
         no commit for the ancestry check, and an operator who reaches for it \
         should be told where the `rust-sha-` tag is rather than only that the \
         input was wrong."
    );
}

/// The other half: the promotion workflow has to exist and has to refuse a
/// floating tag. connector#989's design was recorded and then never built --
/// the ticket was closed with no `promote-to-fleet` workflow in any repo --
/// which is how the record and the pipeline came apart in the first place.
///
/// Promoting `rust-main` would be auto-on-green with one more indirection, so
/// the shape check is load-bearing, not decoration.
#[test]
fn promotion_moves_the_fleet_tag_and_only_from_an_immutable_build() {
    assert!(
        PROMOTE_WORKFLOW.contains("docker buildx imagetools create -t \"$IMAGE:$MOVING_TAG\""),
        "promote-to-fleet.yml no longer retags the moving tag with \
         `imagetools create`. A retag re-points at the EXACT manifest the \
         config-compatibility gate above it validated; a rebuild from the same \
         commit could produce a different image and would make those checks \
         vouch for something else."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("MOVING_TAG: rust-release"),
        "promote-to-fleet.yml no longer names `rust-release` as the tag it \
         moves. That is the tag both boxes' Watchtower follows."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("^rust-sha-[0-9a-f]{7}$"),
        "promote-to-fleet.yml no longer constrains its input to an immutable \
         `rust-sha-` tag. Promoting a floating tag (`rust-main`) reintroduces \
         auto-on-green one indirection further away, which is exactly what \
         ADR 0041 refuses."
    );
    assert!(
        PROMOTE_WORKFLOW.contains("merge-base --is-ancestor"),
        "promote-to-fleet.yml no longer checks ancestry. Without it a \
         promotion can front the live fleet with a build that is not on main, \
         or silently roll both boxes backwards."
    );
}

/// The chain-provider fields the maker refuses to boot without, mirrored from
/// `SWAP_REQUIRED_PROVIDER_FIELDS.evm` in toon-protocol/swap
/// `packages/swap/src/swap-node.ts`. Enforced by `validateChainProviderEntry`,
/// which throws `SwapNodeStartError('INVALID_CONFIG', ...)` naming the missing
/// setting.
///
/// A mirror, not a derivation -- this repo cannot import the maker's schema.
/// That is precisely why the pre-deploy gates in ADR 0041 boot the real image
/// against this real file rather than trusting a list like this one: a key
/// added in `swap` will not appear here on its own. This case catches the
/// cheaper failure, an edit to the config in THIS repo that drops a field the
/// maker needs, and it catches it in CI instead of on the box.
const SWAP_REQUIRED_EVM_PROVIDER_FIELDS: &[&str] = &[
    "chainId",
    "rpcUrl",
    "registryAddress",
    "tokenAddress",
    // Leg A. The one swap#134 added and the box did not have.
    "tokenNetworkAddress",
    // Leg B, the EIP-712 `verifyingContract`. A DIFFERENT contract from
    // `tokenNetworkAddress`; neither defaults to the other (swap#133).
    "channelAddress",
];

/// The outage of 2026-08-16, as a test.
///
/// swap#134 made `chainProviders[].tokenNetworkAddress` required with no
/// default. It merged green, `swap:release` moved, the relay box's Watchtower
/// recreated `swap-node` within ~60s, and the maker crash-looped on
/// `[INVALID_CONFIG] chainProviders[0].tokenNetworkAddress MUST be a non-empty
/// string` -- because this file is BIND-MOUNTED at
/// `/app/config/swap.config.json` and is not part of the image, so no image
/// build ever saw it. A human added the key to the live copy to stop the loop.
///
/// Until that value was brought back here, a redeploy from the committed tree
/// would have reproduced the outage exactly. This asserts it stays.
#[test]
fn the_committed_maker_config_satisfies_every_field_the_maker_requires() {
    let config: serde_json::Value = serde_json::from_str(RELAY_SWAP_CONFIG).expect(
        "infra/linode-relay/swap.config.json is not valid JSON -- the maker reads it verbatim",
    );

    let providers = config
        .get("chainProviders")
        .and_then(|p| p.as_array())
        .expect("swap.config.json has no `chainProviders` array");
    assert!(
        !providers.is_empty(),
        "swap.config.json's `chainProviders` is empty -- the maker refuses to \
         boot without an entry for every chain a `swapPair` targets."
    );

    for (i, provider) in providers.iter().enumerate() {
        let chain_type = provider
            .get("chainType")
            .and_then(|c| c.as_str())
            .unwrap_or_else(|| panic!("chainProviders[{i}] has no `chainType`"));
        // Only the EVM required-field set is mirrored here; the fleet has run
        // nothing else in this file. A solana/mina provider appearing without
        // its own mirrored list would pass vacuously, so say so rather than
        // let it.
        assert_eq!(
            chain_type, "evm",
            "chainProviders[{i}] is `{chain_type}`, and this test only mirrors \
             the maker's EVM required-field set. Add the matching list from \
             swap's SWAP_REQUIRED_PROVIDER_FIELDS before committing a \
             non-EVM provider, or this case passes it without checking anything."
        );

        for field in SWAP_REQUIRED_EVM_PROVIDER_FIELDS {
            let value = provider.get(*field).and_then(|v| v.as_str());
            assert!(
                value.is_some_and(|v| !v.is_empty()),
                "infra/linode-relay/swap.config.json `chainProviders[{i}]` is \
                 missing a non-empty `{field}`. The maker validates this before \
                 allocating any resource and exits INVALID_CONFIG naming the \
                 setting -- and because this file is bind-mounted rather than \
                 baked into the image, that lands as a crash-loop on the relay \
                 box roughly 60 seconds after `swap:release` next moves. This \
                 is the 2026-08-16 outage; see ADR 0041."
            );
        }
    }
}

/// Environment variables `docker-compose.relay.swap.yml` supplies to the
/// maker. The config FILE is only half the box's configuration: without
/// `SWAP_AUTOGEN_IDENTITY`, `swap.config.json` alone fails
/// `[INVALID_CONFIG] SwapNodeConfig: one of mnemonic or secretKey is required`,
/// because swap#127 made the maker self-generate and persist its own BIP-39
/// mnemonic to `statePath` on first boot rather than read a committed one.
const RELAY_SWAP_SERVICE_ENV: &[&str] = &["SWAP_AUTOGEN_IDENTITY"];

/// The config-compatibility gates boot the `:release` image against the
/// committed `swap.config.json`, and they can only be trusted if what they
/// boot is what the BOX boots. The first run of this gate proved that is not
/// automatic: booting the file by itself failed on a missing identity that
/// the box never misses, because the overlay supplies it as an environment
/// variable rather than a config key.
///
/// So both gates -- `fleet-health.yml`'s `config-compat` job here, and
/// `publish-swap-image.yml`'s in the swap repo -- reproduce the SERVICE:
/// the file, plus this environment, plus a writable state mount. This case is
/// what stops the two descriptions drifting: a variable added to the overlay
/// and not to the gate would leave the gate quietly validating a
/// configuration the box does not run, which is a worse failure than having
/// no gate, because it reads as a pass.
#[test]
fn the_config_compat_gate_reproduces_the_makers_committed_service_environment() {
    for var in RELAY_SWAP_SERVICE_ENV {
        assert!(
            RELAY_SWAP_OVERLAY.contains(var),
            "docker-compose.relay.swap.yml no longer sets `{var}`. If the \
             maker genuinely no longer needs it, drop it from \
             RELAY_SWAP_SERVICE_ENV and from both config-compat gates -- do \
             not leave the gates passing a variable the service does not have."
        );
        assert!(
            FLEET_HEALTH_WORKFLOW.contains(&format!("-e {var}=")),
            "fleet-health.yml's config-compat job does not pass `{var}` to the \
             image, but docker-compose.relay.swap.yml supplies it to the live \
             service. The gate would be booting a configuration the box never \
             runs -- and it would FAIL on a config the box is perfectly happy \
             with, which is how a gate gets disabled."
        );
    }

    // The writable state mount is the other half of the same point:
    // `SWAP_AUTOGEN_IDENTITY` persists the generated mnemonic to `statePath`,
    // so without somewhere to write it the boot is not the box's boot.
    assert!(
        FLEET_HEALTH_WORKFLOW.contains(":/app/state"),
        "fleet-health.yml's config-compat job no longer mounts a writable \
         /app/state. The maker persists its self-generated identity to \
         `statePath` there (swap.config.json), so a boot without it is not \
         the boot the box performs."
    );
}

/// Every service a box's Watchtower can recreate unattended, as observed live
/// on both boxes on 2026-08-16 (`docker ps --filter
/// label=com.centurylinklabs.watchtower.enable=true`).
///
/// `fleet-health.yml` DISCOVERS this set at runtime rather than reading a list
/// -- that is deliberate, so a service labelled on the box but not committed
/// here is still probed. This constant exists for the opposite direction: to
/// fail the build if a probe arm is deleted for a service that is known to be
/// running under that label, which discovery cannot notice because a missing
/// arm only reports at 03:00 on a cron.
const WATCHTOWER_MANAGED_SERVICES: &[&str] = &[
    // relay + store boxes
    "connector-rust",
    // relay box
    "relay",
    "swap-node",
    // store box
    "store",
];

/// A Watchtower-managed service with no serving probe is the gap toon-meta#403
/// filed and never built ("Watchtower does no health-gating; a bad image
/// auto-deploys and the container just crash-loops"). `fleet-health.yml`
/// answers an unknown service with a FAIL rather than a skip, so a new service
/// cannot be opted into auto-redeploy silently -- but a probe arm DELETED for
/// a service that is still labelled would only surface as a cron failure on
/// some later night. This asserts it at build time instead.
#[test]
fn fleet_health_defines_a_probe_for_every_watchtower_managed_service() {
    for service in WATCHTOWER_MANAGED_SERVICES {
        // The probe table is a shell `case` over the compose service name.
        // `relay|store` share one arm, so match either spelling.
        let has_arm = FLEET_HEALTH_WORKFLOW.contains(&format!("\n              {service})"))
            || FLEET_HEALTH_WORKFLOW.contains(&format!("{service}|"))
            || FLEET_HEALTH_WORKFLOW.contains(&format!("|{service})"));
        assert!(
            has_arm,
            "fleet-health.yml has no probe arm for `{service}`, which runs \
             under the Watchtower enable label on a live box. Without one the \
             workflow reports it as `NO PROBE DEFINED` on every run, which is \
             a standing failure rather than a check. Add the arm, or remove \
             the service from WATCHTOWER_MANAGED_SERVICES if it is genuinely \
             no longer auto-deployed."
        );
    }

    // The unknown-service arm itself: without it a newly labelled service
    // would be silently unprobed, which is the failure mode this whole file
    // is about.
    assert!(
        FLEET_HEALTH_WORKFLOW.contains("NO PROBE DEFINED"),
        "fleet-health.yml no longer fails on a Watchtower-managed service it \
         has no probe for. A skip there means a service can be opted into \
         unattended redeploy with nothing checking that it serves."
    );
}

/// The health workflow is only worth having if a human hears it. toon-meta#403
/// asked for "an ... external check should alert" and the alert is the half
/// that was never specified; a red tick on a 15-minute cron is not one.
#[test]
fn an_unhealthy_fleet_opens_a_labelled_issue() {
    assert!(
        FLEET_HEALTH_WORKFLOW.contains("gh issue create"),
        "fleet-health.yml no longer opens an issue on failure. Detection \
         nobody sees is what this workflow exists to replace -- the 2026-08-16 \
         maker crash-loop was found by a human happening to look."
    );
    assert!(
        FLEET_HEALTH_WORKFLOW.contains("--label \"needs:human\""),
        "fleet-health.yml's alert no longer carries `needs:human`. That is the \
         org's existing swept human queue (toon-meta#347); dropping it puts \
         the alert in a channel nobody is already reading."
    );
    assert!(
        FLEET_HEALTH_WORKFLOW.contains("issues: write"),
        "fleet-health.yml no longer requests `issues: write`, so its alert \
         step cannot open anything and the failure is silent again."
    );
    assert!(
        FLEET_HEALTH_WORKFLOW.contains("gh issue close"),
        "fleet-health.yml no longer closes its rolling alert on recovery. The \
         issue's open/closed state is meant to BE the fleet's current verdict; \
         an alert that never closes has to be read and dismissed by hand every \
         time, which is how a monitor stops being read."
    );
}

/// The `query-filters:` entries of a CodeQL config, as `(kind, id)` pairs in
/// file order, ignoring comments. The config discusses the query it excludes
/// at length, so a test keyed on the id alone would be asserting a paragraph.
fn codeql_query_filters(raw: &str) -> Vec<(String, String)> {
    let mut filters = Vec::new();
    let mut inside = false;
    let mut kind: Option<String> = None;
    for line in raw.lines() {
        if line.trim_start().starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if !inside {
            inside = line == "query-filters:";
            continue;
        }
        // Any further line at column 0 ends the block.
        if !line.starts_with(' ') {
            break;
        }
        let trimmed = line.trim_start();
        if let Some(entry) = trimmed.strip_prefix("- ") {
            kind = Some(entry.trim_end_matches(':').to_string());
        } else if let Some(id) = trimmed.strip_prefix("id:") {
            let kind = kind.clone().expect(
                "an `id:` under `query-filters:` with no `- exclude:`/`- include:` above it",
            );
            filters.push((kind, id.trim().to_string()));
        }
    }
    filters
}

/// The column-0 keys of a YAML document, ignoring comments.
fn top_level_keys(raw: &str) -> BTreeSet<String> {
    raw.lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with(' ') && !line.trim().is_empty())
        .filter_map(|line| line.split(':').next().map(str::to_string))
        .collect()
}

/// `rust/hard-coded-cryptographic-value` matches on a parameter NAME, and
/// every claim fixture here has one called `nonce` -- a monotonic counter
/// the counterparty signs over (ADR 0053), not a secret. 463 alerts on
/// `main`, and #1228 needed four dismissed by hand to go green. The fix is
/// a config that excludes that one query (#1235); the risk is that a config
/// which can exclude one query can exclude a second, or carve a directory
/// out with `paths-ignore`, and neither would show up anywhere but a
/// quieter alert count. This pins the exclusion set to exactly one id and
/// the config to the two keys it needs.
#[test]
fn codeql_runs_the_committed_config_and_excludes_exactly_one_query() {
    assert!(
        CODEQL_WORKFLOW.contains("config-file: ./.github/codeql/codeql-config.yml"),
        "codeql.yml no longer passes `.github/codeql/codeql-config.yml` to \
         `github/codeql-action/init`. Without it the scan runs unfiltered and \
         the 463 claim-nonce alerts come back, which is the state #1235 was \
         filed against."
    );

    let filters = codeql_query_filters(CODEQL_CONFIG);
    let expected = vec![(
        "exclude".to_string(),
        "rust/hard-coded-cryptographic-value".to_string(),
    )];
    assert_eq!(
        filters, expected,
        "codeql-config.yml's `query-filters` is not exactly one exclusion of \
         `rust/hard-coded-cryptographic-value`. Every other open rule -- \
         `rust/cleartext-logging`, `actions/missing-workflow-permissions` -- \
         is real, and a new alert of an excluded shape is a question about \
         this config, not a reason to widen it. If a second exclusion is \
         genuinely warranted, it gets its own rationale comment AND this \
         expected list changes with it."
    );

    let keys = top_level_keys(CODEQL_CONFIG);
    let allowed: BTreeSet<String> = ["name", "query-filters"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let extra: Vec<&String> = keys.difference(&allowed).collect();
    assert!(
        extra.is_empty(),
        "codeql-config.yml grew top-level key(s) {extra:?}. `paths` and \
         `paths-ignore` silence a directory rather than a query, `queries` \
         and `packs` change the suite away from the one default setup ran, \
         and `disable-default-queries` turns the scan off; none of those is \
         the one-query filter #1235 asked for."
    );

    // The switch has a human step no workflow performs -- an admin turns
    // default setup off, or GitHub refuses this workflow's uploads -- and
    // the header is where the next person finds that out.
    assert!(
        CODEQL_WORKFLOW.contains("code-scanning/default-setup"),
        "codeql.yml's header no longer names the default-setup switch. \
         GitHub rejects SARIF from an advanced workflow while default setup \
         is enabled, so a reader seeing the `analyze` step fail on upload \
         needs to be told it is a settings flip, not a broken scan."
    );
}

/// The move from default setup was meant to change one query, not the
/// coverage. Default setup's own uploads were categorised
/// `/language:actions`, `/language:javascript-typescript`,
/// `/language:python` and `/language:rust` (its six configured language
/// names are four extractors), on a weekly schedule plus every push and
/// PR. Dropping a language from the matrix would be a coverage cut that
/// looks like a tidy-up.
#[test]
fn codeql_covers_every_analysis_default_setup_ran() {
    for language in ["actions", "javascript-typescript", "python", "rust"] {
        assert!(
            CODEQL_WORKFLOW.contains(&format!("- language: {language}\n")),
            "codeql.yml's matrix no longer analyses `{language}`, which \
             default setup did. The switch to an advanced setup (#1235) was \
             a query filter, not a coverage change."
        );
    }
    assert!(
        !CODEQL_WORKFLOW.contains("build-mode: autobuild")
            && !CODEQL_WORKFLOW.contains("build-mode: manual"),
        "codeql.yml asks CodeQL to build something. Default setup analysed \
         Rust with `build-mode: none`, and the other three languages have no \
         other mode; a build here is a second Rust compile on every PR that \
         the scan does not need."
    );

    let triggers = workflow_triggers(CODEQL_WORKFLOW);
    for trigger in ["push", "pull_request", "schedule"] {
        assert!(
            triggers.contains(trigger),
            "codeql.yml no longer runs on `{trigger}` (it runs on {triggers:?}). \
             Default setup ran on every push, every PR and a weekly schedule; \
             the schedule is what catches a query-pack update against an \
             unchanged `main`."
        );
    }
}
