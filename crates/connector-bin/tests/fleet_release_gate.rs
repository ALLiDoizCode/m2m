//! Guards the connector's release/build pipeline: the release dispatch, the
//! candidate tags it publishes, the release handle shape, and the health
//! probe's coverage. [ADR
//! 0041](../../../docs/adr/0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md),
//! [ADR
//! 0055](../../../docs/adr/0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md)
//! and [ADR
//! 0068](../../../docs/adr/0068-a-node-repository-pins-the-connector-nothing-here-moves-a-tag-onto-a-box.md).
//!
//! Deliberately a SEPARATE harness from `devnet_configs_load.rs` rather than
//! more cases appended to it. That file asserts what the committed fleet
//! fixtures contain; this one asserts what the committed release *pipeline*
//! does, and the two are edited by different work for different reasons.
//!
//! ADR 0068 retired the promotion half of this gate: `promote-to-fleet.yml`
//! is gone, and with it every case that asserted its content (the deploy-
//! ordering gate, the apply-run verification, the fleet tag retag). Neither
//! devnet box deploys from this repository any more -- each pins the
//! connector by release handle in its OWN repo's `deploy/` bundle -- so there
//! is nothing left here for a promotion to gate. What survives is everything
//! upstream of that: the build stays one shared definition, the release
//! handle stays a dated ordinal, and the release workflow stays a human act.
//!
//! Most surviving cases are regression tests for something that actually
//! happened on 2026-08-16, and each one names it.

use std::collections::BTreeSet;

const PUBLISH_CONNECTOR_WORKFLOW: &str =
    include_str!("../../../.github/workflows/publish-connector-rust-image.yml");
const RELEASE_WORKFLOW: &str = include_str!("../../../.github/workflows/release-connector.yml");
const FLEET_HEALTH_WORKFLOW: &str = include_str!("../../../.github/workflows/fleet-health.yml");
const RELAY_SWAP_CONFIG: &str = include_str!("../../../infra/linode-relay/swap.config.json");
const RELAY_SWAP_OVERLAY: &str =
    include_str!("../../../infra/linode-relay/docker-compose.relay.swap.yml");

/// A `docker/metadata-action` `type=raw,value=<tag>` line, ignoring `#`
/// comments -- the workflow discusses `rust-release` at length in its
/// header, and a test keyed on the word alone would be asserting prose.
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

/// THE regression test for the mistake this file exists to catch.
///
/// connector#990 shipped `type=raw,value=rust-release,enable={{is_default_branch}}`
/// here, which made `:rust-release` move on every green merge to `main`. Both
/// devnet boxes were then repointed to follow that tag under a label-scoped
/// Watchtower, so every green merge reached the live client edge on two
/// machines inside a minute, unvalidated.
///
/// ADR 0068 retired the mechanism that used to supervise this tag
/// (`promote-to-fleet.yml`) because neither box follows it from this repo any
/// more -- each node repo pins the connector image by release handle in its
/// own `deploy/` bundle. That makes this property MORE important, not less:
/// with no promotion gate left in this repo, `rust-release` reappearing here
/// would move a tag with no check in front of it at all.
#[test]
fn the_build_workflow_publishes_candidates_and_never_moves_the_promotion_tag() {
    let tags = raw_metadata_tags(PUBLISH_CONNECTOR_WORKFLOW);

    assert!(
        !tags.contains("rust-release"),
        "publish-connector-rust-image.yml pushes `rust-release` again. Nothing \
         in this repository supervises that tag any more (ADR 0068) -- a node \
         repo pins the connector by release handle in its own deploy/ bundle. \
         Re-adding it here would move a tag with no gate in front of it at \
         all. Tags found: {tags:?}"
    );

    // The candidate tags must still be published: a node repo pins one of
    // these (the immutable `rust-sha-` tag, or the release's `rust-<handle>`
    // alias) as its own reviewed change.
    assert!(
        tags.iter().any(|t| t.starts_with("rust-sha-")),
        "publish-connector-rust-image.yml no longer publishes an immutable \
         `rust-sha-` tag. A node repository pins exactly this shape to adopt \
         a build. Tags found: {tags:?}"
    );
}

/// The top-level `on:` keys of a workflow, by indentation, ignoring comments.
/// The workflow discusses its triggers at length in prose, so a test keyed
/// on the word `push` alone would be asserting a paragraph.
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

/// THE regression test for ADR 0041 Decision 3, restated by ADR 0055 and
/// left standing by ADR 0068: a release is a human act.
///
/// `release-connector.yml` builds, versions and publishes a GitHub Release --
/// which is to say it is one `workflow_run:` away from firing on every green
/// merge. connector#990 was the one-line version of that mistake and it
/// reached both live devnet boxes within ~60s of every merge at the time.
/// `connector-rust` is still the client edge on both boxes today, even though
/// neither pulls its image from a tag this repo moves any more -- an
/// automatic trigger here would still mean an unreviewed image and release
/// on every merge, which is the churn this rule exists to prevent.
///
/// A `pull_request` trigger would be no better than a `push` one here.
#[test]
fn the_release_workflow_is_dispatch_only() {
    let triggers = workflow_triggers(RELEASE_WORKFLOW);
    let expected: BTreeSet<String> = ["workflow_dispatch".to_string()].into_iter().collect();

    assert_eq!(
        triggers, expected,
        "release-connector.yml is triggered by something other than a human \
         dispatch. Cutting a release and publishing a GitHub Release is a \
         deliberate act (ADR 0041 Decision 3, ADR 0055) and ANY automatic \
         trigger here turns it into churn on every merge -- the shape \
         connector#990 shipped once and was reverted."
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

/// The handle is a date and an ordinal, and it is not semver.
///
/// deploy/connector-rust/README.md's reasoning about the image tags binds
/// here too: no crate under `crates/` has a release process, every one is
/// `0.1.0`, and a semver series "would claim a stability contract the binary
/// hasn't earned". Someone eventually pins against a version number, and a
/// MAJOR that means nothing is worse than no number at all.
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
}

/// The chain-provider fields the maker refuses to boot without, mirrored from
/// `SWAP_REQUIRED_PROVIDER_FIELDS.evm` in toon-protocol/swap
/// `packages/swap/src/swap-node.ts`. Enforced by `validateChainProviderEntry`,
/// which throws `SwapNodeStartError('INVALID_CONFIG', ...)` naming the missing
/// setting.
///
/// A mirror, not a derivation -- this repo cannot import the maker's schema.
/// That is precisely why `fleet-health.yml`'s config-compat gate boots the
/// real image against this real file rather than trusting a list like this
/// one: a key added in `swap` will not appear here on its own. This case
/// catches the cheaper failure, an edit to the config in THIS repo that drops
/// a field the maker needs, and it catches it in CI instead of on the box.
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
                 is the 2026-08-16 outage."
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

/// The config-compatibility gate boots the `:release` image against the
/// committed `swap.config.json`, and it can only be trusted if what it boots
/// is what the BOX boots. The first run of this gate proved that is not
/// automatic: booting the file by itself failed on a missing identity that
/// the box never misses, because the overlay supplies it as an environment
/// variable rather than a config key.
///
/// So `fleet-health.yml`'s `config-compat` job reproduces the SERVICE: the
/// file, plus this environment, plus a writable state mount. This case is
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
