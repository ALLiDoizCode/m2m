#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Make the box key-only: no password SSH, no root password login.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Every devnet box is reached with a key (`ssh -i "$SSH_KEY" root@…` in
# infra/devnet-manage.sh), so password authentication is an attack surface that
# buys nothing. It was left on: Linode's images accept password SSH by default
# when `root_pass` is set at create/rebuild, and nothing here turned it off.
#
# ── WHY THIS EXISTS (do not delete without reading) ─────────────────────────
# `infra/devnet-manage.sh` carried the four boxes' root passwords in cleartext
# in this PUBLIC repository from 2026-06-23 until they were removed. Anyone who
# read the repo in that window has them, and git history keeps them forever.
# Rotating the values in the file is therefore NOT a fix on its own — the boxes
# must stop accepting passwords at all, which is what this script does.
#
# ── THE LOCKOUT GUARD ───────────────────────────────────────────────────────
# Disabling password auth on a box with no usable public key bricks it: there
# is then no way in short of Linode's LISH console. So this script REFUSES to
# proceed unless root already has at least one key in ~/.ssh/authorized_keys.
# Provisioning puts the operator's key there (`authorized_keys` in the Linode
# create call), so on a freshly provisioned box the guard passes; on a box in
# an unexpected state it fails closed and changes nothing.
#
# Idempotent: safe to re-run. Run as root.
set -euo pipefail

AUTH_KEYS="${AUTH_KEYS:-/root/.ssh/authorized_keys}"
SSHD_DROPIN="/etc/ssh/sshd_config.d/10-toon-hardening.conf"

# ── Guard: never lock the box out ───────────────────────────────────────────
key_count=0
if [ -r "$AUTH_KEYS" ]; then
  # Count non-empty, non-comment lines.
  key_count=$(grep -cvE '^\s*(#|$)' "$AUTH_KEYS" || true)
fi

if [ "$key_count" -eq 0 ]; then
  echo "REFUSING to harden: no usable key in $AUTH_KEYS." >&2
  echo "Disabling password auth now would leave no way into this box." >&2
  echo "Add the operator's public key first, then re-run." >&2
  exit 1
fi

echo "==> sshd hardening ($key_count authorized key(s) present)"

# ── Apply ───────────────────────────────────────────────────────────────────
# A drop-in rather than an edit of sshd_config: it survives package upgrades
# that rewrite the main file, and it is one file to inspect or remove.
mkdir -p /etc/ssh/sshd_config.d
cat > "$SSHD_DROPIN" <<'CONF'
# TOON devnet hardening — managed by infra/harden-ssh.sh. Do not edit by hand.
# Key-only access. See that script's header for why this is not optional.
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
CONF
chmod 0644 "$SSHD_DROPIN"

# Ubuntu 22.04+ ships `Include /etc/ssh/sshd_config.d/*.conf`. If this image
# does not, the drop-in would be silently ignored — which would look like the
# box was hardened when it was not. Fail loudly instead.
if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
  echo "sshd_config does not Include sshd_config.d/*.conf — drop-in would be ignored." >&2
  echo "Refusing to report success. Add the Include line, then re-run." >&2
  exit 1
fi

# ── Verify before restarting ────────────────────────────────────────────────
# A syntax error here means sshd fails to start and the box is unreachable.
sshd -t

systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload

# ── Prove it took ───────────────────────────────────────────────────────────
# Read back what sshd ACTUALLY resolved, not what the file says — an earlier
# directive elsewhere could win.
effective_pw=$(sshd -T 2>/dev/null | awk '$1=="passwordauthentication"{print $2}')
effective_root=$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')

echo "    passwordauthentication = ${effective_pw:-unknown}"
echo "    permitrootlogin        = ${effective_root:-unknown}"

if [ "$effective_pw" != "no" ]; then
  echo "PasswordAuthentication is still '${effective_pw:-unknown}' after reload." >&2
  exit 1
fi

echo "✅ sshd is key-only."
