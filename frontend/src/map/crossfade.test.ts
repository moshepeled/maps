import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import tokensCss from '../../../docs/design/tokens.css?raw';
import { LAYER_FADE_MS, LAYER_FADE_TIMEOUT_MS, LAYER_REMOVE_CAP_MS } from '../constants/ux';
import { systemScheduler } from '../lib/scheduler';
import type { FadeLayer, FrameScheduler } from './crossfade';
import { BaseLayerCrossfade } from './crossfade';

class FakeLayer implements FadeLayer {
  opacity = 0;
  present = false;
  loaded = false;
  removedAt: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(readonly name: string) {}

  show(opacity: number): void {
    this.present = true;
    this.opacity = opacity;
    this.removedAt = null;
  }
  setOpacity(opacity: number): void {
    this.opacity = opacity;
  }
  bringToFront(): void {
    this.present = true;
  }
  remove(): void {
    this.present = false;
    this.removedAt = Date.now();
  }
  onLoad(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
    };
  }
  isLoaded(): boolean {
    return this.loaded;
  }
  fireLoad(): void {
    this.loaded = true;
    for (const listener of [...this.listeners]) listener();
  }
}

const frames: FrameScheduler = {
  request: (callback) =>
    setTimeout(() => {
      callback(Date.now());
    }, 16),
  cancel: (handle) => {
    clearTimeout(handle);
  },
};

function setup(reduced = false) {
  const midpoints: string[] = [];
  const fade = new BaseLayerCrossfade({
    scheduler: systemScheduler,
    frames,
    reducedMotion: () => reduced,
    onMidpoint: (layer) => midpoints.push((layer as FakeLayer).name),
  });
  const osm = new FakeLayer('map');
  osm.loaded = true;
  fade.initialise(osm);
  return { fade, osm, midpoints };
}

/** At least one layer fully opaque (the E2E UX-AC-44 invariant). */
function someOpaque(layers: FakeLayer[]): boolean {
  return layers.some((layer) => layer.present && layer.opacity >= 1);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('BaseLayerCrossfade (SPEC section 8.4, UI.md section 8 S9)', () => {
  it('fades in after the next layer loads and only then removes the previous one', async () => {
    const { fade, osm, midpoints } = setup();
    const aerial = new FakeLayer('aerial');
    fade.switchTo(aerial);
    expect(aerial.present).toBe(true);
    expect(aerial.opacity).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    aerial.fireLoad();
    for (let t = 0; t < LAYER_FADE_MS + 50; t += 16) {
      expect(someOpaque([osm, aerial])).toBe(true);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(aerial.opacity).toBe(1);
    expect(osm.present).toBe(false);
    expect(midpoints).toEqual(['aerial']);
    expect(fade.active).toBe(aerial);
  });

  it('starts the fade at the 1.5 s timeout but keeps the previous layer until the next one fired load', async () => {
    const { fade, osm } = setup();
    const aerial = new FakeLayer('aerial');
    fade.switchTo(aerial);
    await vi.advanceTimersByTimeAsync(LAYER_FADE_TIMEOUT_MS - 1);
    expect(aerial.opacity).toBe(0);
    await vi.advanceTimersByTimeAsync(LAYER_FADE_MS + 100);
    expect(aerial.opacity).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // 2.85 s: still no load
    expect(osm.present).toBe(true);
    expect(osm.opacity).toBe(1);
    aerial.fireLoad();
    expect(osm.present).toBe(false);
  });

  it('removes the previous layer at the 5 s cap when the next one never loads', async () => {
    const { fade, osm } = setup();
    const aerial = new FakeLayer('aerial');
    const startedAt = Date.now();
    fade.switchTo(aerial);
    await vi.advanceTimersByTimeAsync(LAYER_REMOVE_CAP_MS - 1);
    expect(osm.present).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(osm.present).toBe(false);
    expect((osm.removedAt ?? 0) - startedAt).toBe(LAYER_REMOVE_CAP_MS);
  });

  it('completes early on a second switch: never two fades stacked, old tiles kept until the newest layer loads', async () => {
    const { fade, osm } = setup();
    const aerial = new FakeLayer('aerial');
    const itm = new FakeLayer('govmap-itm');
    fade.switchTo(aerial);
    await vi.advanceTimersByTimeAsync(100);
    fade.switchTo(itm);
    expect(aerial.opacity).toBe(1); // the first transition jumped to its end state
    expect(itm.opacity).toBe(0);
    expect(osm.present).toBe(true);
    expect(aerial.present).toBe(true);
    itm.fireLoad();
    await vi.advanceTimersByTimeAsync(LAYER_FADE_MS + 50);
    expect(itm.opacity).toBe(1);
    expect(osm.present).toBe(false);
    expect(aerial.present).toBe(false);
  });

  it('switching back to a layer still underneath brings it forward at once', async () => {
    const { fade, osm } = setup();
    const aerial = new FakeLayer('aerial');
    fade.switchTo(aerial);
    await vi.advanceTimersByTimeAsync(100);
    fade.switchTo(osm);
    expect(osm.opacity).toBe(1);
    expect(aerial.present).toBe(false);
    expect(fade.active).toBe(osm);
  });

  it('reduced motion: instant swap, but removal still waits for load', async () => {
    const { fade, osm } = setup(true);
    const aerial = new FakeLayer('aerial');
    fade.switchTo(aerial);
    await vi.advanceTimersByTimeAsync(LAYER_FADE_TIMEOUT_MS);
    expect(aerial.opacity).toBe(1);
    expect(osm.present).toBe(true);
    aerial.fireLoad();
    expect(osm.present).toBe(false);
    fade.dispose();
    expect(aerial.present).toBe(false);
  });
});

describe('tokens.css (UI.md section 8 parity, single source)', () => {
  it('--duration-layer-fade / -timeout / -remove-cap mirror the SPEC constants', () => {
    const read = (name: string): number => Number(new RegExp(`--${name}:\\s*(\\d+)ms`).exec(tokensCss)?.[1]);
    expect(read('duration-layer-fade')).toBe(LAYER_FADE_MS);
    expect(read('duration-layer-fade-timeout')).toBe(LAYER_FADE_TIMEOUT_MS);
    expect(read('duration-layer-remove-cap')).toBe(LAYER_REMOVE_CAP_MS);
  });
});
