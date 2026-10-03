/**
 * Pointer input of the map controller (UX C-06.3, C-08, C-27): touch has no hover, so the compatibility `mousemove`
 * of a tap never becomes the drawing's pointer; and leaving the map host clears the pointer even when Leaflet never
 * fires its own `mouseout` (the pointer left over an overlay canvas).
 */
import L from 'leaflet';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppServices } from '../app/services';
import { base } from '../base/en';
import { recordFromDto } from '../state/areasStore';
import { areaDto, uuid } from '../test/factories';
import { systemScheduler } from '../lib/scheduler';
import { FakeSocket } from '../test/fakeSocket';
import { signedIn } from '../test/workspaceHarness';
import { Workspace } from '../workspace/Workspace';
import type { FrameScheduler } from './crossfade';
import { MapController, phoneRevealNeeded, tooltipFlipsBelow, tooltipShift } from './MapController';

/** Animation frames that run only when the test flushes them. */
function manualFrames(): FrameScheduler & { flush(): void } {
  let queue = new Map<number, (time: number) => void>();
  let next = 1;
  return {
    request(callback) {
      next += 1;
      queue.set(next, callback);
      return next;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    flush() {
      const due = queue;
      queue = new Map();
      for (const callback of due.values()) callback(0);
    },
  };
}

let controller: MapController | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  controller?.dispose();
  controller = null;
  document.body.replaceChildren();
});

function setup(options: { reducedMotion?: boolean } = {}) {
  const reducedMotion = (): boolean => options.reducedMotion ?? true;
  const services = createAppServices({
    fetch: () => Promise.resolve(new Response('{}', { status: 404 })),
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
  services.adopt(signedIn());
  const workspace = new Workspace(services, {
    openSocket: () => new FakeSocket(),
    isOnline: () => true,
    random: () => 0.5,
    reducedMotion,
    isPhone: () => false,
    itmLayerEnabled: true,
    appVersion: 'test',
  });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  document.body.append(host);
  const frames = manualFrames();
  controller = new MapController({
    host,
    workspace,
    services,
    scheduler: systemScheduler,
    frames,
    reducedMotion,
    coarsePointer: () => false,
    isPhone: () => false,
  });
  workspace.attachMap(controller);
  const container = host.querySelector<HTMLElement>('.leaflet-container');
  if (container === null) throw new Error('no Leaflet container');
  const pointer = () => services.stores.drawing.getState().drawing.pointer;
  const moveTo = (x: number, y: number, init: MouseEventInit = {}): void => {
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, ...init }));
    frames.flush();
  };
  const pointerEvent = (type: string, pointerType: string): void => {
    host.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType }));
  };
  return { workspace, services, host, frames, pointer, moveTo, pointerEvent };
}

describe('MapController pointer input', () => {
  it('a mouse move over the map becomes the drawing pointer', () => {
    const { workspace, pointer, moveTo, pointerEvent } = setup();
    workspace.drawing.start('pointer');
    pointerEvent('pointermove', 'mouse');
    moveTo(200, 150);
    expect(pointer()).not.toBeNull();
  });

  it('the compatibility mousemove of a touch tap sets no pointer (no rubber-band, no false error)', () => {
    const { workspace, pointer, moveTo, pointerEvent } = setup();
    workspace.drawing.start('touch');
    pointerEvent('pointerdown', 'touch');
    moveTo(200, 150);
    expect(pointer()).toBeNull();
    // A mouse used again afterwards (hybrid devices) hovers without clicking first.
    pointerEvent('pointermove', 'mouse');
    moveTo(210, 150);
    expect(pointer()).not.toBeNull();
  });

  it('the reticle stops being the provisional point once keyboard focus leaves the map (C-06.3, C-06.9)', () => {
    const { workspace, host, pointer } = setup();
    workspace.drawing.start('keyboard');
    host.focus();
    // A map key (an arrow pans) makes the reticle the drawing's pointer; the flow sets it at the map centre.
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    workspace.drawing.pointer(workspace.ctx.map()?.center() ?? null);
    expect(pointer()).not.toBeNull();
    const outside = document.createElement('button');
    document.body.append(outside);
    host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
    expect(pointer()).toBeNull();
    expect(host.classList.contains('is-keyboard')).toBe(false);
  });

  it('keyboard pans move the map at once, even with motion enabled, so Space places the point where the map is (C-06.9)', () => {
    const { workspace, host } = setup({ reducedMotion: false });
    workspace.drawing.start('keyboard');
    host.focus();
    const centre = () => workspace.ctx.map()?.center() ?? null;
    const start = centre();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterOne = centre();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterThree = centre();
    if (start === null || afterOne === null || afterThree === null) throw new Error('no map centre');
    // No animation frame ran: an animated pan would not have moved the centre yet, and a second press would cut it.
    const step = afterOne[0] - start[0];
    expect(step).toBeGreaterThan(0);
    expect(afterThree[0] - start[0]).toBeCloseTo(3 * step, 9);
  });

  it('Space places the point under the settled reticle; a second Space there is ignored as a duplicate (C-06.2, C-06.9)', () => {
    const { workspace, host, services } = setup({ reducedMotion: false });
    workspace.drawing.start('keyboard');
    host.focus();
    const key = (value: string): void => {
      host.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    };
    const points = () => services.stores.drawing.getState().drawing.points;
    key(' ');
    for (let press = 0; press < 3; press += 1) key('ArrowRight');
    key(' ');
    const centre = workspace.ctx.map()?.center() ?? null;
    if (centre === null) throw new Error('no map centre');
    expect(points()).toHaveLength(2);
    expect(points()[1]?.[0]).toBeCloseTo(centre[0], 6);
    expect(points()[1]?.[1]).toBeCloseTo(centre[1], 6);
    // The reticle rests on the new point: Space again adds nothing, and 2 points speak no area yet.
    key(' ');
    expect(points()).toHaveLength(2);
    expect(services.stores.live.getState().status.text).toBe(base.sr.pointAdded(2, base.sr.areaUnknown));
  });

  it('leaving the map host clears the pointer, whatever layer the pointer left over', () => {
    const { workspace, host, pointer, moveTo, pointerEvent } = setup();
    workspace.drawing.start('pointer');
    pointerEvent('pointermove', 'mouse');
    moveTo(200, 150);
    expect(pointer()).not.toBeNull();
    host.dispatchEvent(new MouseEvent('mouseleave'));
    expect(pointer()).toBeNull();
  });
});

