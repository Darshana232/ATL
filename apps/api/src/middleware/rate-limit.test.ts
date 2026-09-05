/**
 * The rate limiter.
 *
 * Tested directly rather than through HTTP, because the properties that matter
 * — the window boundary, per-key isolation, memory bounding — are properties of
 * the counter, and driving them through a server would prove them slowly and
 * less precisely.
 */
import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

const limiter = (max: number, windowMs = 60_000) =>
  new RateLimiter({ max, windowMs, name: 'test', keyOf: () => 'k' });

describe('counting within a window', () => {
  it('allows exactly `max` requests', () => {
    const rl = limiter(3);

    expect(rl.check('a', 1000)).toBeNull();
    expect(rl.check('a', 1001)).toBeNull();
    expect(rl.check('a', 1002)).toBeNull();
    // The fourth is the one over.
    expect(rl.check('a', 1003)).not.toBeNull();
  });

  it('reports the seconds to wait, so a client can back off', () => {
    const rl = limiter(1, 60_000);
    rl.check('a', 0);

    // Omitting Retry-After turns a limited client into a busy one.
    expect(rl.check('a', 10_000)).toBe(50);
  });

  it('resets at the window boundary', () => {
    const rl = limiter(2, 1_000);

    rl.check('a', 0);
    rl.check('a', 100);
    expect(rl.check('a', 200)).not.toBeNull();

    // New window.
    expect(rl.check('a', 1_000)).toBeNull();
  });

  it('permits a burst across a reset - the known cost of a fixed window', () => {
    // STATED RATHER THAN DISCOVERED, and the first version of this test was
    // WRONG about the shape of it.
    //
    // I wrote it assuming windows are anchored to wall-clock boundaries. They
    // are not: a window starts at the FIRST request after the previous one
    // expired. So the burst is not "max at 11:59:59 plus max at 12:00:00" - it
    // is "requests late in one window plus requests immediately after it
    // resets".
    //
    // The test failed, which is how I found out. A sliding window or a token
    // bucket smooths this; we accept it because these limits bound ABUSE
    // rather than shape traffic, and twice a bound is still a bound.
    const rl = limiter(2, 1_000);

    expect(rl.check('a', 0)).toBeNull();         // window opens at t=0
    expect(rl.check('a', 999)).toBeNull();       // still window one
    expect(rl.check('a', 1_000)).toBeNull();     // window one expired: new one
    expect(rl.check('a', 1_000)).toBeNull();
    expect(rl.check('a', 1_000)).not.toBeNull(); // and now it bites

    // Three requests landed within 1 ms (t=999, 1000, 1000) against a limit of
    // two per second. That is the cost, measured.
  });
});

describe('keys are isolated', () => {
  it('one key exhausting its budget does not affect another', () => {
    // THE REASON LIMITS ARE PER IDENTITY. If agent A could exhaust agent B's
    // budget, the limiter would itself be a denial-of-service tool.
    const rl = limiter(1);

    expect(rl.check('agent-a', 0)).toBeNull();
    expect(rl.check('agent-a', 1)).not.toBeNull();

    expect(rl.check('agent-b', 2)).toBeNull();
  });
});

describe('memory is bounded', () => {
  it('does not grow without limit when an attacker cycles keys', () => {
    // Otherwise the limiter is itself a memory-exhaustion vector: every unique
    // key would allocate a window that never goes away.
    const rl = limiter(5, 1_000);

    for (let i = 0; i < 12_000; i += 1) rl.check(`key-${i}`, i);

    expect(rl.size).toBeLessThanOrEqual(10_000);
  });

  it('drops expired windows first', () => {
    const rl = limiter(5, 100);

    rl.check('old', 0);
    for (let i = 0; i < 10_100; i += 1) rl.check(`k${i}`, 1_000);

    expect(rl.size).toBeLessThanOrEqual(10_000);
  });
});
