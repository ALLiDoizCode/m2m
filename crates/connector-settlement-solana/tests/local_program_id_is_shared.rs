//! The containerised validator and the in-process test harness must load
//! `payment_channel.so` under the SAME program id.
//!
//! `infra/solana/entrypoint.sh` passes a bare `--bpf-program <id>` at genesis
//! rather than deploying against a keypair, precisely so the id is a committable
//! constant rather than a per-machine artifact of whoever ran `cargo build-sbf`
//! first. That only holds while the shell constant and
//! [`LOCAL_TEST_PROGRAM_ID`] agree -- and nothing else would notice them
//! drifting: the container would come up healthy, load the program at some
//! other id, and every settlement call from a connector configured with the
//! Rust constant would fail with the program not existing. A committed
//! `connector.toml` naming the wrong id is exactly the failure this guard is
//! cheaper than debugging.
//!
//! Deliberately a plain string search over the committed file rather than a
//! parse: the point is that the id appears there, not how the script is
//! shaped. `include_str!` matches how `connector-bin`'s own
//! `devnet_configs_load.rs` holds the committed `infra/` files to their
//! callers.

use connector_settlement_solana::test_support::LOCAL_TEST_PROGRAM_ID;

const ENTRYPOINT: &str = include_str!("../../../infra/solana/entrypoint.sh");

#[test]
fn the_container_validator_loads_the_program_at_the_harness_program_id() {
    assert!(
        ENTRYPOINT.contains(LOCAL_TEST_PROGRAM_ID),
        "infra/solana/entrypoint.sh does not mention {LOCAL_TEST_PROGRAM_ID}. The containerised \
         validator and connector_settlement_solana::test_support must load payment_channel.so \
         under the same program id -- otherwise a connector configured for one cannot settle \
         against the other, and nothing else in this repository would report it."
    );
}

/// Every line of the script that is not a comment. The keypair check below
/// has to read what the script *does*: the header explains at length why it
/// no longer runs `solana program deploy`, and matching that prose would make
/// the guard fail on the very change that satisfies it.
fn executable_lines() -> String {
    ENTRYPOINT
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_container_validator_needs_no_program_keypair() {
    let script = executable_lines();
    assert!(
        !script.contains("program deploy"),
        "infra/solana/entrypoint.sh is deploying the program after startup again. That needs a \
         `payment_channel-keypair.json` beside the .so to pin the program id, which is untracked \
         (tools/ci/check-tracked-secrets.sh) and therefore per-machine. Load it into genesis with \
         --bpf-program instead; see that file's header and connector#922."
    );
    assert!(
        script.contains("--bpf-program"),
        "infra/solana/entrypoint.sh no longer passes --bpf-program, so nothing loads \
         payment_channel.so into the validator's genesis."
    );
}
