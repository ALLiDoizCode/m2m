# Devnet SSH hardening, and the root-password exposure

**Status: done, both halves.** The repository half shipped in #930; §2 was run on every live box
on 2026-08-12 and closed [#931](https://github.com/toon-protocol/connector/issues/931), which
records `passwordauthentication no` and an external `Permission denied (publickey).` probe for
each. §2 stays here because it is still the procedure for any box that needs it — a rebuild, a
box that fails the check, or one whose bootstrap aborted before hardening (§4).

---

## 1. What happened

`infra/devnet-manage.sh` defined the root passwords for all four devnet boxes — `toon`, `ario`,
`relay`, `faucet` — as cleartext literals in a `NODE_PASSWORDS` map. That file is in this
**public** repository, and the map was committed on `main` from **2026-06-23** (`f9ac0bc9`) until
it was removed.

Two things made that exploitable rather than merely untidy:

- **Nothing turned password authentication off.** No `PasswordAuthentication no`, no
  `PermitRootLogin prohibit-password` — in any of the five `bootstrap.sh` scripts, or anywhere
  else under `infra/`. Linode's Ubuntu images accept password SSH by default when `root_pass` is
  set at create or rebuild, and every box was created that way.
- **Port 22 is open to the internet.** `firewall.sh` on each box allows `22/tcp` from anywhere,
  by design.

So for roughly seven weeks the boxes accepted `ssh root@<ip>` with a password published in git.

### What rotating does not fix

Changing the values in the file fixes nothing on its own. **Git history keeps the old passwords
forever** — they are recoverable from any clone, and rewriting public history is not a remedy you
can rely on, because anyone who fetched in that window already has them.

The only durable fix is to make the boxes **stop accepting passwords at all**, which is what
`infra/harden-ssh.sh` does. Rotation is still worth doing, but it is the second line of defence,
not the first.

---

## 2. Fixing a live box

Bootstrap only runs at provision time, so an already-running box is unaffected by a repository
change. Run this on any box that needs it. When #931 did this the fleet was `toon`, `ario`,
`relay` and `faucet`; `toon` has since been destroyed (issue #872), so today that is `ario`,
`relay` and the faucet box.

**Before you start:** confirm you can reach the box by key. If key auth is broken and you disable
passwords, the only way back in is Linode's LISH console.

```bash
# 1. Prove key auth works. This must succeed WITHOUT prompting for a password.
ssh -i ~/.ssh/id_rsa -o PasswordAuthentication=no root@<box-ip> true && echo "key auth OK"

# 2. Rotate the root password to something not in git (Linode dashboard, or the API).
#    Do this even though step 3 disables password login — defence in depth, and it
#    closes the console login path too.

# 3. Harden. The script refuses to run if root has no authorized key, so it
#    cannot lock you out of a box in an unexpected state.
scp -i ~/.ssh/id_rsa infra/harden-ssh.sh root@<box-ip>:/tmp/
ssh -i ~/.ssh/id_rsa root@<box-ip> 'bash /tmp/harden-ssh.sh && rm /tmp/harden-ssh.sh'
```

The script prints what `sshd -T` **actually resolved** — not what the file says — and exits
non-zero if `passwordauthentication` is anything but `no`. Treat its `✅ sshd is key-only.` as the
acceptance signal.

### Verify from outside

```bash
# Expect: "Permission denied (publickey)." — NOT a password prompt.
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@<box-ip>
```

---

## 3. What the repository change does

| Change                      | Effect                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/harden-ssh.sh` (new) | Idempotent, lockout-guarded. Writes a drop-in at `/etc/ssh/sshd_config.d/10-toon-hardening.conf`, validates with `sshd -t`, reloads, then re-reads the effective config to prove it took.                |
| `infra/harden-box.sh` (new) | Firewall then `harden-ssh.sh`, plus the EXIT trap that asserts the box's final state. Sourced by every box `bootstrap.sh`; see §4.                                                                       |
| Every `bootstrap.sh`        | Calls `harden_box` as its first step, ahead of everything that can fail, so every newly provisioned or rebuilt box is key-only from birth.                                                               |
| `infra/devnet-manage.sh`    | `NODE_PASSWORDS` deleted. `create_box` now generates a throwaway root password per create (`new_root_pass`) purely to satisfy the Linode API, which requires one. It is never printed, stored or reused. |

### Why a drop-in rather than editing `sshd_config`

It survives package upgrades that rewrite the main file, and it is one file to inspect or remove.
The script checks that `sshd_config` actually carries the `Include /etc/ssh/sshd_config.d/*.conf`
line and **fails loudly if it does not** — otherwise the drop-in would be silently ignored and the
box would look hardened while still accepting passwords.

### Why the lockout guard is not optional

`harden-ssh.sh` counts non-comment lines in `/root/.ssh/authorized_keys` and refuses to proceed if
there are none. Provisioning installs the operator's key via the Linode `authorized_keys` field, so
a freshly created box passes; a box in an unexpected state fails closed and is left unchanged.

---

## 4. Why hardening is the first step, and why that is not enough on its own

Every `bootstrap.sh` runs under `set -euo pipefail`, so any failing step aborts the run. Until
`infra/harden-box.sh` existed, the Docker install — a `curl … get.docker.com | sh` over the public
internet — ran **before** both `firewall.sh` and `harden-ssh.sh`. A network blip or an apt hiccup
was therefore enough to abort provisioning and leave a fresh box with no firewall and password SSH
still on, announced by nothing but a line in a log that nobody re-reads during an incident.

Two changes, and both are load-bearing:

- **`harden_box` runs first.** Nothing in a bootstrap contributes to its preconditions, so nothing
  legitimately needs to precede it: the operator's key is on the box from the Linode create call's
  `authorized_keys` field, before the box finishes booting. Any later failure now leaves a
  firewalled, key-only box.
- **An EXIT trap asserts the result.** Reordering alone would not be enough — whatever runs first
  can itself fail. `require_hardened_on_exit` re-reads `ufw status` and `sshd -T` on the way out and
  turns any exit that leaves the box unhardened into a loud, non-zero one, printing the two steps to
  run by hand.

Within the pair the order is fixed: **firewall first**. `harden-ssh.sh` is allowed to refuse — it
fails closed on a box with no usable authorized key — so a refusal leaves a box that is at least
firewalled instead of one that is neither. Do not relax that guard to make some other ordering work.

`crates/connector-bin/tests/box_bootstraps_harden_first.rs` holds all of this in the Rust gate,
against every `infra/*/bootstrap.sh` it discovers rather than a hardcoded list.

### What this does not fix

The exposure window opens when the box **boots**, not when bootstrap runs: Linode's image accepts
password SSH from first boot, and there is no firewall until `firewall.sh` runs. Provisioning
cannot close a window it does not open — it can only stop extending it indefinitely, which is what
the above does. The credential in that window is a 32-character password generated per create by
`new_root_pass` and never printed, stored or reused, so it is not a guessable one; the boxes
created before that change are the ones §2 is for.

---

## 5. Follow-on

- **Access for CI.** `devnet-manage.sh` uses the operator's personal `~/.ssh/id_rsa`. The
  dedicated devnet-scoped key this section asked for now exists as the `DEVNET_SSH_KEY` secret
  (`fleet-ops.yml`, `fleet-health.yml`). The other half of the old answer — `devnet-deploy.yml`,
  which injected an ephemeral key at rebuild time only, wiping the disk in the process — is gone:
  it provisioned the self-hosted chain box, which was deleted in the 2026-07-19 public-chain
  cutover, and the workflow was retired with it.
- **Consider dropping public port 22** in favour of Linode's private networking or a bastion, once
  a CI path exists that does not depend on it.
