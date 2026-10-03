import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { L2_GZIP_LEVEL, decodeL2Body, encodeL2Body } from './l2-codec.js';

/** A coordinate-heavy body shaped like a bbox page (repetitive structure, varying digits). */
function coordinateBody(items: number): string {
  const rows = [];
  for (let i = 0; i < items; i += 1) {
    const ring = Array.from({ length: 12 }, (_, v) => [
      Number((34.78 + i * 1e-4 + v * 1e-5).toFixed(7)),
      Number((32.08 + i * 1e-4 - v * 1e-5).toFixed(7)),
    ]);
    rows.push({
      id: `area-${i}`,
      name: `Area ${i} — שטח`,
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  return JSON.stringify({ items: rows, nextCursor: null });
}

describe('L2 codec (section 10.2 step 4)', () => {
  it('round-trips a body through gzip, including non-ASCII text', async () => {
    const body = coordinateBody(200);
    const encoded = await encodeL2Body(body, 10 * 1024 * 1024);
    expect(encoded).not.toBeNull();
    expect(await decodeL2Body(encoded ?? Buffer.alloc(0))).toBe(body);
  });

  it('stores a real gzip stream at level 1 that is much smaller than the raw body', async () => {
    const body = coordinateBody(500);
    const encoded = await encodeL2Body(body, 10 * 1024 * 1024);
    expect(encoded).not.toBeNull();
    const bytes = encoded ?? Buffer.alloc(0);
    // gzip magic number, and interoperable with the synchronous zlib API.
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(bytes).toString('utf8')).toBe(body);
    expect(bytes.byteLength).toBe(gzipSync(Buffer.from(body), { level: L2_GZIP_LEVEL }).byteLength);
    expect(bytes.byteLength * 3).toBeLessThan(Buffer.byteLength(body));
  });

  it('applies the cap to the COMPRESSED size (a body larger than the cap still fits)', async () => {
    const body = coordinateBody(500);
    const raw = Buffer.byteLength(body);
    const encoded = await encodeL2Body(body, Math.floor(raw / 2));
    expect(encoded).not.toBeNull();
    expect(encoded?.byteLength ?? Infinity).toBeLessThanOrEqual(raw / 2);
  });

  it('returns null when the compressed size exceeds the cap', async () => {
    const body = coordinateBody(50);
    const compressedSize = gzipSync(Buffer.from(body), { level: L2_GZIP_LEVEL }).byteLength;
    expect(await encodeL2Body(body, compressedSize - 1)).toBeNull();
    expect(await encodeL2Body(body, compressedSize)).not.toBeNull();
  });

  it('rejects corrupt and truncated values instead of returning a partial body', async () => {
    await expect(decodeL2Body(Buffer.from('not gzip at all'))).rejects.toThrow();
    const encoded = gzipSync(Buffer.from(coordinateBody(20)), { level: L2_GZIP_LEVEL });
    await expect(decodeL2Body(encoded.subarray(0, encoded.byteLength - 12))).rejects.toThrow();
  });

  it('refuses to inflate a value beyond the decoded-size bound', async () => {
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0x20), { level: 9 });
    await expect(decodeL2Body(bomb, 64 * 1024)).rejects.toThrow();
    await expect(decodeL2Body(bomb)).resolves.toHaveLength(1024 * 1024);
  });
});
