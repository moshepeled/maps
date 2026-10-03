/**
 * Runtime configuration from `GET /api/v1/config` (SPEC section 6.4): limits, rate limits and realtime timings. Until it
 * loads, the shared constants are the fallback (UX section 11 "config" rows).
 */
import type { ConfigResponse } from '@snapland/shared';
import { LIMITS, REALTIME } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import type { DrawingLimits } from './drawingReducer';

export interface RuntimeConfigState {
  config: ConfigResponse | null;
  setConfig(config: ConfigResponse): void;
}

export function createRuntimeConfigStore() {
  return createStore<RuntimeConfigState>()((set) => ({
    config: null,
    setConfig: (config) => {
      set({ config });
    },
  }));
}

export type RuntimeConfigStoreApi = ReturnType<typeof createRuntimeConfigStore>;

export function drawingLimits(config: ConfigResponse | null): DrawingLimits {
  const limits = config?.limits;
  return {
    maxPoints: (limits?.maxPositions ?? LIMITS.maxPositionsTotal) - 1,
    maxAreaKm2: limits?.maxAreaKm2 ?? LIMITS.maxAreaKm2,
    minAreaKm2: limits?.minAreaKm2 ?? LIMITS.minAreaKm2,
    maxExtentDeg: limits?.maxExtentDeg ?? LIMITS.maxExtentDeg,
  };
}

export function nameMaxLength(config: ConfigResponse | null): number {
  return config?.limits.nameMaxLength ?? LIMITS.nameMaxLength;
}

export function descriptionMaxLength(config: ConfigResponse | null): number {
  return config?.limits.descriptionMaxLength ?? LIMITS.descriptionMaxLength;
}

export function bboxMaxSpanPx(config: ConfigResponse | null): number {
  return config?.limits.bboxMaxSpanPx ?? LIMITS.bboxMaxSpanPx;
}

export function draftTouchIntervalMs(config: ConfigResponse | null): number {
  return config?.realtime.draftTouchIntervalMs ?? REALTIME.draftTouchIntervalMs;
}

export function draftUpdateIntervalMs(config: ConfigResponse | null): number {
  return config?.realtime.draftUpdateMinIntervalMs ?? REALTIME.draftUpdateMinIntervalMs;
}
