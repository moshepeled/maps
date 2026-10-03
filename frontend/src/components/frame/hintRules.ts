/**
 * Which key hints the options bar and the status bar show (UX C-05, C-29, section 9.15), as pure functions. Hints are text,
 * never controls. Letter and `?` hints disappear while single-key shortcuts are off (WCAG 2.1.4, C-23); `Esc`,
 * `Enter`, `Backspace`, `Del`, `F2`, brackets and modifier hints stay, because those keys keep working.
 */
import { base } from '../../base/en';
import type { Mode } from '../../state/workspaceStore';

export interface KeyHint {
  chip: string;
  label: string;
  /**
   * Shown only at >= 1,200 px (the narrow options bar keeps E, F2 and Esc; the narrow status bar keeps only `?`).
   * Hidden by CSS, so the set of hints never depends on the width in JS.
   */
  wide?: boolean;
}

type HintCopy = (typeof base.keys)[keyof typeof base.keys];

/** Keys that stop working while single-key shortcuts are off: letters and `?`. */
function isSingleKey(chip: string): boolean {
  return /^[A-Z?]$/u.test(chip);
}

function pick(hints: readonly (HintCopy & { wide?: boolean })[], singleKeys: boolean): KeyHint[] {
  return hints
    .filter((hint) => singleKeys || !isSingleKey(hint.chip))
    .map(({ chip, label, wide }) => (wide === true ? { chip, label, wide } : { chip, label }));
}

// -- options bar (C-05) ---------------------------------------------------------------------

export function browseHints(singleKeys: boolean): KeyHint[] {
  return pick([base.keys.draw, base.keys.areas, base.keys.layer], singleKeys);
}

export interface SelectedHintInput {
  singleKeys: boolean;
  /** Locked by someone else: `E` reads *Edit anyway* (F-10). */
  lockedByOther: boolean;
  /** An area with holes cannot be reshaped: no `E` hint. */
  holes: boolean;
}

/** AreaSelected: `E`, `F2`, `H`, `Z`, and `Esc` *Deselect* at the right (the actions live in the Selection section). */
export function selectedHints(input: SelectedHintInput): { main: KeyHint[]; trailing: KeyHint[] } {
  const edit = input.holes ? [] : [input.lockedByOther ? base.keys.editAnyway : base.keys.editShape];
  return {
    main: pick(
      [...edit, base.keys.rename, { ...base.keys.history, wide: true }, { ...base.keys.zoomTo, wide: true }],
      input.singleKeys,
    ),
    trailing: pick([base.keys.deselect], input.singleKeys),
  };
}

// -- status bar (C-29) ----------------------------------------------------------------------

/** `status-key-hints[data-context]`. */
export type StatusHintContext =
  'browse' | 'selected' | 'drawing' | 'drawing-keyboard' | 'naming' | 'editing' | 'preview';

export function statusHintContext(mode: Mode, drawingViaKeyboard: boolean): StatusHintContext {
  switch (mode) {
    case 'browse':
      return 'browse';
    case 'area-selected':
    case 'resolving-conflict':
      return 'selected';
    case 'drawing':
      return drawingViaKeyboard ? 'drawing-keyboard' : 'drawing';
    case 'naming':
    case 'saving-new':
      return 'naming';
    case 'editing-shape':
    case 'saving-edit':
      return 'editing';
    case 'previewing-version':
      return 'preview';
  }
}

export interface StatusHintInput {
  singleKeys: boolean;
  /** Creator or admin of the selected area: only they get the `Del` hint. */
  canDelete: boolean;
  /** EditingShape with a point selected: `Del` deletes that point. */
  pointSelected: boolean;
}

export function statusHints(context: StatusHintContext, input: StatusHintInput): KeyHint[] {
  const tail = [
    { ...base.keys.layer, wide: true },
    // `?` is the one hint the narrow status bar keeps.
    base.keys.shortcuts,
  ];
  const wide = (hint: HintCopy) => ({ ...hint, wide: true });
  switch (context) {
    case 'browse':
      return pick([wide(base.keys.draw), ...tail], input.singleKeys);
    case 'selected':
      return pick([...(input.canDelete ? [wide(base.keys.delete)] : []), ...tail], input.singleKeys);
    case 'drawing':
      return pick([wide(base.keys.undoPoint), ...tail], input.singleKeys);
    case 'drawing-keyboard':
      return pick([wide(base.keys.finePan), ...tail], input.singleKeys);
    case 'naming':
      return pick([wide(base.keys.save), wide(base.keys.backToDrawing)], input.singleKeys);
    case 'editing':
      return pick(
        [wide(base.keys.selectPoint), ...(input.pointSelected ? [wide(base.keys.deletePoint)] : []), ...tail],
        input.singleKeys,
      );
    case 'preview':
      return pick([wide(base.keys.exitPreview), ...tail], input.singleKeys);
  }
}
