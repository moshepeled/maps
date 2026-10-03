/**
 * Vitest setup for the jsdom environment (test-only): jsdom lacks `matchMedia` and `ResizeObserver`, which the
 * responsive hooks and the map instances use. Both are replaced by inert doubles; tests that need a media query to
 * match override `window.matchMedia` themselves.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class InertResizeObserver {
    observe(): void {
      // jsdom has no layout: nothing ever resizes.
    }
    unobserve(): void {
      // See observe().
    }
    disconnect(): void {
      // See observe().
    }
  }
  globalThis.ResizeObserver = InertResizeObserver;
}

export {};
