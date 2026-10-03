/**
 * Text sanitisation for user-provided names, display names and descriptions (SPEC section 10.7.1), applied identically on
 * the client (live feedback) and the server (authoritative). It normalises and strips invisible/control characters;
 * it deliberately keeps `<`, `>`, `&` and quotes, because safety comes from output encoding at every sink.
 */

export interface SanitizeOptions {
  /** Maximum length in Unicode code points (matches PostgreSQL `char_length`). */
  maxLength: number;
  /** Keep line breaks (descriptions). Single-line text collapses every whitespace run to one space. */
  multiline?: boolean;
  /** Cut to `maxLength` instead of failing (request metadata such as the User-Agent is never rejected). */
  truncate?: boolean;
  /** Accept an empty result (optional descriptions). */
  allowEmpty?: boolean;
}

export type SanitizeFailure = 'empty' | 'too_long';

export type SanitizeResult =
  { ok: true; value: string } | { ok: false; reason: SanitizeFailure; length: number; maxLength: number };

/**
 * Characters that are removed. Written as escapes so this file contains no invisible character itself (the Trojan
 * Source problem it guards against):
 * - C0 controls, DEL and C1 controls, except TAB, LF and CR (handled explicitly);
 * - zero-width characters (U+200B-U+200D, U+2060) and the byte-order mark (U+FEFF);
 * - bidi embedding/override (U+202A-U+202E) and isolate (U+2066-U+2069) controls. LRM/RLM (U+200E/U+200F) are kept:
 *   they are legitimate in Hebrew text.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g;

/** Number of Unicode code points (what PostgreSQL `char_length` counts), not UTF-16 units. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Cuts a string to at most `max` code points without splitting a surrogate pair. */
export function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
}

/**
 * NFC -> (multiline) CRLF and CR become LF -> strip invisible characters -> TAB becomes a space -> collapse whitespace
 * (per line when multiline; otherwise every run, line breaks included, becomes one space) -> trim -> length check in
 * code points.
 */
export function sanitizeText(input: string, options: SanitizeOptions): SanitizeResult {
  const multiline = options.multiline === true;
  let text = input.normalize('NFC');
  if (multiline) text = text.replace(/\r\n?/g, '\n');
  text = text.replace(INVISIBLE, '').replaceAll('\t', ' ');
  text = multiline
    ? text
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trimEnd())
        .join('\n')
    : text.replace(/\s+/g, ' ');
  text = text.trim();

  const length = codePointLength(text);
  if (length === 0 && options.allowEmpty !== true) {
    return { ok: false, reason: 'empty', length, maxLength: options.maxLength };
  }
  if (length > options.maxLength) {
    if (options.truncate === true)
      return { ok: true, value: truncateCodePoints(text, options.maxLength).trimEnd() };
    return { ok: false, reason: 'too_long', length, maxLength: options.maxLength };
  }
  return { ok: true, value: text };
}
