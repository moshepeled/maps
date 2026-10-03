import { describe, expect, it } from 'vitest';

import { zoomBucket } from './areas-query.service.js';
import { ifNoneMatchHits, versionEtag, weakBodyEtag, xCacheValue } from './http-caching.js';

describe('HTTP validators (section 6.3, section 10.2)', () => {
  it('version and weak body ETags', () => {
    expect(versionEtag(3)).toBe('"v3"');
    expect(weakBodyEtag('{}')).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(weakBodyEtag('{}')).toBe(weakBodyEtag('{}'));
    expect(weakBodyEtag('{}')).not.toBe(weakBodyEtag('[]'));
  });

  it('If-None-Match uses the weak comparison, lists and *', () => {
    expect(ifNoneMatchHits('"v3"', '"v3"')).toBe(true);
    expect(ifNoneMatchHits('W/"v3"', '"v3"')).toBe(true);
    expect(ifNoneMatchHits('"v2", W/"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchHits('*', '"v1"')).toBe(true);
    expect(ifNoneMatchHits('"v2"', '"v3"')).toBe(false);
    expect(ifNoneMatchHits('', '"v3"')).toBe(false);
    expect(ifNoneMatchHits(undefined, '"v3"')).toBe(false);
  });

  it('X-Cache values and bbox metric zoom buckets', () => {
    expect(['hit_l1', 'hit_l2', 'miss', 'bypass'].map((outcome) => xCacheValue(outcome as 'miss'))).toEqual([
      'HIT-L1',
      'HIT-L2',
      'MISS',
      'BYPASS',
    ]);
    expect([0, 9, 10, 13, 14, 15, 16, 17, 22].map(zoomBucket)).toEqual([
      '0-9',
      '0-9',
      '10-13',
      '10-13',
      '14',
      '15-16',
      '15-16',
      '17+',
      '17+',
    ]);
  });
});
