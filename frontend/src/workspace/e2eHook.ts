/**
 * The read-only E2E hook `window.__snapland` (SPEC section 8.6 v1.2 = UX section 12): only in builds with `VITE_E2E_HOOKS=true`,
 * never enabled by a query string. Every property is a getter over the live stores, so tests always read the current
 * state; nothing here can change it.
 */
import type { Position } from '@snapland/shared';
import { bboxesIntersect } from '@snapland/shared';

import { deriveDrawing } from '../state/drawingReducer';
import { editMetrics } from '../state/editReducer';
import { activeLock } from '../state/locksStore';
import { isDraftIdle, remoteDraftAreaKm2 } from '../state/remoteDraftsStore';
import { drawingLimits } from '../state/runtimeConfigStore';
import type { Workspace } from './Workspace';

export interface SnaplandHook {
  readonly mode: string;
  readonly selectedAreaId: string | null;
  readonly draft: {
    points: Position[];
    provisional: Position | null;
    areaKm2: number | null;
    perimeterKm: number | null;
  };
  readonly areasInView: {
    id: string;
    name: string;
    version: number;
    areaKm2: number;
    createdById: string;
    state: 'pending' | 'selected' | 'locked' | 'pulse' | 'default';
    flags: { selected: boolean; locked: boolean; pending: boolean; pulse: boolean };
  }[];
  readonly connection: { state: string; instanceId: string | null };
  readonly baseLayer: string;
  readonly remoteDrafts: {
    draftId: string;
    userId: string;
    areaId: string | null;
    points: Position[];
    cursor: Position | null;
    areaKm2: number;
    idle: boolean;
  }[];
  readonly locks: { areaId: string; userId: string; displayName: string; scope: string; expiresAt: number }[];
  readonly view: { center: { lat: number; lng: number }; zoom: number };
  project(lat: number, lng: number): { x: number; y: number } | null;
  readonly perf: { lastRegionLoad: Workspace['lastRegionLoad'] };
}

export function createE2eHook(workspace: Workspace): SnaplandHook {
  const { stores } = workspace.ctx;
  const now = (): number => workspace.ctx.scheduler.now();
  return {
    get mode() {
      return stores.workspace.getState().mode;
    },
    get selectedAreaId() {
      return stores.workspace.getState().selectedAreaId;
    },
    get draft() {
      const edit = stores.edit.getState().edit;
      if (edit !== null) {
        const metrics = editMetrics(edit.points);
        return {
          points: [...edit.points],
          provisional: null,
          areaKm2: metrics.areaKm2,
          perimeterKm: metrics.perimeterKm,
        };
      }
      const drawing = stores.drawing.getState().drawing;
      const view = deriveDrawing(drawing, drawingLimits(stores.runtime.getState().config));
      const drawingMode = stores.workspace.getState().mode === 'drawing';
      return {
        points: [...drawing.points],
        provisional: drawingMode ? view.provisional : null,
        areaKm2: view.areaKm2,
        perimeterKm: view.perimeterKm,
      };
    },
    get areasInView() {
      const viewport = stores.mapView.getState().viewport;
      const selected = stores.workspace.getState().selectedAreaId;
      const effects = stores.effects.getState();
      const locks = stores.locks.getState();
      const meId = stores.auth.getState().user?.id ?? null;
      const time = now();
      const result: SnaplandHook['areasInView'] = [];
      if (viewport === null) return result;
      for (const area of stores.areas.getState().byId.values()) {
        if (effects.hidden.has(area.id) || !bboxesIntersect(area.bbox, viewport)) continue;
        const flags = {
          selected: area.id === selected,
          locked: activeLock(locks, area.id, meId, time) !== null,
          pending: effects.pending.has(area.id),
          pulse: (effects.pulses.get(area.id)?.until ?? 0) > time,
        };
        const state = flags.pending
          ? 'pending'
          : flags.selected
            ? 'selected'
            : flags.locked
              ? 'locked'
              : flags.pulse
                ? 'pulse'
                : 'default';
        result.push({
          id: area.id,
          name: area.name,
          version: area.version,
          areaKm2: area.areaKm2,
          createdById: area.createdById,
          state,
          flags,
        });
      }
      return result;
    },
    get connection() {
      const connection = stores.connection.getState();
      return { state: connection.state, instanceId: connection.instanceId };
    },
    get baseLayer() {
      return stores.mapView.getState().baseLayer;
    },
    get remoteDrafts() {
      const time = workspace.ctx.clock.getState().now;
      return [...stores.remoteDrafts.getState().drafts.values()].map((draft) => ({
        draftId: draft.draftId,
        userId: draft.user.id,
        areaId: draft.areaId,
        points: [...draft.vertices],
        cursor: draft.cursor,
        areaKm2: remoteDraftAreaKm2(draft),
        idle: isDraftIdle(draft, time),
      }));
    },
    get locks() {
      return [...stores.locks.getState().locks.values()].map((lock) => ({
        areaId: lock.areaId,
        userId: lock.holder.userId,
        displayName: lock.holder.displayName,
        scope: lock.scope,
        expiresAt: lock.expiresAt,
      }));
    },
    get view() {
      const view = stores.mapView.getState();
      return { center: { ...view.center }, zoom: view.zoom };
    },
    project(lat: number, lng: number) {
      return workspace.ctx.map()?.project([lng, lat]) ?? null;
    },
    get perf() {
      return { lastRegionLoad: workspace.lastRegionLoad === null ? null : { ...workspace.lastRegionLoad } };
    },
  };
}

declare global {
  interface Window {
    __snapland?: SnaplandHook;
  }
}

/** Installs the hook; returns the uninstall function. */
export function installE2eHook(workspace: Workspace): () => void {
  const hook = createE2eHook(workspace);
  Object.defineProperty(window, '__snapland', {
    value: Object.freeze(hook),
    configurable: true,
    writable: false,
  });
  return () => {
    Reflect.deleteProperty(window, '__snapland');
  };
}
