/**
 * Display helpers for user-provided strings (UX section 9.14, UI.md section 10.4): grapheme-safe truncation, avatar initials and the
 * sanitised code-point length used by form counters. Graphemes are cut with `Intl.Segmenter`, so Hebrew letters with
 * niqqud, emoji and combining marks are never split.
 */
import { codePointLength, sanitizeText } from '@snapland/shared';

import { NAME_DISPLAY_MAX_GRAPHEMES, USER_DISPLAY_MAX_GRAPHEMES } from '../constants/ux';

const ELLIPSIS = '…';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** End-truncates to `max` graphemes with "..." (trailing whitespace before the ellipsis trimmed). */
export function truncateGraphemes(text: string, max: number): string {
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  return `${parts.slice(0, max).join('').trimEnd()}${ELLIPSIS}`;
}

/** `{name}` in constrained surfaces (toasts, HUD, chips, rows): 32 graphemes. */
export function displayName(name: string): string {
  return truncateGraphemes(name, NAME_DISPLAY_MAX_GRAPHEMES);
}

/** `{user}` in constrained surfaces: 20 graphemes. */
export function displayUser(user: string): string {
  return truncateGraphemes(user, USER_DISPLAY_MAX_GRAPHEMES);
}

/**
 * Initials (UI.md section 10.4): the first grapheme of each of the first two words; with one word, its first two graphemes
 * with the second in lower case ("Mo", "Da").
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const [first, second] = words;
  if (first === undefined) return '?';
  if (second !== undefined) {
    return `${graphemes(first)[0] ?? ''}${graphemes(second)[0] ?? ''}`.toUpperCase();
  }
  const letters = graphemes(first);
  return `${(letters[0] ?? '').toUpperCase()}${(letters[1] ?? '').toLowerCase()}`;
}

/**
 * The sanitised value (single line unless `multiline`), or '' when nothing survives - the server's rule for names,
 * display names and descriptions (SPEC section 10.7.1), applied before counting or sending (UX C-09).
 */
export function sanitized(value: string, multiline = false): string {
  const result = sanitizeText(value, { multiline, maxLength: Number.MAX_SAFE_INTEGER, allowEmpty: true });
  return result.ok ? result.value : '';
}

/** Length in code points after sanitising (form counters and limits count these, like PostgreSQL `char_length`). */
export function sanitizedLength(value: string, multiline = false): number {
  return codePointLength(sanitized(value, multiline));
}

/**
 * The plain text of copy with `{Key}` tokens (UX section 9.15, e.g. "{Space} add point"): what a strip's `title` and the
 * copy budgets use. The rendered chips read as their key names.
 */
export function keyTextPlain(text: string): string {
  return text.replace(/\{(\w+)\}/gu, '$1');
}
