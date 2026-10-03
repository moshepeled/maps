/**
 * Base-layer cross-fade (SPEC section 8.4, UI.md section 8 S9, UX section 7): the incoming layer is added at opacity 0 above the outgoing
 * one; it fades in (250 ms, ease-out, rAF) once it fired `load` or after 1.5 s; the outgoing layer stays underneath at
 * full opacity and is removed only after the incoming layer's `load` - capped 5 s after the switch began - so there is
 * never a frame without an opaque layer. A second switch completes the running one early (latest choice wins, never
 * two fades stacked). With reduced motion the swap is instant, but removal still waits for `load`.
 *
 * `FadeLayer` abstracts a Leaflet tile layer or layer group (same-CRS switch) and a whole stacked map container
 * (cross-CRS switch), so both paths share this one implementation and its tests.
 */
import { LAYER_FADE_MS, LAYER_FADE_TIMEOUT_MS, LAYER_REMOVE_CAP_MS } from '../constants/ux';
import type { Scheduler } from '../lib/scheduler';
import { Timer } from '../lib/scheduler';

export interface FadeLayer {
  /** Adds the layer (on top of everything present) at the given opacity. */
  show(opacity: number): void;
  setOpacity(opacity: number): void;
  /** Raises an already present layer above the others. */
  bringToFront(): void;
  remove(): void;
  /** Subscribes to the layer's `load`; returns an unsubscribe function. */
  onLoad(callback: () => void): () => void;
  /** True when every tile covering the view has loaded. */
  isLoaded(): boolean;
}

export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
}

export interface CrossfadeDeps {
  scheduler: Scheduler;
  frames: FrameScheduler;
  reducedMotion(): boolean;
  /** Called when the visual midpoint of a fade is reached (overlay styling swaps, UI.md section 8). */
  onMidpoint?(layer: FadeLayer): void;
}

/** ease-out cubic, the `--ease-enter` feel. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

interface Transition {
  next: FadeLayer;
  startedAt: number;
  loaded: boolean;
  fadeDone: boolean;
  fadeStarted: boolean;
  unsubscribe: () => void;
  fadeTimeout: Timer;
  removeCap: Timer;
  frame: number | null;
}

export class BaseLayerCrossfade {
  private current: FadeLayer | null = null;
  /** Layers still present underneath (outgoing), removed when the running transition may drop them. */
  private outgoing: FadeLayer[] = [];
  private transition: Transition | null = null;

  constructor(private readonly deps: CrossfadeDeps) {}

  get active(): FadeLayer | null {
    return this.current;
  }

  /** Shows the very first base layer without any transition. */
  initialise(layer: FadeLayer): void {
    this.current = layer;
    layer.show(1);
  }

  switchTo(next: FadeLayer): void {
    if (next === this.current && this.transition === null) return;
    this.completeEarly();
    const previous = this.current;
    // Switching back to a layer that is still underneath (e.g. Map -> Aerial -> Map before Aerial loaded): it is already
    // opaque, so it simply comes to the front - fading it from 0 would flash whatever is below.
    const alreadyPresent = previous === next || this.outgoing.includes(next);
    if (previous !== null && previous !== next) this.outgoing.push(previous);
    this.outgoing = this.outgoing.filter((layer) => layer !== next);
    this.current = next;

    if (alreadyPresent) {
      next.bringToFront();
      next.setOpacity(1);
    } else {
      next.show(0);
    }
    const transition: Transition = {
      next,
      startedAt: this.deps.scheduler.now(),
      loaded: next.isLoaded(),
      fadeDone: alreadyPresent,
      fadeStarted: alreadyPresent,
      unsubscribe: () => undefined,
      fadeTimeout: new Timer(this.deps.scheduler, () => {
        this.startFade(transition);
      }),
      removeCap: new Timer(this.deps.scheduler, () => {
        transition.loaded = true;
        this.maybeFinish(transition);
      }),
      frame: null,
    };
    this.transition = transition;
    transition.unsubscribe = next.onLoad(() => {
      transition.loaded = true;
      this.startFade(transition);
      this.maybeFinish(transition);
    });
    transition.removeCap.arm(LAYER_REMOVE_CAP_MS);
    if (alreadyPresent) {
      this.deps.onMidpoint?.(next);
      this.maybeFinish(transition);
    } else if (transition.loaded) {
      this.startFade(transition);
    } else {
      transition.fadeTimeout.arm(LAYER_FADE_TIMEOUT_MS);
    }
  }

  /** Destroys everything (map teardown). */
  dispose(): void {
    this.completeEarly();
    for (const layer of this.outgoing) layer.remove();
    this.outgoing = [];
    this.current?.remove();
    this.current = null;
  }

  private startFade(transition: Transition): void {
    if (transition !== this.transition || transition.fadeStarted) return;
    transition.fadeStarted = true;
    transition.fadeTimeout.cancel();
    if (this.deps.reducedMotion()) {
      transition.next.setOpacity(1);
      this.deps.onMidpoint?.(transition.next);
      transition.fadeDone = true;
      this.maybeFinish(transition);
      return;
    }
    const fadeStart = this.deps.scheduler.now();
    let midpointSent = false;
    const step = (): void => {
      if (transition !== this.transition) return;
      const t = Math.min(1, (this.deps.scheduler.now() - fadeStart) / LAYER_FADE_MS);
      transition.next.setOpacity(easeOut(t));
      if (!midpointSent && t >= 0.5) {
        midpointSent = true;
        this.deps.onMidpoint?.(transition.next);
      }
      if (t >= 1) {
        transition.frame = null;
        transition.fadeDone = true;
        this.maybeFinish(transition);
        return;
      }
      transition.frame = this.deps.frames.request(step);
    };
    transition.frame = this.deps.frames.request(step);
  }

  /** The outgoing layers go only when the incoming one is opaque AND has loaded (or the 5 s cap passed). */
  private maybeFinish(transition: Transition): void {
    if (transition !== this.transition) return;
    if (!transition.loaded) return;
    if (!transition.fadeDone) {
      // The cap fired before the fade even started (e.g. no load and a very slow timeout): fade now.
      if (!transition.fadeStarted) this.startFade(transition);
      return;
    }
    this.dropOutgoing();
    this.endTransition(transition);
  }

  /**
   * A second switch while one is running: the running fade jumps to its end (opacity 1) without waiting - the
   * outgoing layers stay underneath until the NEW transition may remove them, so no grey frame appears.
   */
  private completeEarly(): void {
    const transition = this.transition;
    if (transition === null) return;
    if (transition.frame !== null) this.deps.frames.cancel(transition.frame);
    transition.next.setOpacity(1);
    if (!transition.fadeStarted) this.deps.onMidpoint?.(transition.next);
    this.endTransition(transition);
  }

  private dropOutgoing(): void {
    for (const layer of this.outgoing) {
      layer.remove();
      layer.setOpacity(1);
    }
    this.outgoing = [];
  }

  private endTransition(transition: Transition): void {
    transition.unsubscribe();
    transition.fadeTimeout.cancel();
    transition.removeCap.cancel();
    if (transition.frame !== null) this.deps.frames.cancel(transition.frame);
    transition.frame = null;
    if (this.transition === transition) this.transition = null;
  }
}

/** The browser frame scheduler (tests inject a timer-driven one). */
export const browserFrames: FrameScheduler = {
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (handle) => {
    globalThis.cancelAnimationFrame(handle);
  },
};

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
