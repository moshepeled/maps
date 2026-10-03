// QA evidence (T5 review round 1): panning away (a load starts) and back to an already-fetched view before that load
// finishes aborts the load, then returns early because the view is covered - without clearing `loading`. The progress
// bar (`map-loading`, UX-AC-05) then stays up and `empty-hint` is suppressed until some later load completes.
// Added by the qa-expert.
import type { Bbox } from '@snapland/shared';
import { LIMITS } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { beginRegion, completeRegion, createAreasStore } from '../state/areasStore';
import type { AreasSync, RegionLoadResult } from '../state/areasSync';
import type { MapLoadState, ViewportSnapshot } from './viewportSync';
import { ViewportSync } from './viewportSync';

const TEL_AVIV: ViewportSnapshot = {
  bounds: [34.7, 32.0, 34.9, 32.2],
  sizePx: { x: 1000, y: 800 },
  zoom: 12,
  centre: { lng: 34.8, lat: 32.1 },
};
const ELSEWHERE: ViewportSnapshot = {
  bounds: [2.2, 48.8, 2.4, 49.0],
  sizePx: { x: 1000, y: 800 },
  zoom: 12,
  centre: { lng: 2.3, lat: 48.9 },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QA: ViewportSync load state after returning to a covered view', () => {
  it('pan away and back before the load finishes: loading ends and no progress bar stays up', async () => {
    const store = createAreasStore();
    // Tel Aviv at z12 was already loaded (a fetched region covering its padded parts).
    const covering: Bbox = [30, 28, 40, 36];
    store
      .getState()
      .update((state) => completeRegion(beginRegion(state, { id: 1, bbox: covering, zoom: 12 }), 1, 1));
    const states: MapLoadState[] = [];
    const loadRegion = vi.fn<AreasSync['loadRegion']>(
      (_bbox, _zoom, signal) =>
        new Promise<RegionLoadResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const viewportSync = new ViewportSync({
      sync: { loadRegion, reloadViewport: () => Promise.resolve() } as unknown as AreasSync,
      store,
      scheduler: systemScheduler,
      sendViewport: () => undefined,
      onLoadState: (state) => states.push(state),
      onPerf: () => undefined,
      classifyError: (error) =>
        error instanceof DOMException && error.name === 'AbortError'
          ? { kind: 'aborted' }
          : { kind: 'error' },
      maxSpanPx: () => LIMITS.bboxMaxSpanPx,
    });

    viewportSync.onMoveEnd(ELSEWHERE);
    await vi.advanceTimersByTimeAsync(250);
    expect(loadRegion).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.loading).toBe(true);

    viewportSync.onMoveEnd(TEL_AVIV); // back to the covered view before the load finished
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadRegion).toHaveBeenCalledTimes(1); // covered: nothing to load
    expect(states.at(-1)?.loading).toBe(false);
    expect(states.at(-1)?.showProgress).toBe(false);
    viewportSync.dispose();
  });
});
