# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
label strings used in this repo's issue tracker. This repo uses the canonical names unchanged.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label
string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## All five exist in the tracker

`needs-triage`, `needs-info`, `ready-for-agent` and `ready-for-human` were created on
2026-08-19; `wontfix` is GitHub's stock label, reused as-is. Nothing further needs creating —
just apply them.

The unused stock labels (`documentation`, `duplicate`, `good first issue`, `help wanted`,
`invalid`, `question`) were deleted at the same time; each carried zero issues, zero PRs and zero
references. `bug`, `enhancement` and `released` were kept.

## Labels these are deliberately NOT mapped to

The repo already carries an automation vocabulary that looks adjacent but means something else.
Keep them apart:

- **`agent:implement`** — a Sandcastle **trigger**: applying it makes an agent build the issue and
  open a PR. `ready-for-agent` is a _triage verdict_ ("this is specified well enough for an agent"),
  which is a precondition for `agent:implement`, not a synonym. Deciding is not dispatching.
- **`agent:review`** — a Sandcastle trigger that runs the single-pass reviewer on a PR. Not a
  triage state at all.
- **`needs:human`** — "requires human decision or clarification", which straddles `needs-info`
  (waiting on the reporter) and `ready-for-human` (specified, needs a human to build it). The two
  canonical labels split that ambiguity, so `needs:human` is left to its existing users.
- **`tracking`** — an epic split by issue-decomposer. Orthogonal to triage; an epic can carry a
  triage label too.
