/** Key hints of the options bar and status bar (UX C-05, C-29; UX-AC-117, UX-AC-120). */
import { describe, expect, it } from 'vitest';

import { browseHints, selectedHints, statusHintContext, statusHints } from './hintRules';

const chips = (hints: readonly { chip: string }[]) => hints.map((hint) => hint.chip);

describe('options-bar hints', () => {
  it('Browse: D, A, L - and nothing while single-key shortcuts are off', () => {
    expect(chips(browseHints(true))).toEqual(['D', 'A', 'L']);
    expect(browseHints(false)).toEqual([]);
  });

  it('AreaSelected: E, F2, H, Z and Esc; Edit anyway under a lock; no E for an area with holes', () => {
    const plain = selectedHints({ singleKeys: true, lockedByOther: false, holes: false });
    expect(chips(plain.main)).toEqual(['E', 'F2', 'H', 'Z']);
    expect(plain.main[0]?.label).toBe('Edit shape');
    expect(chips(plain.trailing)).toEqual(['Esc']);
    // Narrow bars keep E, F2 and Esc: H and Z are the wide-only ones.
    expect(plain.main.filter((hint) => hint.wide === true).map((hint) => hint.chip)).toEqual(['H', 'Z']);
    expect(selectedHints({ singleKeys: true, lockedByOther: true, holes: false }).main[0]?.label).toBe(
      'Edit anyway',
    );
    expect(chips(selectedHints({ singleKeys: true, lockedByOther: false, holes: true }).main)).toEqual([
      'F2',
      'H',
      'Z',
    ]);
  });

  it('with single-key shortcuts off only F2 and Esc remain', () => {
    const off = selectedHints({ singleKeys: false, lockedByOther: false, holes: false });
    expect(chips(off.main)).toEqual(['F2']);
    expect(chips(off.trailing)).toEqual(['Esc']);
  });
});

describe('status-bar hints', () => {
  const input = { singleKeys: true, canDelete: false, pointSelected: false };

  it('maps modes to data-context, telling keyboard drawing apart', () => {
    expect(statusHintContext('browse', false)).toBe('browse');
    expect(statusHintContext('area-selected', false)).toBe('selected');
    expect(statusHintContext('drawing', false)).toBe('drawing');
    expect(statusHintContext('drawing', true)).toBe('drawing-keyboard');
    expect(statusHintContext('naming', false)).toBe('naming');
    expect(statusHintContext('saving-new', true)).toBe('naming');
    expect(statusHintContext('editing-shape', false)).toBe('editing');
    expect(statusHintContext('previewing-version', false)).toBe('preview');
  });

  it('shows the C-29 table per context', () => {
    expect(chips(statusHints('browse', input))).toEqual(['D', 'L', '?']);
    expect(chips(statusHints('selected', input))).toEqual(['L', '?']);
    expect(chips(statusHints('selected', { ...input, canDelete: true }))).toEqual(['Del', 'L', '?']);
    expect(chips(statusHints('drawing', input))).toEqual(['Backspace', 'L', '?']);
    expect(chips(statusHints('drawing-keyboard', input))).toEqual(['⇧ Arrows', 'L', '?']);
    expect(chips(statusHints('naming', input))).toEqual(['Ctrl S', 'Esc']);
    expect(chips(statusHints('editing', input))).toEqual(['] [', 'L', '?']);
    expect(chips(statusHints('editing', { ...input, pointSelected: true }))).toEqual([
      '] [',
      'Del',
      'L',
      '?',
    ]);
    expect(chips(statusHints('preview', input))).toEqual(['Esc', 'L', '?']);
  });

  it('UX-AC-120 with single-key shortcuts off the letter and ? hints go; Backspace and Del stay', () => {
    const off = { ...input, singleKeys: false, canDelete: true };
    expect(chips(statusHints('browse', off))).toEqual([]);
    expect(chips(statusHints('drawing', off))).toEqual(['Backspace']);
    expect(chips(statusHints('selected', off))).toEqual(['Del']);
  });

  it('below 1,200 px only ? stays (every other hint is wide-only)', () => {
    const narrow = statusHints('drawing', input).filter((hint) => hint.wide !== true);
    expect(chips(narrow)).toEqual(['?']);
  });
});
