import { describe, expect, it } from 'vitest';

import { TokenBucket, WindowCounter } from './token-bucket.js';

/** Takes tokens until the bucket refuses; returns how many it got. */
function drain(bucket: TokenBucket, now: number): number {
  let taken = 0;
  while (bucket.tryTake(now)) taken += 1;
  return taken;
}

describe('TokenBucket (section 7.8: 40 burst, 20 tokens/s)', () => {
  const options = { capacity: 40, refillPerSecond: 20 };

  it('allows a burst of 40 and refuses the 41st', () => {
    const bucket = new TokenBucket(options, 0);
    expect(drain(bucket, 0)).toBe(40);
  });

  it('refills continuously at 20 tokens per second, capped at the capacity', () => {
    const bucket = new TokenBucket(options, 0);
    drain(bucket, 0);
    expect(bucket.tryTake(49)).toBe(false);
    expect(bucket.tryTake(50)).toBe(true);
    expect(drain(bucket, 1050)).toBe(20);
    expect(drain(bucket, 60_000)).toBe(40);
  });

  it('does not drain when the clock moves backwards', () => {
    const bucket = new TokenBucket(options, 1000);
    bucket.tryTake(1000);
    expect(drain(bucket, 500)).toBe(39);
  });
});

describe('WindowCounter', () => {
  it('reports true once MORE than `limit` events happened inside the window', () => {
    const counter = new WindowCounter(3, 1000);
    expect(counter.hit(0)).toBe(false);
    expect(counter.hit(10)).toBe(false);
    expect(counter.hit(20)).toBe(false);
    expect(counter.hit(30)).toBe(true);
  });

  it('forgets events older than the window', () => {
    const counter = new WindowCounter(3, 1000);
    counter.hit(0);
    counter.hit(10);
    counter.hit(20);
    expect(counter.hit(1015)).toBe(false);
    expect(counter.count(1015)).toBe(2);
    expect(counter.count(5000)).toBe(0);
  });

  it('keeps at most limit + 1 timestamps (bounded memory under a flood)', () => {
    const counter = new WindowCounter(200, 10_000);
    for (let i = 0; i < 5000; i += 1) counter.hit(i);
    expect(counter.count(5000)).toBe(201);
  });

  it('closes on the 201st throttled message within 10 s (4429 rule)', () => {
    const counter = new WindowCounter(200, 10_000);
    const verdicts = Array.from({ length: 201 }, (_, i) => counter.hit(i * 10));
    expect(verdicts.slice(0, 200).every((verdict) => !verdict)).toBe(true);
    expect(verdicts[200]).toBe(true);
  });
});
