/**
 * Map instance resize handling (UX-AC-45): the ResizeObserver's initial, unchanged-size report must not invalidate the
 * map, because that replaces Leaflet's exact centre with a pixel-rounded one; a real resize still does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMapInstance, PANES } from './mapInstance';

let observed: (() => void) | null = null;
const original = globalThis.ResizeObserver;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observed = () => {
        callback([], this);
      };
    }
    observe(): void {
      // The test calls the callback itself.
    }
    unobserve(): void {
      // Not used.
    }
    disconnect(): void {
      observed = null;
    }
  };
});

afterEach(() => {
  globalThis.ResizeObserver = original;
  document.body.replaceChildren();
});

function sized(element: HTMLElement, width: number, height: number): void {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height });
}

describe('createMapInstance', () => {
  it('stacks the overlay panes (UI.md section 7), collaborators’ point dots just above their lines, below mine', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const instance = createMapInstance(host, 'mercator', [32.085, 34.785], 16);
    const z = (key: keyof typeof PANES) => Number(instance.map.getPane(PANES[key].name)?.style.zIndex);
    expect(z('remote')).toBeLessThan(z('remotePoints'));
    expect(z('remotePoints')).toBeLessThan(z('own'));
    // Nothing a collaborator draws takes a click (UX section 3.3).
    expect(instance.map.getPane(PANES.remotePoints.name)?.style.pointerEvents).toBe('none');
    instance.dispose();
  });

  it('keeps the exact centre when the observer reports an unchanged size, and follows real resizes', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const instance = createMapInstance(host, 'mercator', [32.085, 34.785], 16);
    const invalidate = vi.spyOn(instance.map, 'invalidateSize');
    expect(observed).not.toBeNull();

    observed?.();
    expect(invalidate).not.toHaveBeenCalled();
    expect(instance.map.getCenter()).toEqual({ lat: 32.085, lng: 34.785 });

    sized(instance.container, 800, 600);
    observed?.();
    expect(invalidate).toHaveBeenCalledWith({ pan: false });

    instance.dispose();
    expect(observed).toBeNull();
    expect(host.children).toHaveLength(0);
  });

  it('UX-AC-122 keeps the content in place on screen when the top edge of the map moves (the phone HUD docks)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const instance = createMapInstance(host, 'mercator', [32.085, 34.785], 16);
    const invalidate = vi.spyOn(instance.map, 'invalidateSize');
    const panBy = vi.spyOn(instance.map, 'panBy');
    // The HUD (58 px) appears above the map: the container starts 58 px lower and is 58 px shorter.
    sized(instance.container, 390, 600);
    vi.spyOn(instance.container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 58, 390, 600));
    observed?.();
    expect(invalidate).toHaveBeenCalledWith({ pan: false });
    expect(panBy).toHaveBeenCalledWith([0, 58], { animate: false });
    // A resize that keeps the top-left corner (e.g. a window resize) pans nothing.
    panBy.mockClear();
    sized(instance.container, 390, 700);
    observed?.();
    expect(panBy).not.toHaveBeenCalled();
    instance.dispose();
  });
});
