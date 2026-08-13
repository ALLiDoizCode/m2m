// Tests for the Solana wedged-validator guards (issues #277 / #348) and the
// delivery-verification guard (issue #691).
//
// We don't hit a live validator here — assertSlotAdvancing/verifyDelivered
// take their chain reads as plain async functions, so the tests feed them
// real closures over a counter (an advancing chain / a balance that lands
// late) or a constant (a wedged chain / a balance that never arrives), with
// short probe intervals to keep the suite fast. withDeadline is exercised
// with real timers.
//
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSlotAdvancing, withDeadline, verifyDelivered } from '../src/solana.js';

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

// issue #691: the faucet reported success + a real signature for a Solana SOL
// transfer that delivered 0 lamports. verifyDelivered is the guard: it must
// not let a confirmed-but-undelivered transfer read as success, but it also
// must not falsely fail a delivery whose balance read merely lags a moment
// behind the confirmed write (the public devnet RPC is a load-balanced,
// multi-node endpoint where that lag is real).

test('verifyDelivered resolves immediately once the balance already meets the floor', async () => {
  const balance = await verifyDelivered(async () => 1_000_000, 900_000, {
    attempts: 3,
    intervalMs: 5,
  });
  assert.equal(balance, 1_000_000);
});

test('verifyDelivered tolerates a balance read that lags a couple of polls behind the write', async () => {
  // Mirrors a load-balanced RPC where the first couple of reads hit a
  // stale replica before one catches up.
  const reads = [0, 0, 1_000_000];
  const balance = await verifyDelivered(async () => reads.shift(), 1_000_000, {
    attempts: 5,
    intervalMs: 5,
  });
  assert.equal(balance, 1_000_000);
});

test('verifyDelivered throws SOL_DELIVERY_UNVERIFIED when the balance never arrives', async () => {
  await assert.rejects(
    () => verifyDelivered(async () => 0, 30_000_000, { attempts: 3, intervalMs: 5 }),
    (err) => {
      assert.equal(err.code, 'SOL_DELIVERY_UNVERIFIED');
      // Honest diagnosis: names both the observed and expected lamports, and
      // is explicit that this is being treated as a failure, not success.
      assert.match(err.message, /still 0 lamports/);
      assert.match(err.message, /30000000-lamport floor/);
      assert.match(err.message, /unverified/);
      return true;
    }
  );
});

test('verifyDelivered polls exactly `attempts` times before giving up', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      verifyDelivered(
        async () => {
          calls++;
          return 0;
        },
        1,
        { attempts: 4, intervalMs: 5 }
      ),
    { code: 'SOL_DELIVERY_UNVERIFIED' }
  );
  assert.equal(calls, 4);
});
