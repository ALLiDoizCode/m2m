// needs:human ownership evaluator (toon-meta#352).
//
// Answers one question: WHO most recently put `needs:human` on this PR — the
// factory-ops approver, or a person? Pure logic, no I/O; the caller passes the
// timeline events in. Tests: needs-human-evaluator.test.mjs (node --test).
//
// ── WHY THIS DISTINCTION IS THE WHOLE FIX ───────────────────────────────────
// The reviewer's BLOCKING branch applies `needs:human` as a side effect
// (.sandcastle/review-verdict.ts, toon-meta#282). Nothing removed it, so a PR
// that went blocking → fixed → clean ended up APPROVED *and* labelled — and
// `auto-merge.yml` refuses on the label. Once blocked, gated forever. On
// 2026-08-12 that held three approved PRs simultaneously, one of which was the
// fix for the sibling dead-`agent:implement` wedge (#330/#333).
//
// The naive fix — "a clean verdict clears the label" — trades that bug for a
// worse one: `needs:human` is a HUMAN control point (FACTORY.md), so clearing
// it unconditionally lets a machine overrule a person who applied it
// deliberately. Hence ownership, not mere presence, decides.
//
// ── WHY THE TIMELINE AND NOT THE LABEL LIST ─────────────────────────────────
// The label list says only THAT the label is present, never WHO applied it.
// `labeled`/`unlabeled` events carry the actor, and are returned oldest-first,
// so the LAST event for this label is the live state: `labeled` means applied
// (by that actor), `unlabeled` means currently absent.
//
// ── WHY THIS LIVES IN .sandcastle/ AND NOT scripts/factory/ ─────────────────
// It is imported by `review-verdict.ts`, which EVERY factory repo carries its
// own copy of. `scripts/factory/` exists only in toon-meta, so an evaluator
// living there could never be propagated — the import would not resolve in the
// other nine repos, which is exactly the trap this file was moved out of.
// Keeping it beside its only caller means the pair travels as a unit.
//
// Its test still lives at `scripts/factory/needs-human-evaluator.test.mjs`,
// because that is the glob `npm run test:factory` runs, and imports across the
// boundary. When propagating to another repo, copy THIS file and
// `review-verdict.ts` together; the test comes only if that repo runs one.

/** The label this module reasons about. */
export const NEEDS_HUMAN_LABEL = "needs:human";

/**
 * The login that most recently applied `needs:human`, or `null` if the label
 * is not currently on the PR.
 *
 * @param {Array<{event?: string, label?: {name?: string}, actor?: {login?: string}}>} timeline
 *   Timeline events, oldest first, as GitHub returns them. Entries that are
 *   not `labeled`/`unlabeled` for this label are ignored, so the raw timeline
 *   can be passed straight in.
 * @returns {string | null}
 */
export function lastNeedsHumanApplier(timeline) {
  if (!Array.isArray(timeline)) return null;

  let applier = null;
  for (const entry of timeline) {
    if (!entry || entry.label?.name !== NEEDS_HUMAN_LABEL) continue;
    if (entry.event === "labeled") applier = entry.actor?.login ?? null;
    else if (entry.event === "unlabeled") applier = null;
  }
  return applier;
}

/**
 * Should a CLEAN verdict clear `needs:human` from this PR?
 *
 * True only when the label is currently applied AND the approver identity is
 * the one that applied it. Fails closed: an unknown or human applier keeps the
 * label. A label that should have been cleared costs a manual edit; one
 * cleared wrongly overrules a person's decision, so the asymmetry is
 * deliberate.
 *
 * @param {Array<object>} timeline Timeline events, oldest first.
 * @param {string} approverLogin The factory-ops approver identity.
 * @returns {boolean}
 */
export function shouldClearNeedsHuman(timeline, approverLogin) {
  if (!approverLogin) return false;
  const applier = lastNeedsHumanApplier(timeline);
  return applier !== null && applier === approverLogin;
}
