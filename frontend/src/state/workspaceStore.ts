/**
 * Workspace UI state (UX section 3.4 mode machine, section 3.5 surfaces): exactly one mode, the selection, the side panel, dialogs
 * and per-device preferences. Transition rules live in the controllers (`src/workspace/**`); this store only holds
 * the state.
 */
import type { AreaDto, AreaVersionDto, MergeField, UserRef } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import type { LocalDraft } from './localDraft';
import type { AreaSort } from './selectors';

/** `map[data-mode]` values (UX section 3.4). */
export type Mode =
  | 'browse'
  | 'drawing'
  | 'naming'
  | 'saving-new'
  | 'area-selected'
  | 'editing-shape'
  | 'saving-edit'
  | 'resolving-conflict'
  | 'previewing-version';

export type PanelView = 'none' | 'list' | 'area' | 'save' | 'conflict';

/**
 * The Studio frame's three layouts (UX section 3.2, D-4): the inspector docked at >= 1,200 px, floating over the map at
 * 600-1,199 px, and the phone frame (bottom bar + sheet) below 600 px. Written by the React layer from media queries.
 */
export type WorkspaceLayout = 'docked' | 'overlay' | 'phone';

/** The inspector's collapsible sections (UX C-28); the primary slot (Selection) is never collapsible. */
export type InspectorSection = 'history' | 'people' | 'activity';

export type DetailState =
  | { areaId: string; status: 'loading' }
  | { areaId: string; status: 'ready'; area: AreaDto }
  | { areaId: string; status: 'deleted'; area: AreaDto }
  | { areaId: string; status: 'error' }
  | { areaId: string; status: 'rate-limited'; retryAt: number };

export interface ConflictState {
  areaId: string;
  /** What I tried to save. */
  mine: { name?: string; description?: string | null; rings?: [number, number][][] };
  current: AreaDto;
  conflictingFields: MergeField[];
  serverChangedFields: MergeField[];
  /** Which flow opened it (a shape edit returns to EditingShape on "Decide later"). */
  origin: 'shape' | 'details';
  showMine: boolean;
  showTheirs: boolean;
  reviewing: boolean;
  choices: Partial<Record<MergeField, 'mine' | 'theirs'>>;
  changedAgain: boolean;
  saving: boolean;
}

export interface PreviewState {
  areaId: string;
  version: AreaVersionDto;
  restoring: boolean;
  countdownUntil: number | null;
  /** Keyboard preview moves focus to *Restore this version*; `Esc` returns it to the item. */
  viaKeyboard: boolean;
}

export interface DeletedWhileEditingState {
  areaId: string;
  name: string;
  deletedBy: UserRef | null;
  createdById: string;
  creatorName: string | null;
  /** The restore was refused (role changed): the dialog re-opens in the "anyone else" variant (UX C-20). */
  restoreForbidden: boolean;
  busy: boolean;
}

export interface HistoryState {
  areaId: string;
  status: 'loading' | 'ready' | 'error';
  items: AreaVersionDto[];
  retryAt: number | null;
}

/** Inline rename / description editing in the panel (UX F-05). */
export interface DetailsEditState {
  areaId: string;
  field: 'name' | 'description';
  /** The version the input opened on: the save's `baseVersion`, so a rival change conflicts (UX F-09). */
  baseVersion: number;
  text: string;
  error: string | null;
  saving: boolean;
  /** Rate-limited: the save is sent automatically at this time (UX F-12 step 3). */
  countdownUntil: number | null;
}

/** Where keyboard focus should move next (the React layer performs it, UX section 8.3). */
export type FocusTarget =
  | 'map'
  | 'panel-heading'
  | 'edit-shape-button'
  | 'history-current'
  | 'restore-version-button'
  | 'history-item'
  | 'list-item'
  | 'conflict-heading'
  | 'conflict-review'
  | 'name-input'
  | 'rename-input'
  | 'people-header';

export interface FocusRequest {
  target: FocusTarget;
  /** The area (list item / history version) the target refers to. */
  key?: string | number;
  seq: number;
}

/** A request to scroll a section into view (the React layer performs it, like focus requests). */
export interface RevealRequest {
  section: InspectorSection;
  seq: number;
}

export interface WorkspaceState {
  mode: Mode;
  selectedAreaId: string | null;
  panel: PanelView;
  layout: WorkspaceLayout;
  /**
   * Section states for this session (UX C-28: kept across selections and mode changes). `null` = the layout's
   * default, until the user expands or collapses the section (`sectionExpanded`).
   */
  historyExpanded: boolean | null;
  peopleExpanded: boolean | null;
  activityExpanded: boolean | null;
  /** Overlay layout: People / Activity were opened on request (`P`, *People*), so the overlay shows without a panel. */
  inspectorExtras: boolean;
  revealRequest: RevealRequest | null;
  /** How the panel was opened: its close returns focus to the list item or the map (UX section 8.3). */
  panelInvoker: 'map' | 'list' | 'keyboard';
  hoverAreaId: string | null;
  detail: DetailState | null;
  history: HistoryState | null;
  preview: PreviewState | null;
  conflict: ConflictState | null;
  deletedWhileEditing: DeletedWhileEditingState | null;
  detailsEdit: DetailsEditState | null;
  /** My unsaved rename/description text when the area was deleted meanwhile (UX C-14). */
  unsavedText: string | null;
  /** A restore in flight or counting down after a 429 ("Restoring in 23 s...", UX F-12 step 3). */
  restoring: { areaId: string; until: number | null } | null;
  /** The restore banner's draft (UX C-24). */
  localDraft: LocalDraft | null;
  focusRequest: FocusRequest | null;
  /** The phone bottom sheet (UX section 3.2). */
  sheet: 'peek' | 'expanded';
  shortcutsOpen: boolean;
  signOutConfirmOpen: boolean;
  presenceOpen: boolean;
  userMenuOpen: boolean;
  connectionPopoverOpen: boolean;
  quietMode: boolean;
  singleKeyShortcuts: boolean;
  listSort: AreaSort;
  listFilter: string;
  /** Double-click zoom stays off until this time after entering Browse / AreaSelected (UX section 3.4). */
  dblClickZoomAfter: number;
}

