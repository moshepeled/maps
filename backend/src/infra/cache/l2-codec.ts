/**
 * Encoding of bbox response bodies for the L2 cache on `redis-cache` (SPEC section 10.2 step 4). Coordinate JSON compresses
 * 5-8x, so bodies are stored gzip-compressed (zlib level 1: the cheapest level, still most of the ratio) and only when
 * the COMPRESSED size fits `CACHE_L2_MAX_BODY_BYTES` (512 KiB) - which lets realistic 1.1-1.4 MiB pages reach L2.
 * Both directions run on the libuv thread pool (async zlib), never blocking the event loop.
 */
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** zlib level 1: fastest compression (section 10.2). */
export const L2_GZIP_LEVEL = 1;

/**
 * Upper bound of a decoded body. L2 is a shared, externally reachable store: a corrupted or planted value must not
 * be able to inflate into an unbounded string. Real bodies stay under the page position budget (~ 3.6 MB).
 */
export const L2_MAX_DECODED_BYTES = 32 * 1024 * 1024;

/**
 * Gzips a body for L2. Resolves null when the compressed form exceeds `maxCompressedBytes`: such a body is served and
 * may live in L1, but is never written to L2.
 */
export async function encodeL2Body(body: string, maxCompressedBytes: number): Promise<Buffer | null> {
  const compressed = await gzipAsync(Buffer.from(body, 'utf8'), { level: L2_GZIP_LEVEL });
  return compressed.byteLength <= maxCompressedBytes ? compressed : null;
}

/** Gunzips an L2 value back into the serialized body. Rejects on corrupt input or an oversized result. */
export async function decodeL2Body(
  value: Buffer,
  maxDecodedBytes: number = L2_MAX_DECODED_BYTES,
): Promise<string> {
  // The default finish flush makes a truncated value an error instead of a silently shortened body.
  const decoded = await gunzipAsync(value, { maxOutputLength: maxDecodedBytes });
  return decoded.toString('utf8');
}
