/**
 * Copy budgets (UX section 9 "Short variants"): every `.short` string of the options-bar / phone strip fits
 * `COPY_SHORT_MAX_CHARS` of fixed text, counted on the rendered text (key chips read as their key names).
 */
import { describe, expect, it } from 'vitest';

import { COPY_SHORT_MAX_CHARS } from '../constants/ux';
import { keyTextPlain } from '../lib/text';
import { base } from './en';

describe('.short copy budgets', () => {
  it('the v2 strip variants fit 40 characters', () => {
    const shorts = [
      base.draw.hintStartKeyboardShort,
      base.draw.hintFinishShort,
      base.draw.hintFinishKeyboardShort,
      base.edit.hintShort,
      base.draw.hintStartTouch,
      base.draw.hintFinishTouch,
      base.edit.hintTouch,
      base.edit.movePointArmedTouch,
    ];
    for (const text of shorts) expect(keyTextPlain(text).length).toBeLessThanOrEqual(COPY_SHORT_MAX_CHARS);
  });

  it('renders key tokens as their names', () => {
    expect(keyTextPlain(base.draw.hintFinishKeyboardShort)).toBe('Space add point · Enter finish');
  });
});