export interface WorkspaceStore extends WorkspaceState {
  patch(patch: Partial<WorkspaceState>): void;
  requestFocus(target: FocusTarget, key?: string | number): void;
  requestReveal(section: InspectorSection): void;
}

export const INITIAL_WORKSPACE: WorkspaceState = {
  mode: 'browse',
  selectedAreaId: null,
  panel: 'none',
  layout: 'docked',
  historyExpanded: null,
  peopleExpanded: null,
  activityExpanded: null,
  inspectorExtras: false,
  revealRequest: null,
  panelInvoker: 'map',
  hoverAreaId: null,
  detail: null,
  history: null,
  preview: null,
  conflict: null,
  deletedWhileEditing: null,
  detailsEdit: null,
  unsavedText: null,
  restoring: null,
  localDraft: null,
  focusRequest: null,
  sheet: 'peek',
  shortcutsOpen: false,
  signOutConfirmOpen: false,
  presenceOpen: false,
  userMenuOpen: false,
  connectionPopoverOpen: false,
  quietMode: false,
  singleKeyShortcuts: true,
  listSort: 'recent',
  listFilter: '',
  dblClickZoomAfter: 0,
};

export function createWorkspaceStore(initial: Partial<WorkspaceState> = {}) {
  return createStore<WorkspaceStore>()((set, get) => ({
    ...INITIAL_WORKSPACE,
    ...initial,
    patch: (patch) => {
      set(patch);
    },
    requestFocus: (target, key) => {
      set({ focusRequest: { target, key, seq: (get().focusRequest?.seq ?? 0) + 1 } });
    },
    requestReveal: (section) => {
      set({ revealRequest: { section, seq: (get().revealRequest?.seq ?? 0) + 1 } });
    },
  }));
}

export type WorkspaceStoreApi = ReturnType<typeof createWorkspaceStore>;

/** Modes in which collaboration toasts are held (UX section 6.5). */
export function isWorkingMode(mode: Mode): boolean {
  return mode === 'drawing' || mode === 'naming' || mode === 'editing-shape' || mode === 'saving-new';
}

/**
 * The empty-view hint (UX C-17) offers *Draw area*: it shows only in Browse / AreaSelected. While drawing, naming or
 * editing the hint would be noise, and its button (the `D` toggle) would cancel the drawing in progress.
 */
export function offersEmptyHint(mode: Mode): boolean {
  return mode === 'browse' || mode === 'area-selected';
}

/** Double-click zoom is off everywhere except Browse / AreaSelected (UX section 3.4 table). */
export function allowsDoubleClickZoom(mode: Mode): boolean {
  return mode === 'browse' || mode === 'area-selected';
}

/** Any modal dialog open: single-key shortcuts are off and the map ignores keys (UX section 8.1). */
export function modalOpen(
  state: Pick<WorkspaceState, 'shortcutsOpen' | 'signOutConfirmOpen' | 'deletedWhileEditing'>,
): boolean {
  return state.shortcutsOpen || state.signOutConfirmOpen || state.deletedWhileEditing !== null;
}

/**
 * Is a collapsible inspector section expanded? The user's choice for this session wins; otherwise History is expanded
 * wherever it is shown except the phone sheet (UX C-13), and People / Activity are expanded when docked and collapsed
 * in the overlay (UX C-28).
 */
export function sectionExpanded(
  state: Pick<WorkspaceState, 'layout' | 'historyExpanded' | 'peopleExpanded' | 'activityExpanded'>,
  section: InspectorSection,
): boolean {
  switch (section) {
    case 'history':
      return state.historyExpanded ?? state.layout !== 'phone';
    case 'people':
      return state.peopleExpanded ?? state.layout === 'docked';
    case 'activity':
      return state.activityExpanded ?? state.layout === 'docked';
  }
}

/** Modes in which the overlay inspector hides, so it never covers the draft, the handles or the reticle (UX C-28). */
export function hidesOverlayInspector(mode: Mode): boolean {
  return mode === 'drawing' || mode === 'editing-shape' || mode === 'saving-edit';
}

/**
 * Is the inspector shown (`inspector[data-open]`)? Docked: always. Overlay: only while it has something to show - a
 * panel, or People / Activity opened on request - and never in Drawing or EditingShape. Phones have no inspector.
 */
export function inspectorOpen(
  state: Pick<WorkspaceState, 'layout' | 'mode' | 'panel' | 'inspectorExtras'>,
): boolean {
  if (state.layout === 'docked') return true;
  if (state.layout === 'phone' || hidesOverlayInspector(state.mode)) return false;
  return state.panel !== 'none' || state.inspectorExtras;
}
