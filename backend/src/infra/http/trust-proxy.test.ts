import { describe, expect, it } from 'vitest';

import { toFastifyTrustProxy } from './trust-proxy.js';

describe('toFastifyTrustProxy (section 10.7.6)', () => {
  it('passes booleans and proxy-addr lists through unchanged', () => {
    expect(toFastifyTrustProxy(false)).toBe(false);
    expect(toFastifyTrustProxy(['loopback'])).toEqual(['loopback']);
  });

  it('turns a hop count into "trust the first n hops from the socket peer"', () => {
    const trust = toFastifyTrustProxy(1);
    if (typeof trust !== 'function') throw new Error('expected a function for a hop count');
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('203.0.113.9', 1)).toBe(false);
    const twoHops = toFastifyTrustProxy(2);
    if (typeof twoHops !== 'function') throw new Error('expected a function for a hop count');
    expect([0, 1, 2].map((hop) => twoHops('10.0.0.1', hop))).toEqual([true, true, false]);
  });
});
