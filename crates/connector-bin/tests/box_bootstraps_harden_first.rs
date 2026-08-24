//! A box bootstrap must harden the box before it can fail.
//!
//! Every `infra/*/bootstrap.sh` runs under `set -euo pipefail`, so every step
//! is a step that can abort the run. That makes step order a safety property,
//! not a style question: whatever sits ahead of the firewall and the SSH
//! hardening decides what a freshly created box looks like when provisioning
//! dies halfway.
//!
//! It sat wrong. The Docker install — a `curl … get.docker.com | sh` over the
//! public internet — ran *before* both, on all three boxes. A network blip, an
//! apt hiccup or an upstream outage was therefore enough to leave a new box
//! with no firewall and password SSH still enabled, signalled by one line in a
//! log that nobody re-reads, because a reprovision happens under incident
//! pressure. Two of these boxes serve devnet and the third holds the devnet
//! USDC treasuries.
//!
//! `infra/harden-box.sh` fixed it in two halves, and this file asserts both,
//! because either alone rots:
//!
//! * **Harden first.** `harden_box` is the first substantive step, so no later
//!   failure can leave the box open. The tempting alternative — reorder and
//!   move on — is not enough on its own: whatever runs first can itself fail.
//! * **Assert at exit.** An EXIT trap re-reads `ufw status` and `sshd -T` and
//!   turns any exit that leaves the box unhardened into a loud, non-zero one.
//!
//! What this file must never be "fixed" into asserting: that the hardening
//! runs earlier than the firewall, or that `harden-ssh.sh`'s lockout guard is
//! relaxed to let it. That guard refuses to disable password authentication on
//! a box with no usable key in `/root/.ssh/authorized_keys`, because doing so
//! bricks the box — LISH console only. Trading a bounded exposure for a
//! permanent lockout is the worse trade, and the last case here nails the
//! guard down so nobody makes it while tidying the order.
//!
//! Discovered, not listed. The boxes come from globbing `infra/`, so a fourth
//! one cannot arrive with the old ordering and no test to catch it.

use std::path::{Path, PathBuf};

fn infra_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../infra")
}

struct Bootstrap {
    /// The box directory's name, e.g. `linode-relay`.
    box_name: String,
    dir: PathBuf,
    source: String,
}

impl Bootstrap {
    /// Lines with comments and blanks removed, so a call named in prose — and
    /// these files are mostly prose — is never mistaken for a call made.
    fn code_lines(&self) -> Vec<&str> {
        self.source
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()
    }

    /// Index of the first code line containing `needle`.
    fn first(&self, needle: &str) -> Option<usize> {
        self.code_lines().iter().position(|l| l.contains(needle))
    }
}

/// Every `infra/*/bootstrap.sh`.
fn bootstraps() -> Vec<Bootstrap> {
    let mut found: Vec<Bootstrap> = std::fs::read_dir(infra_dir())
        .expect("infra/ must be readable")
        .filter_map(|entry| {
            let dir = entry.expect("readable dir entry").path();
            let script = dir.join("bootstrap.sh");
            if !script.is_file() {
                return None;
            }
            Some(Bootstrap {
                box_name: dir
                    .file_name()
                    .expect("box directory has a name")
                    .to_string_lossy()
                    .into_owned(),
                source: std::fs::read_to_string(&script)
                    .unwrap_or_else(|e| panic!("read {}: {e}", script.display())),
                dir,
            })
        })
        .collect();
    found.sort_by(|a, b| a.box_name.cmp(&b.box_name));

    // Not a formality. If the glob ever stops matching — a rename, a move, a
    // restructure — every case below would pass over an empty list and this
    // whole file would go green while asserting nothing, which is the failure
    // mode CLAUDE.md's "no harness may execute zero tests" rule is about.
    assert!(
        found.len() >= 3,
        "found {} bootstrap script(s) under infra/, expected at least the \
         three box bootstraps (linode-relay, linode-store, linode-faucet). \
         Either a box was deleted — in which case update this floor and say so \
         — or the discovery below stopped matching and every case in this file \
         is now vacuous.",
        found.len()
    );
    found
}

/// Steps that reach the network, the package manager or the operator's config,
/// and can therefore abort the run. None of them may precede the hardening.
const CAN_FAIL: &[(&str, &str)] = &[
    ("get.docker.com", "the Docker install"),
    ("apt-get", "an apt-get invocation"),
    ("${COMPOSE[@]}", "a docker compose step"),
    ("envsubst", "the nginx template render"),
    ("init-letsencrypt.sh", "the TLS issuance"),
    ("$HERE/.env", "reading the operator's .env"),
];

#[test]
fn every_box_bootstrap_hardens_before_anything_that_can_fail() {
    for b in bootstraps() {
        let harden = b.first("harden_box \"$HERE\"").unwrap_or_else(|| {
            panic!(
                "infra/{}/bootstrap.sh never calls `harden_box \"$HERE\"`. Every box \
                 bootstrap hardens through infra/harden-box.sh so the order lives in \
                 one place — see that file's header.",
                b.box_name
            )
        });

        for (marker, what) in CAN_FAIL {
            if let Some(at) = b.first(marker) {
                assert!(
                    harden < at,
                    "infra/{}/bootstrap.sh runs {what} (line matching `{marker}`) BEFORE \
                     it hardens the box. Under `set -e` that step failing aborts \
                     provisioning and leaves this box with no firewall and password SSH \
                     still enabled. Move `harden_box` back to the top; see \
                     infra/harden-box.sh for why nothing legitimately needs to precede it.",
                    b.box_name
                );
            }
        }
    }
}

