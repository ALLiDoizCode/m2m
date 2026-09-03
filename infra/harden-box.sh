#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# The hardening sequence every box bootstrap runs, and the assertion that it did.
# SOURCE this file (`. "$HERE/../harden-box.sh"`); it is not a script to run.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# Every bootstrap.sh under infra/ runs `set -euo pipefail`, so ANY failing step
# aborts it. Until this file existed, the Docker install ran BEFORE the firewall
# and before the SSH hardening, which made a network blip, an apt hiccup or a
# get.docker.com outage enough to abort provisioning and leave a freshly created
# box with no firewall and password SSH still enabled — with no signal beyond
# one line in a log that nobody re-reads, because a reprovision happens under
# incident pressure.
#
# Two properties fix that, and both are needed:
#
#   1. HARDEN FIRST. `harden_box` is the first substantive step of every
#      bootstrap, so no later failure can leave the box open. Nothing in a
#      bootstrap contributes to hardening's preconditions — see the note on the
#      lockout guard below — so there is nothing to run before it.
#   2. ASSERT AT EXIT. Reordering alone is not enough: whatever runs first can
#      itself fail, and then the box is open again. `require_hardened_on_exit`
#      installs an EXIT trap that re-reads the box's ACTUAL state — `ufw status`
#      and `sshd -T`, not a flag this script set — and turns any exit that
#      leaves the box unhardened into a loud, non-zero one.
#
# The trap REPORTS; it does not try to harden. It runs in the wreckage of an
# unknown failure, hardening is already the first thing attempted, and a trap
# that acts would mask which step actually failed. Screaming is the honest job.
#
# ── ORDER WITHIN THE PAIR: FIREWALL, THEN SSH ───────────────────────────────
# `harden-ssh.sh` refuses to disable password authentication on a box with no
# usable key in /root/.ssh/authorized_keys, because doing so bricks the box
# (LISH console only). That guard is deliberate and is NOT relaxed here. It
# means the SSH half can legitimately refuse — so the firewall runs first, and a
# refusal leaves a box that is at least firewalled rather than one that is
# neither.
#
# That guard is also why the hardening can move this early at all. Its
# precondition is satisfied before a bootstrap starts, not by anything a
# bootstrap does: `create_box` in infra/devnet-manage.sh passes the operator's
# public key in the Linode create call's `authorized_keys`, so the key is on the
# box before it finishes booting — and every path that reaches a bootstrap
# (`ssh -i "$SSH_KEY" root@…`, or a human on the box) has already used it. No
# step between the top of a bootstrap and the old call site installed a key.
#
# ── WHAT harden_box DEPENDS ON ──────────────────────────────────────────────
# `ufw` for the firewall; grep/mkdir/cat/chmod/sshd/systemctl for the SSH half.
# All of those ship in Ubuntu's server image, so the normal path installs
# nothing and an apt or network failure cannot keep the box open. The apt
# fallback below is for an image that somehow lacks ufw; if IT fails, the box is
# open, the run aborts, and the exit trap says so in those words.

# Set by harden_box; read by the exit trap. Declared here so `set -u` is happy
# in a bootstrap that dies before harden_box runs.
toon_box_hardened=0

# The directory this file lives in — infra/. Resolved at source time because
# BASH_SOURCE is this file only while it is being sourced.
TOON_INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Firewall, then key-only SSH. Marks the box hardened for the exit trap.
#   $1 — the box directory holding this box's firewall.sh
harden_box() {
  local dir=$1

  if ! command -v ufw >/dev/null 2>&1; then
    echo "    ufw not present in this image — installing it before the firewall"
    apt-get update -y
    apt-get install -y ufw
  fi

  echo "    firewall (public = 22/80/443 only)"
  "$dir/firewall.sh"

  echo "    sshd (key-only; no password auth)"
  "$TOON_INFRA_DIR/harden-ssh.sh"

  toon_box_hardened=1
}

_toon_on_exit() {
  local rc=$?
  trap - EXIT

  # Read back what the box ACTUALLY looks like. Every command here tolerates
  # failure: this runs on the failure path, where a `set -e` abort would
  # swallow the very message the operator needs.
  local fw pw
  fw="$(ufw status 2>/dev/null | head -1 || true)"
  pw="$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}' || true)"

  # The flag says the script got past harden_box; the readback says the box is
  # actually hardened. Require both — the flag alone would pass on a box where
  # something later re-enabled password auth, and the readback alone would pass
  # on a box that was already hardened by an earlier run that then failed
  # everywhere else.
  if [ "$toon_box_hardened" -eq 1 ] &&
    [ "${fw#Status: }" = "active" ] &&
    [ "$pw" = "no" ]; then
    exit "$rc"
  fi

  echo >&2
  echo "════════════════════════════════════════════════════════════════════" >&2
  echo "!! THIS BOX IS NOT HARDENED. It is open on the public internet.   !!" >&2
  echo "════════════════════════════════════════════════════════════════════" >&2
  echo "    ${fw:-Status: unknown (ufw not installed or not readable)}" >&2
  echo "    passwordauthentication = ${pw:-unknown}" >&2
  echo >&2
  echo "    Provisioning exited before the box was firewalled and made" >&2
  echo "    key-only. Fix the error above and re-run this bootstrap, or" >&2
  echo "    apply the two steps by hand, in this order:" >&2
  echo >&2
  echo "      ./<this box's dir>/firewall.sh" >&2
  echo "      ./infra/harden-ssh.sh" >&2
  echo >&2
  echo "    If harden-ssh.sh refuses, root has no usable key in" >&2
  echo "    /root/.ssh/authorized_keys — add one and re-run it. Do NOT" >&2
  echo "    disable that guard: it is what stops a permanent lockout." >&2
  echo "    See docs/operators/devnet-ssh-hardening.md." >&2
  echo >&2

  if [ "$rc" -eq 0 ]; then
    rc=1
  fi
  exit "$rc"
}

# Install the exit trap. Call this as early as a bootstrap can — every exit
# after it, including the trivial "you forgot .env" one, is an exit that left
# the box in whatever state the readback reports.
require_hardened_on_exit() {
  trap _toon_on_exit EXIT
}
