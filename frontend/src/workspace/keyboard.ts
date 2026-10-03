/**
 * The keyboard map (UX section 8.1) as pure functions: which command a key press means in the current context. Single-key
 * shortcuts fire only outside text fields, with no modal open, and can be turned off (WCAG 2.1.4, UX C-23); modifier
 * shortcuts always work. Map-only keys (arrows, Space, Enter, brackets...) are resolved separately for the focused map.
 */
import type { Mode } from '../state/workspaceStore';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  mode: Mode;
  /** Focus is in an input, textarea, select or contenteditable. */
  typing: boolean;
  modal: boolean;
  singleKeys: boolean;
  /** Focus is on the map container. */
  mapFocused: boolean;
  /** A popover or menu is open (Esc closes it first). */
  popoverOpen: boolean;
  /** An area panel is open (Details / History / list). */
  panelOpen: boolean;
  detailsEditing: boolean;
}

export type GlobalCommand =
  | 'draw'
  | 'toggle-layer'
  | 'areas'
  | 'presence'
  | 'shortcuts'
  | 'edit'
  | 'history'
  | 'zoom-to-area'
  | 'rename'
  | 'delete'
  | 'escape'
  | 'undo'
  | 'save';

const SINGLE_KEYS: Readonly<Record<string, GlobalCommand>> = {
  d: 'draw',
  l: 'toggle-layer',
  a: 'areas',
  p: 'presence',
  '?': 'shortcuts',
  e: 'edit',
  h: 'history',
  z: 'zoom-to-area',
};

/** Commands that need a selected area (panel open, not editing). */
const AREA_COMMANDS: ReadonlySet<GlobalCommand> = new Set([
  'edit',
  'history',
  'zoom-to-area',
  'rename',
  'delete',
]);

export function resolveGlobalKey(event: KeyInput, context: KeyContext): GlobalCommand | null {
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') return context.modal ? null : 'escape';
  if (modifier && !event.altKey) {
    const lower = event.key.toLowerCase();
    if (lower === 'z' && !event.shiftKey) return context.typing ? null : 'undo';
    if (lower === 's') return context.mode === 'naming' || context.mode === 'editing-shape' ? 'save' : null;
    if (event.key === 'Enter') return context.mode === 'naming' ? 'save' : null;
    return null;
  }
  if (context.typing || context.modal) return null;
  if (event.key === 'F2') return context.mode === 'area-selected' ? 'rename' : null;
  if (event.key === 'Delete') {
    // With the map focused in EditingShape, Delete removes the selected point (map key); otherwise it deletes the area.
    return context.mode === 'area-selected' && !context.detailsEditing ? 'delete' : null;
  }
  if (!context.singleKeys || event.altKey) return null;
  const command = SINGLE_KEYS[event.key.length === 1 ? event.key.toLowerCase() : ''];
  if (command === undefined) return null;
  if (AREA_COMMANDS.has(command) && context.mode !== 'area-selected') return null;
  return command;
}

export type MapCommand =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; delta: 1 | -1 }
  | { type: 'place' }
  | { type: 'finish' }
  | { type: 'undo' }
  | { type: 'cycle'; direction: 1 | -1 }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'delete-point' }
  | { type: 'insert-point' }
  | { type: 'save-edit' };

const ARROWS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface MapKeyContext {
  mode: Mode;
  pointSelected: boolean;
  panPx: number;
  finePanPx: number;
  movePx: number;
  fineMovePx: number;
}

/** Keys handled by the focused map container (UX section 8.1 "Map focused", "Drawing", "Editing shape"). */
export function resolveMapKey(event: KeyInput, context: MapKeyContext): MapCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const arrow = ARROWS[event.key];
  const editing = context.mode === 'editing-shape';
  if (arrow !== undefined) {
    if (editing && context.pointSelected) {
      const step = event.shiftKey ? context.fineMovePx : context.movePx;
      return { type: 'nudge', dx: arrow[0] * step, dy: arrow[1] * step };
    }
    const fine = event.shiftKey && (context.mode === 'drawing' || editing);
    const step = fine ? context.finePanPx : context.panPx;
    return { type: 'pan', dx: arrow[0] * step, dy: arrow[1] * step };
  }
  if (event.key === '+' || event.key === '=') return { type: 'zoom', delta: 1 };
  if (event.key === '-' || event.key === '_') return { type: 'zoom', delta: -1 };
  if (context.mode === 'drawing') {
    if (event.key === ' ') return { type: 'place' };
    if (event.key === 'Enter') return { type: 'finish' };
    if (event.key === 'Backspace') return { type: 'undo' };
    return null;
  }
  if (editing) {
    if (event.key === ']') return { type: 'cycle', direction: 1 };
    if (event.key === '[') return { type: 'cycle', direction: -1 };
    if ((event.key === 'Delete' || event.key === 'Backspace') && context.pointSelected)
      return { type: 'delete-point' };
    if ((event.key === 'i' || event.key === 'I') && context.pointSelected) return { type: 'insert-point' };
    if (event.key === 'Enter') return { type: 'save-edit' };
  }
  return null;
}

/** Is the event target a text entry (single-key shortcuts never fire there, UX-AC-71)? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(
    type,
  );
}