#[test]
fn every_box_bootstrap_arms_the_exit_assertion_before_it_hardens() {
    for b in bootstraps() {
        let source = b.first(". \"$HERE/../harden-box.sh\"").unwrap_or_else(|| {
            panic!(
                "infra/{}/bootstrap.sh does not source infra/harden-box.sh.",
                b.box_name
            )
        });
        let arm = b.first("require_hardened_on_exit").unwrap_or_else(|| {
            panic!(
                "infra/{}/bootstrap.sh never calls `require_hardened_on_exit`. Without \
                 the EXIT trap, an exit that leaves the box unhardened is silent — and \
                 hardening first is not sufficient on its own, because the hardening \
                 itself can fail.",
                b.box_name
            )
        });
        let harden = b
            .first("harden_box \"$HERE\"")
            .expect("asserted by the case above");

        assert!(
            source < arm && arm < harden,
            "infra/{}/bootstrap.sh must source harden-box.sh, then arm the exit \
             assertion, then harden — in that order. Arming after the hardening \
             would leave every exit before it unreported, which includes the \
             hardening's own failure.",
            b.box_name
        );
    }
}

#[test]
fn no_box_bootstrap_runs_the_firewall_or_the_ssh_hardening_itself() {
    for b in bootstraps() {
        for direct in ["$HERE/firewall.sh", "harden-ssh.sh"] {
            assert!(
                b.first(direct).is_none(),
                "infra/{}/bootstrap.sh calls `{direct}` directly. Both halves go \
                 through `harden_box` in infra/harden-box.sh so their order — \
                 firewall first, so an SSH-hardening refusal still leaves a \
                 firewalled box — is stated once rather than three times.",
                b.box_name
            );
        }
    }
}

#[test]
fn every_box_bootstrap_has_the_firewall_script_it_hardens_with() {
    for b in bootstraps() {
        let firewall = b.dir.join("firewall.sh");
        assert!(
            firewall.is_file(),
            "infra/{}/bootstrap.sh calls `harden_box \"$HERE\"`, which runs \
             $HERE/firewall.sh — and there is no firewall.sh in that directory. \
             The hardening would abort on the box's very first step.",
            b.box_name
        );

        let source = std::fs::read_to_string(&firewall).expect("read firewall.sh");
        assert!(
            source.contains("ufw default deny incoming") && source.contains("ufw --force enable"),
            "infra/{}/firewall.sh no longer denies incoming by default or no longer \
             enables ufw. A firewall script that runs clean and leaves the box open is \
             worse than none: the exit assertion in infra/harden-box.sh reads \
             `ufw status` back, but this is the file that has to make it say `active`.",
            b.box_name
        );
    }
}

#[test]
fn the_shared_hardening_runs_the_firewall_before_the_ssh_half() {
    let source =
        std::fs::read_to_string(infra_dir().join("harden-box.sh")).expect("read harden-box.sh");
    let code: Vec<&str> = source
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();

    let firewall = code
        .iter()
        .position(|l| l.contains("$dir/firewall.sh"))
        .expect("harden_box must run the box's firewall.sh");
    let ssh = code
        .iter()
        .position(|l| l.contains("harden-ssh.sh"))
        .expect("harden_box must run infra/harden-ssh.sh");

    assert!(
        firewall < ssh,
        "infra/harden-box.sh runs harden-ssh.sh before firewall.sh. The SSH half is \
         allowed to refuse — it fails closed on a box with no usable authorized key — \
         so the firewall goes first, and a refusal then leaves a box that is at least \
         firewalled instead of one that is neither."
    );
}

#[test]
fn the_exit_assertion_reads_the_box_back_rather_than_trusting_a_flag() {
    let source =
        std::fs::read_to_string(infra_dir().join("harden-box.sh")).expect("read harden-box.sh");

    for probe in ["ufw status", "sshd -T", "passwordauthentication"] {
        assert!(
            source.contains(probe),
            "infra/harden-box.sh's exit assertion no longer runs `{probe}`. It must \
             prove the state of the BOX, not that this script reached a line: a flag \
             alone passes on a box where something later turned password \
             authentication back on."
        );
    }
    assert!(
        source.contains("trap _toon_on_exit EXIT"),
        "infra/harden-box.sh no longer installs the EXIT trap. Without it an aborted \
         provision reports a Docker error and says nothing about the box being open."
    );
}

/// The guard that makes hardening early *safe* rather than reckless.
///
/// `harden-ssh.sh` refuses to disable password authentication unless root
/// already has a usable key. Provisioning satisfies that before a bootstrap
/// starts — `create_box` in infra/devnet-manage.sh passes the operator's public
/// key in the Linode create call's `authorized_keys` field, and every path that
/// reaches a bootstrap has already used that key to get there — so moving the
/// hardening earlier cannot strand it. Deleting the guard to make some future
/// ordering work would swap a bounded exposure for a permanent lockout.
#[test]
fn the_ssh_hardening_keeps_its_lockout_guard() {
    let source =
        std::fs::read_to_string(infra_dir().join("harden-ssh.sh")).expect("read harden-ssh.sh");

    assert!(
        source.contains("authorized_keys") && source.contains("REFUSING to harden"),
        "infra/harden-ssh.sh no longer refuses to run on a box with no usable \
         authorized key. That guard is the only thing standing between a box in an \
         unexpected state and a permanent lockout — Linode's LISH console is the \
         entire recovery path once password authentication is off. Never relax it to \
         make an ordering work; the ordering is what moves."
    );
    assert!(
        source.contains("sshd -T"),
        "infra/harden-ssh.sh no longer reads the effective sshd config back. It must \
         prove what sshd RESOLVED, not what the drop-in file says — an earlier \
         directive elsewhere can win, and a box that looks hardened but takes \
         passwords is the exact failure this script exists to make impossible."
    );
}
