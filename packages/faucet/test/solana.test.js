// Tests for the Solana wedged-validator guards (issues #277 / #348).
//
// We don't hit a live validator here — assertSlotAdvancing takes the getSlot
// probe as a plain async function, so the tests feed it real closures over a
// counter (an advancing chain) or a constant (a wedged chain), with short probe
// intervals to keep the suite fast. withDeadline is exercised with real timers.
//
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSlotAdvancing, withDeadline } from '../src/solana.js';

test('assertSlotAdvancing resolves when the slot advances between probes', async () => {
  let slot = 100;
  const next = await assertSlotAdvancing(async () => slot++, { intervalMs: 10, probes: 2 });
  assert.ok(next > 100);
});

test('assertSlotAdvancing throws VALIDATOR_STALLED when the slot is frozen', async () => {
  await assert.rejects(
    () => assertSlotAdvancing(async () => 105331, { intervalMs: 10, probes: 2 }),
    (err) => {
      assert.equal(err.code, 'VALIDATOR_STALLED');
      // The honest diagnosis: name the frozen slot and the upstream cause.
      assert.match(err.message, /not producing blocks/);
      assert.match(err.message, /105331/);
      return true;
    }
  );
});

test('assertSlotAdvancing tolerates one stalled probe if a later one advances', async () => {
  // First probe sees the same slot, second sees progress — a slow-but-live
  // chain must NOT be declared stalled.
  const reads = [200, 200, 201];
  const next = await assertSlotAdvancing(async () => reads.shift(), { intervalMs: 10, probes: 2 });
  assert.equal(next, 201);
});

test('withDeadline passes through a promise that beats the deadline', async () => {
  const value = await withDeadline(Promise.resolve('ok'), 1000, 'test op');
  assert.equal(value, 'ok');
});

test('withDeadline rejects VALIDATOR_STALLED when the deadline fires', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withDeadline(never, 20, 'Solana drip'),
    (err) => {
      assert.equal(err.code, 'VALIDATOR_STALLED');
      assert.match(err.message, /Solana drip/);
      assert.match(err.message, /stalled mid-drip/);
      return true;
    }
  );
});

test('withDeadline propagates the underlying rejection, not a timeout', async () => {
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error('boom')), 1000, 'test op'),
    /boom/
  );
});
