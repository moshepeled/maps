/**
 * HTTP validators of the areas API (SPEC section 6.3, section 10.2): `ETag: "v{version}"` for single areas and mutation responses,
 * a weak ETag over the serialised body for bbox pages, `If-None-Match` matching (weak comparison, RFC 9110 section 13.1.2)
 * and the `X-Cache` header values of the bbox cache outcomes.
 */
import { createHash } from 'node:crypto';

import type { CacheOutcome } from '../../infra/cache/types.js';

/** Strong validator of one area version. */
export function versionEtag(version: number): string {
  return `"v${version}"`;
}

/** `W/"<base64url sha1 of body>"` for bbox list pages. */
export function weakBodyEtag(body: string): string {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`;
}

function opaqueTag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

/** True when `If-None-Match` lists this validator (or `*`); the comparison ignores the weak prefix. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined || header.trim() === '') return false;
  const wanted = opaqueTag(etag);
  return header.split(',').some((candidate) => candidate.trim() === '*' || opaqueTag(candidate) === wanted);
}

const X_CACHE: Readonly<Record<CacheOutcome, string>> = {
  hit_l1: 'HIT-L1',
  hit_l2: 'HIT-L2',
  miss: 'MISS',
  bypass: 'BYPASS',
};

export function xCacheValue(outcome: CacheOutcome): string {
  return X_CACHE[outcome];
}
