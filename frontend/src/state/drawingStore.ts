/**
 * My new-area drawing across modes Drawing -> Naming -> SavingNew (UX F-03), independent of any Leaflet instance
 * (SPEC section 8.4 "Manage drawing state across layer switches"). The geometry transitions are the pure functions of
 * `drawingReducer.ts`; this store adds the naming form, the save status and the Undo snapshot of a cancel.
 */
import type { Position } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import type { SharingStatus } from '../realtime/draftSession';
import type { DrawingState } from './drawingReducer';
import { EMPTY_DRAWING } from './drawingReducer';

export interface NamingForm {
  name: string;
  description: string;
  descriptionOpen: boolean;
  nameError: string | null;
  descriptionError: string | null;
}

export type SaveStatus =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'countdown'; until: number } | { kind: 'failed' };

export interface ServerInvalid {
  code: string;
  location: Position | null;
}

export interface DrawingStoreState {
  drawing: DrawingState;
  /** The finished closed ring while Naming / SavingNew. */
  finishedRing: Position[] | null;
  naming: NamingForm;
  save: SaveStatus;
  serverInvalid: ServerInvalid | null;
  sharing: SharingStatus;
  /** Set when the drawing was entered from the keyboard (hint copy, reticle). */
  viaKeyboard: boolean;
}

export interface DrawingStore extends DrawingStoreState {
  setDrawing(drawing: DrawingState): void;
  patch(patch: Partial<DrawingStoreState>): void;
  patchNaming(patch: Partial<NamingForm>): void;
  reset(): void;
}

export const EMPTY_NAMING: NamingForm = {
  name: '',
  description: '',
  descriptionOpen: false,
  nameError: null,
  descriptionError: null,
};

const INITIAL: DrawingStoreState = {
  drawing: EMPTY_DRAWING,
  finishedRing: null,
  naming: EMPTY_NAMING,
  save: { kind: 'idle' },
  serverInvalid: null,
  sharing: { kind: 'idle' },
  viaKeyboard: false,
};

export function createDrawingStore() {
  return createStore<DrawingStore>()((set, get) => ({
    ...INITIAL,
    setDrawing: (drawing) => {
      if (drawing !== get().drawing) set({ drawing });
    },
    patch: (patch) => {
      set(patch);
    },
    patchNaming: (patch) => {
      set({ naming: { ...get().naming, ...patch } });
    },
    reset: () => {
      set({ ...INITIAL, sharing: get().sharing });
    },
  }));
}

export type DrawingStoreApi = ReturnType<typeof createDrawingStore>;