describe('MapController selection during a fly (UI.md section 9.4)', () => {
  it('a selection made while the map flies is drawn at moveend, never projected from the in-flight view', () => {
    // The fly itself is Leaflet's; here it only records which map flew, so the test decides when it ends.
    const flown: L.Map[] = [];
    vi.spyOn(L.Map.prototype, 'flyToBounds').mockImplementation(function (this: L.Map) {
      flown.push(this);
      return this;
    });
    const { workspace, services, host, frames } = setup({ reducedMotion: false });
    const area = recordFromDto(areaDto({ id: uuid(), west: 34.78, south: 32.08, size: 0.01 }));
    services.stores.areas.setState({ byId: new Map([[area.id, area]]) });
    // Kept off the canvas layer (jsdom has no 2D context); the selection decorations are SVG.
    services.stores.effects.getState().setHidden(area.id, true);
    workspace.ctx.map()?.flyToBbox(area.bbox);
    services.stores.workspace
      .getState()
      .patch({ mode: 'area-selected', selectedAreaId: area.id, panel: 'area' });
    frames.flush();
    expect(flown).toHaveLength(1);
    expect(host.querySelector('path.ov-selected')).toBeNull();
    flown[0]?.fire('moveend');
    frames.flush();
    expect(host.querySelector('path.ov-selected')).not.toBeNull();
  });
});

describe('tooltipShift (hover tooltip stays inside the map)', () => {
  it('leaves a tooltip that fits where it is', () => {
    expect(tooltipShift(400, 120, 800, 8)).toBe(0);
  });

  it('slides a tooltip in from the right and from the left edge, 8 px inside', () => {
    expect(tooltipShift(780, 120, 800, 8)).toBe(800 - 8 - (780 + 60));
    expect(tooltipShift(20, 120, 800, 8)).toBe(8 - (20 - 60));
  });
});

describe('tooltipFlipsBelow (hover tooltip near the top of the map)', () => {
  it('keeps the tooltip above a pointer with room, and hangs it below one near the top edge', () => {
    // 26 px tall, 12 px above the pointer, 8 px inside the map.
    expect(tooltipFlipsBelow(200, 26, 0, 8)).toBe(false);
    expect(tooltipFlipsBelow(46, 26, 0, 8)).toBe(false);
    // The finding's case: the pointer 22 px below the map top put the tooltip's top at -16.
    expect(tooltipFlipsBelow(22, 26, 0, 8)).toBe(true);
    // A strip over the top of the map counts as the edge.
    expect(tooltipFlipsBelow(60, 26, 28, 8)).toBe(true);
  });
});

describe('phoneRevealNeeded (UX section 3.2 [M] free strip on phones)', () => {
  const browse = { mode: 'browse' as const, selectedAreaId: null };
  it('reveals a new selection, entering Drawing / EditingShape, and returning to the selection', () => {
    expect(phoneRevealNeeded({ layout: 'phone', mode: 'area-selected', selectedAreaId: 'a' }, browse)).toBe(
      true,
    );
    expect(
      phoneRevealNeeded(
        { layout: 'phone', mode: 'area-selected', selectedAreaId: 'b' },
        { mode: 'area-selected', selectedAreaId: 'a' },
      ),
    ).toBe(true);
    expect(
      phoneRevealNeeded(
        { layout: 'phone', mode: 'editing-shape', selectedAreaId: 'a' },
        { mode: 'area-selected', selectedAreaId: 'a' },
      ),
    ).toBe(true);
    expect(phoneRevealNeeded({ layout: 'phone', mode: 'drawing', selectedAreaId: null }, browse)).toBe(true);
    expect(
      phoneRevealNeeded(
        { layout: 'phone', mode: 'area-selected', selectedAreaId: 'a' },
        { mode: 'saving-edit', selectedAreaId: 'a' },
      ),
    ).toBe(true);
  });

  it('does nothing for unrelated updates, and never outside the phone layout', () => {
    const selected = { mode: 'area-selected' as const, selectedAreaId: 'a' };
    expect(phoneRevealNeeded({ layout: 'phone', ...selected }, selected)).toBe(false);
    expect(
      phoneRevealNeeded(
        { layout: 'phone', mode: 'editing-shape', selectedAreaId: 'a' },
        { mode: 'editing-shape', selectedAreaId: 'a' },
      ),
    ).toBe(false);
    expect(phoneRevealNeeded({ layout: 'docked', mode: 'area-selected', selectedAreaId: 'a' }, browse)).toBe(
      false,
    );
    expect(
      phoneRevealNeeded({ layout: 'overlay', mode: 'editing-shape', selectedAreaId: 'a' }, selected),
    ).toBe(false);
  });
});
