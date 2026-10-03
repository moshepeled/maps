import { describe, expect, it } from 'vitest';

import { isApplePlatform, platformKeys } from './platform';

describe('platform key wording (UX section 9.15)', () => {
  it('detects Apple platforms', () => {
    expect(isApplePlatform('MacIntel')).toBe(true);
    expect(isApplePlatform('iPhone')).toBe(true);
    expect(isApplePlatform('Win32')).toBe(false);
    expect(isApplePlatform('Linux x86_64')).toBe(false);
  });

  it('Ctrl reads ⌘ on Apple platforms only; other chips are unchanged', () => {
    expect(platformKeys('Ctrl S', true)).toBe('⌘ S');
    expect(platformKeys('Ctrl Z', false)).toBe('Ctrl Z');
    expect(platformKeys('Esc', true)).toBe('Esc');
  });
});
