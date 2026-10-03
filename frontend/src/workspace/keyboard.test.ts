import { describe, expect, it } from 'vitest';

import type { KeyContext, KeyInput, MapKeyContext } from './keyboard';
import { isTypingTarget, resolveGlobalKey, resolveMapKey } from './keyboard';

function key(key: string, modifiers: Partial<KeyInput> = {}): KeyInput {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

const BROWSE: KeyContext = {
  mode: 'browse',
  typing: false,
  modal: false,
  singleKeys: true,
  mapFocused: false,
  popoverOpen: false,
  panelOpen: false,
  detailsEditing: false,
};

const MAP: MapKeyContext = {
  mode: 'browse',
  pointSelected: false,
  panPx: 80,
  finePanPx: 10,
  movePx: 10,
  fineMovePx: 1,
};

describe('resolveGlobalKey (UX section 8.1)', () => {
  it('single keys: D draw, L layer, A areas, P presence, ? shortcuts', () => {
    expect(resolveGlobalKey(key('d'), BROWSE)).toBe('draw');
    expect(resolveGlobalKey(key('D', { shiftKey: true }), BROWSE)).toBe('draw');
    expect(resolveGlobalKey(key('l'), BROWSE)).toBe('toggle-layer');
    expect(resolveGlobalKey(key('a'), BROWSE)).toBe('areas');
    expect(resolveGlobalKey(key('p'), BROWSE)).toBe('presence');
    expect(resolveGlobalKey(key('?', { shiftKey: true }), BROWSE)).toBe('shortcuts');
  });

  it('area keys only with an area selected: E, H, Z, F2, Delete', () => {
    const selected: KeyContext = { ...BROWSE, mode: 'area-selected', panelOpen: true };
    expect(resolveGlobalKey(key('e'), BROWSE)).toBeNull();
    expect(resolveGlobalKey(key('e'), selected)).toBe('edit');
    expect(resolveGlobalKey(key('h'), selected)).toBe('history');
    expect(resolveGlobalKey(key('z'), selected)).toBe('zoom-to-area');
    expect(resolveGlobalKey(key('F2'), selected)).toBe('rename');
    expect(resolveGlobalKey(key('Delete'), selected)).toBe('delete');
    expect(resolveGlobalKey(key('Delete'), { ...selected, detailsEditing: true })).toBeNull();
    expect(resolveGlobalKey(key('m'), selected)).toBeNull();
  });

  it('UX-AC-71 single-key shortcuts off: letters do nothing, Ctrl+Z and Esc still work; typing never starts drawing', () => {
    const off: KeyContext = { ...BROWSE, singleKeys: false };
    for (const letter of ['d', 'l', 'e', 'h', 'a', 'p', '?'])
      expect(resolveGlobalKey(key(letter), off)).toBeNull();
    expect(resolveGlobalKey(key('z', { ctrlKey: true }), off)).toBe('undo');
    expect(resolveGlobalKey(key('Escape'), off)).toBe('escape');
    expect(resolveGlobalKey(key('d'), { ...BROWSE, typing: true })).toBeNull();
  });

  it('modifier shortcuts: Ctrl/Cmd+Z undo (not in text fields), Ctrl+S / Ctrl+Enter save while naming', () => {
    expect(resolveGlobalKey(key('z', { metaKey: true }), BROWSE)).toBe('undo');
    expect(resolveGlobalKey(key('z', { ctrlKey: true }), { ...BROWSE, typing: true })).toBeNull();
    expect(resolveGlobalKey(key('s', { ctrlKey: true }), { ...BROWSE, mode: 'naming' })).toBe('save');
    expect(resolveGlobalKey(key('s', { ctrlKey: true }), { ...BROWSE, mode: 'editing-shape' })).toBe('save');
    expect(resolveGlobalKey(key('s', { ctrlKey: true }), BROWSE)).toBeNull();
    expect(resolveGlobalKey(key('Enter', { ctrlKey: true }), { ...BROWSE, mode: 'naming' })).toBe('save');
    expect(resolveGlobalKey(key('z', { ctrlKey: true, shiftKey: true }), BROWSE)).toBeNull();
  });

  it('a modal dialog swallows everything, including Esc (the dialog handles it)', () => {
    expect(resolveGlobalKey(key('Escape'), { ...BROWSE, modal: true })).toBeNull();
    expect(resolveGlobalKey(key('d'), { ...BROWSE, modal: true })).toBeNull();
  });
});

describe('resolveMapKey (UX section 8.1 map focused)', () => {
  it('arrows pan 80 px; Shift pans 10 px only while drawing or editing; +/- zoom', () => {
    expect(resolveMapKey(key('ArrowLeft'), MAP)).toEqual({ type: 'pan', dx: -80, dy: 0 });
    expect(resolveMapKey(key('ArrowDown', { shiftKey: true }), MAP)).toEqual({ type: 'pan', dx: 0, dy: 80 });
    expect(resolveMapKey(key('ArrowUp', { shiftKey: true }), { ...MAP, mode: 'drawing' })).toEqual({
      type: 'pan',
      dx: 0,
      dy: -10,
    });
    expect(resolveMapKey(key('+'), MAP)).toEqual({ type: 'zoom', delta: 1 });
    expect(resolveMapKey(key('-'), MAP)).toEqual({ type: 'zoom', delta: -1 });
    expect(resolveMapKey(key('a', { ctrlKey: true }), MAP)).toBeNull();
  });

  it('drawing: Space places at the crosshair, Enter finishes, Backspace undoes', () => {
    const drawing = { ...MAP, mode: 'drawing' as const };
    expect(resolveMapKey(key(' '), drawing)).toEqual({ type: 'place' });
    expect(resolveMapKey(key('Enter'), drawing)).toEqual({ type: 'finish' });
    expect(resolveMapKey(key('Backspace'), drawing)).toEqual({ type: 'undo' });
    expect(resolveMapKey(key('x'), drawing)).toBeNull();
  });

  it('UX-AC-36 editing: brackets cycle, arrows nudge the selected point (Shift: 1 px), Delete / I / Enter; M does nothing', () => {
    const editing = { ...MAP, mode: 'editing-shape' as const };
    const selected = { ...editing, pointSelected: true };
    expect(resolveMapKey(key(']'), editing)).toEqual({ type: 'cycle', direction: 1 });
    expect(resolveMapKey(key('['), editing)).toEqual({ type: 'cycle', direction: -1 });
    expect(resolveMapKey(key('ArrowRight'), selected)).toEqual({ type: 'nudge', dx: 10, dy: 0 });
    expect(resolveMapKey(key('ArrowUp', { shiftKey: true }), selected)).toEqual({
      type: 'nudge',
      dx: 0,
      dy: -1,
    });
    expect(resolveMapKey(key('ArrowUp'), editing)).toEqual({ type: 'pan', dx: 0, dy: -80 });
    expect(resolveMapKey(key('Delete'), selected)).toEqual({ type: 'delete-point' });
    expect(resolveMapKey(key('Delete'), editing)).toBeNull();
    expect(resolveMapKey(key('i'), selected)).toEqual({ type: 'insert-point' });
    expect(resolveMapKey(key('Enter'), editing)).toEqual({ type: 'save-edit' });
    expect(resolveMapKey(key('m'), selected)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('text inputs, textareas, selects and contenteditable are typing targets; buttons and checkboxes are not', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
