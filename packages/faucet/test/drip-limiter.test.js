// Per-address off-chain cooldown shared by every drip leg (drip-limiter.js).
// Uses an injected clock so the tests are deterministic and instant.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDripLimiter } from '../src/drip-limiter.js';

const ADDR = 'B62qqN1Pu3kF2KGmqLA8EwpqfWrnFTVZJGDSDHQuQRoVt5BCFjhNz3d';
const OTHER = 'B62qpeGPgEhz6Vbd9E11PoTzz2EZZCJjqhwALxJ2BnkdozFm2rZtmRB';

function clockAt(start) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('first claim is allowed and reserves the slot immediately', () => {
  const now = clockAt(1_000);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now });
  assert.deepEqual(limiter.claim(ADDR), { allowed: true, retryAfterMs: 0 });
  // The reservation is immediate: a concurrent second request is refused even
  // though no drip has completed yet.
  const second = limiter.claim(ADDR);
  assert.equal(second.allowed, false);
  assert.equal(second.retryAfterMs, 60_000);
});

test('a repeat claim within the cooldown reports the remaining wait', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now });
  limiter.claim(ADDR);
  now.advance(45_000);
  const res = limiter.claim(ADDR);
  assert.equal(res.allowed, false);
  assert.equal(res.retryAfterMs, 15_000);
  assert.equal(limiter.retryAfterMs(ADDR), 15_000);
});

test('the cooldown expires: the address may drip again after the window', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now });
  limiter.claim(ADDR);
  now.advance(60_000);
  assert.equal(limiter.claim(ADDR).allowed, true);
});

test('addresses cool down independently', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now });
  limiter.claim(ADDR);
  assert.equal(limiter.claim(OTHER).allowed, true);
  assert.equal(limiter.claim(ADDR).allowed, false);
});

test('release() rolls back a claim so a FAILED drip costs no cooldown', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now });
  limiter.claim(ADDR);
  limiter.release(ADDR);
  assert.equal(limiter.claim(ADDR).allowed, true);
});

test('expired entries are pruned on claim', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 1_000, now });
  limiter.claim(ADDR);
  limiter.claim(OTHER);
  assert.equal(limiter.size(), 2);
  now.advance(1_000);
  limiter.claim('B62q-someone-else');
  assert.equal(limiter.size(), 1); // only the fresh claim survives
});

test('maxEntries hard-caps the map (oldest evicted first)', () => {
  const now = clockAt(0);
  const limiter = createDripLimiter({ cooldownMs: 60_000, now, maxEntries: 2 });
  limiter.claim('a');
  limiter.claim('b');
  limiter.claim('c');
  assert.equal(limiter.size(), 2);
  // 'a' was evicted → claimable again; 'c' is still reserved.
  assert.equal(limiter.claim('a').allowed, true);
  assert.equal(limiter.claim('c').allowed, false);
});

test('rejects a nonsensical cooldown', () => {
  assert.throws(() => createDripLimiter({ cooldownMs: NaN }));
  assert.throws(() => createDripLimiter({ cooldownMs: -1 }));
});
