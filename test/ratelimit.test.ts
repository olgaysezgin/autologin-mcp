import { describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/ratelimit.ts';

describe('FailureLimiter', () => {
  it('blocks a key after max failures inside the window, then forgets them', () => {
    let now = 0;
    const limiter = new FailureLimiter(2, 1_000, () => now);
    expect(limiter.isBlocked('a')).toBe(false);
    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.isBlocked('a')).toBe(true);
    expect(limiter.isBlocked('b')).toBe(false);
    now = 1_000;
    expect(limiter.isBlocked('a')).toBe(false);
  });

  it('defaults to 3 failures per 5 minutes', () => {
    const limiter = new FailureLimiter();
    for (let i = 0; i < 3; i += 1) limiter.recordFailure('x');
    expect(limiter.isBlocked('x')).toBe(true);
  });
});
