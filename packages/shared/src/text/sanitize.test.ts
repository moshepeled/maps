import { describe, expect, it } from 'vitest';

import { codePointLength, sanitizeText, truncateCodePoints } from './sanitize.js';

// Special characters are built from code points so this file itself contains no invisible characters.
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
const NUL = cp(0x00);
const BEL = cp(0x07);
const NEL = cp(0x85);
const ZWSP = cp(0x200b);
const BOM = cp(0xfeff);
const WORD_JOINER = cp(0x2060);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const LRM = cp(0x200e);
const RLM = cp(0x200f);
const EMOJI = cp(0x1f600);

describe('sanitizeText', () => {
  it('normalises to NFC', () => {
    const decomposed = `Cafe${cp(0x301)}`;
    const result = sanitizeText(decomposed, { maxLength: 10 });
    expect(result).toEqual({ ok: true, value: `Caf${cp(0xe9)}` });
  });

  it('strips C0/C1 controls and turns tabs into spaces', () => {
    expect(sanitizeText(`a${NUL}b${BEL}c${NEL}d\te`, { maxLength: 20 })).toEqual({
      ok: true,
      value: 'abcd e',
    });
  });

  it('strips zero-width and bidi override/isolate controls but keeps LRM and RLM', () => {
    const input = `${ZWSP}Rabin${BOM} ${RLO}Square${WORD_JOINER}${LRI}x${PDI} ${LRM}שלום${RLM}`;
    expect(sanitizeText(input, { maxLength: 50 })).toEqual({
      ok: true,
      value: `Rabin Squarex ${LRM}שלום${RLM}`,
    });
  });

  it('collapses whitespace and trims single-line text, turning line breaks into spaces', () => {
    expect(sanitizeText('  Rabin \n\r\n  Square  ', { maxLength: 50 })).toEqual({
      ok: true,
      value: 'Rabin Square',
    });
  });

  it('keeps line feeds in multiline text (CRLF and CR normalised) and collapses spaces within lines', () => {
    expect(sanitizeText('line  one  \r\nline\ttwo\rthree', { maxLength: 50, multiline: true })).toEqual({
      ok: true,
      value: 'line one\nline two\nthree',
    });
  });

  it('keeps markup characters: safety comes from output encoding', () => {
    const payload = '<img src=x onerror=window.__xss=1> & "q"';
    expect(sanitizeText(payload, { maxLength: 100 })).toEqual({ ok: true, value: payload });
  });

  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength(EMOJI)).toBe(1);
    expect(sanitizeText(`${EMOJI}${EMOJI}`, { maxLength: 2 })).toEqual({
      ok: true,
      value: `${EMOJI}${EMOJI}`,
    });
    expect(sanitizeText(`${EMOJI}${EMOJI}${EMOJI}`, { maxLength: 2 })).toEqual({
      ok: false,
      reason: 'too_long',
      length: 3,
      maxLength: 2,
    });
  });

  it('rejects empty results unless allowed', () => {
    expect(sanitizeText(` ${ZWSP} `, { maxLength: 10 })).toMatchObject({ ok: false, reason: 'empty' });
    expect(sanitizeText('   ', { maxLength: 10, allowEmpty: true })).toEqual({ ok: true, value: '' });
  });

  it('truncates instead of failing in truncate mode (a 600-char User-Agent becomes 512)', () => {
    const userAgent = 'Mozilla/5.0 '.repeat(50);
    const result = sanitizeText(userAgent, { maxLength: 512, truncate: true });
    expect(result.ok).toBe(true);
    expect(result.ok && codePointLength(result.value)).toBeLessThanOrEqual(512);
    expect(truncateCodePoints(`${EMOJI}ab`, 2)).toBe(`${EMOJI}a`);
    expect(truncateCodePoints('abc', 5)).toBe('abc');
  });
});
