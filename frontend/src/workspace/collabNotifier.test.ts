import type { AreaDto, Bbox } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base } from '../base/en';
import { ALICE, BOB, areaDto, uuid } from '../test/factories';
import { createHarness } from '../test/workspaceHarness';
import type { CollabEvent } from './collabNotifier';
import { CollabNotifier, collabCode, collabMessage } from './collabNotifier';

const VIEW: Bbox = [34.7, 32.0, 34.9, 32.2];

function event(
  op: CollabEvent['op'],
  area: AreaDto = areaDto({ id: uuid(), name: 'North Field' }),
  actor = BOB,
): CollabEvent {
  return { op, area, changedFields: op === 'update' ? ['geometry'] : [], previousName: null, actor };
}

function setup(options: { reducedMotion?: boolean } = {}) {
  const h = createHarness(options);
  const notifier = new CollabNotifier(h.ctx, () => VIEW);
  const collabToasts = () => h.ctx.stores.toasts.getState().toasts.filter((toast) => toast.lane === 'collab');
  return { h, notifier, collabToasts };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CollabNotifier (UX section 6.5, section 6.6, C-08)', () => {
  it('one in-scope create -> one specific toast after the 3 s batch window, announced in live-collab', () => {
    const { h, notifier, collabToasts } = setup();
    const created = event('create');
    notifier.onChange(created, 'ws');
    expect(collabToasts()).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(collabToasts()).toHaveLength(1);
    expect(collabToasts()[0]?.text).toBe(collabMessage(created));
    expect(collabToasts()[0]?.actor?.color).toBe(BOB.color);
    expect(h.ctx.stores.live.getState().collab.text).toBe(collabMessage(created));
  });

  it('UX-AC-54 five creates within 2 s produce exactly one summary toast', () => {
    const { notifier, collabToasts } = setup();
    for (let i = 0; i < 5; i += 1) {
      notifier.onChange(event('create'), 'ws');
      vi.advanceTimersByTime(400);
    }
    vi.advanceTimersByTime(3000);
    expect(collabToasts()).toHaveLength(1);
    expect(collabToasts()[0]?.text).toBe(base.collab.summary(5, 'Bob'));
  });

  it('a newer event about an area replaces the unread one: a delete undone at once never reads as deleted', () => {
    const { notifier, collabToasts } = setup();
    const park = areaDto({ id: uuid(), name: 'Sarona Park' });
    notifier.onChange(event('delete', park), 'ws');
    vi.advanceTimersByTime(1000);
    notifier.onChange(event('restore', park), 'ws');
    vi.advanceTimersByTime(3000);
    expect(collabToasts().map((toast) => toast.text)).toEqual([base.collab.undeleted('Bob', 'Sarona Park')]);

    // The delete toast is already on screen when the restore arrives: it goes at once; the restore follows the gap.
    vi.advanceTimersByTime(60_000);
    notifier.onChange(event('delete', park), 'ws');
    vi.advanceTimersByTime(3000);
    expect(collabToasts().map((toast) => toast.text)).toEqual([base.collab.deleted('Bob', 'Sarona Park')]);
    notifier.onChange(event('restore', park), 'ws');
    expect(collabToasts()).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(collabToasts().map((toast) => toast.text)).toEqual([base.collab.undeleted('Bob', 'Sarona Park')]);
  });

  it('UX-AC-85 twenty changes over 60 s give at most 3 toasts; the rest go to the busy counter', () => {
    const { h, notifier } = setup();
    let toasts = 0;
    const unsubscribe = h.ctx.stores.toasts.subscribe((state, previous) => {
      if (
        state.toasts
          .filter((toast) => toast.lane === 'collab')
          .some((toast) => !previous.toasts.includes(toast))
      )
        toasts += 1;
    });
    for (let i = 0; i < 20; i += 1) {
      notifier.onChange(event(i % 2 === 0 ? 'create' : 'delete'), 'ws');
      vi.advanceTimersByTime(3000);
    }
    vi.advanceTimersByTime(10_000);
    unsubscribe();
    expect(toasts).toBeLessThanOrEqual(3);
    expect(h.ctx.stores.presence.getState().changesCounter).toBeGreaterThan(0);
    notifier.resetCounter();
    expect(h.ctx.stores.presence.getState().changesCounter).toBe(0);
  });

  it('UX-AC-55 a reshape of an unselected area in view pulses without a toast; events outside the view do nothing', () => {
    const { h, notifier, collabToasts } = setup();
    const reshaped = event('update');
    notifier.onChange(reshaped, 'ws');
    notifier.onChange(event('create', areaDto({ id: uuid(), west: 10, south: 10 })), 'ws');
    vi.advanceTimersByTime(5000);
    expect(collabToasts()).toHaveLength(0);
    expect(h.ctx.stores.effects.getState().pulses.size).toBe(0);
    notifier.onChange(reshaped, 'ws');
    expect(h.ctx.stores.effects.getState().pulses.get(reshaped.area.id)?.color).toBe(BOB.color);
    vi.advanceTimersByTime(1500);
    expect(h.ctx.stores.effects.getState().pulses.size).toBe(0);
  });

  it('any change of the selected area is in scope', () => {
    const { h, notifier, collabToasts } = setup();
    const renamed: CollabEvent = { ...event('update'), changedFields: ['name'], previousName: 'Old' };
    h.ctx.stores.workspace.getState().patch({ selectedAreaId: renamed.area.id });
    notifier.onChange(renamed, 'ws');
    vi.advanceTimersByTime(3000);
    expect(collabToasts()[0]?.text).toBe(base.collab.renamed('Bob', 'Old', 'North Field'));
  });

  it('UX-AC-85 held while drawing, flushed as ONE heldSummary when drawing ends', () => {
    const { h, notifier, collabToasts } = setup();
    h.ctx.stores.workspace.getState().patch({ mode: 'drawing' });
    notifier.onChange(event('create'), 'ws');
    notifier.onChange(event('delete'), 'ws');
    vi.advanceTimersByTime(10_000);
    expect(collabToasts()).toHaveLength(0);
    expect(h.ctx.stores.live.getState().collab.text).toBe('');
    notifier.onModeChange('drawing', 'browse');
    expect(collabToasts()).toHaveLength(1);
    expect(collabToasts()[0]?.text).toBe(base.collab.heldSummary(2, 'Bob'));
  });

  it('UX-AC-53 Quiet mode: pulses, no toasts; my own echoes and the area I edit never toast', () => {
    const { h, notifier, collabToasts } = setup();
    h.ctx.stores.workspace.getState().patch({ quietMode: true });
    const created = event('create');
    notifier.onChange(created, 'ws');
    vi.advanceTimersByTime(5000);
    expect(collabToasts()).toHaveLength(0);
    expect(h.ctx.stores.effects.getState().pulses.size).toBe(0);
    h.ctx.stores.workspace.getState().patch({ quietMode: false });
    notifier.onChange(event('create', areaDto({ id: uuid() }), ALICE), 'ws');
    vi.advanceTimersByTime(5000);
    expect(collabToasts()).toHaveLength(0);
  });

  it('UX-AC-69 reduced motion: a static ring for 3 s instead of the 1.5 s animation; system changes use the neutral colour', () => {
    const { h, notifier } = setup({ reducedMotion: true });
    const changed: CollabEvent = { ...event('update'), actor: null };
    notifier.onChange(changed, 'feed');
    const pulse = h.ctx.stores.effects.getState().pulses.get(changed.area.id);
    // null: the map paints it in the tone's neutral saved-area colour (--ov-area-stroke), not a fixed hex.
    expect(pulse).toMatchObject({ staticRing: true, color: null, userName: null });
    vi.advanceTimersByTime(2000);
    expect(h.ctx.stores.effects.getState().pulses.size).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(h.ctx.stores.effects.getState().pulses.size).toBe(0);
  });

  it('remembers the latest actor per area (auto-merge toasts)', () => {
    const { notifier } = setup();
    const changed = event('update');
    notifier.onChange(changed, 'feed');
    expect(notifier.lastActor(changed.area.id)).toEqual(BOB);
    expect(notifier.lastActor(uuid())).toBeNull();
    notifier.dispose();
  });

  it('collabMessage covers every op and field combination', () => {
    const area = areaDto({ id: uuid(), name: 'North Field' });
    const event: CollabEvent = { op: 'update', area, changedFields: [], previousName: null, actor: BOB };
    expect(collabMessage({ ...event, op: 'delete' })).toBe(base.collab.deleted('Bob', 'North Field'));
    expect(collabMessage({ ...event, op: 'restore' })).toBe(base.collab.undeleted('Bob', 'North Field'));
    expect(collabMessage({ ...event, changedFields: ['description'] })).toBe(
      base.collab.described('Bob', 'North Field'),
    );
    expect(collabMessage({ ...event, changedFields: ['name', 'geometry'] })).toBe(
      base.collab.updated('Bob', 'North Field'),
    );
    expect(collabMessage({ ...event, actor: null, op: 'delete' })).toBe(
      base.collab.deleted('Someone', 'North Field'),
    );
  });
});

describe('Activity record (UX C-31, UX-AC-119)', () => {
  const items = (h: ReturnType<typeof setup>['h']) => h.ctx.stores.activity.getState().items;

  it('records an in-scope create at once, newest first, with its code, text and area', () => {
    const { h, notifier } = setup();
    const first = event('create');
    const second = event('create', areaDto({ id: uuid(), name: 'South Field' }));
    notifier.onChange(first, 'ws');
    notifier.onChange(second, 'ws');
    expect(items(h)).toHaveLength(2);
    expect(items(h)[0]).toMatchObject({
      areaId: second.area.id,
      code: 'collab.created',
      text: collabMessage(second),
      areaKm2: second.area.areaKm2,
      actor: { id: BOB.id, displayName: BOB.displayName, color: BOB.color },
    });
    expect(items(h)[1]?.areaId).toBe(first.area.id);
  });

  it('keeps recording while toasts are held (Drawing) and in Quiet mode; a delete row has no area size', () => {
    const { h, notifier, collabToasts } = setup();
    h.ctx.stores.workspace.getState().patch({ mode: 'drawing', quietMode: true });
    const deleted = event('delete');
    notifier.onChange(deleted, 'ws');
    vi.advanceTimersByTime(5000);
    expect(collabToasts()).toHaveLength(0);
    expect(items(h)[0]).toMatchObject({ code: 'collab.deleted', areaKm2: null });
  });

  it('skips out-of-scope changes, feed items, my own echoes and events without an actor', () => {
    const { h, notifier } = setup();
    notifier.onChange(event('update'), 'ws'); // a reshape of an unselected area: map pulse only
    notifier.onChange(event('create', areaDto({ id: uuid(), west: 10, south: 10 })), 'ws'); // outside the view
    notifier.onChange(event('create'), 'feed');
    notifier.onChange(event('create', areaDto({ id: uuid() }), ALICE), 'ws');
    notifier.onChange({ ...event('create'), actor: null }, 'ws');
    expect(items(h)).toHaveLength(0);
  });

  it('keeps at most 50 rows, dropping the oldest', () => {
    const { h, notifier } = setup();
    const events = Array.from({ length: 51 }, () => event('create'));
    for (const created of events) notifier.onChange(created, 'ws');
    expect(items(h)).toHaveLength(50);
    expect(items(h)[0]?.areaId).toBe(events[50]?.area.id);
    expect(items(h).some((item) => item.areaId === events[0]?.area.id)).toBe(false);
  });

  it('collabCode names the copy key of each single-event message', () => {
    const area = areaDto({ id: uuid() });
    const event: CollabEvent = {
      op: 'update',
      area,
      changedFields: ['geometry'],
      previousName: null,
      actor: BOB,
    };
    expect(collabCode({ ...event, op: 'create' })).toBe('collab.created');
    expect(collabCode(event)).toBe('collab.reshaped');
    expect(collabCode({ ...event, changedFields: ['name'] })).toBe('collab.renamed');
    expect(collabCode({ ...event, changedFields: ['description'] })).toBe('collab.described');
    expect(collabCode({ ...event, changedFields: ['name', 'description'] })).toBe('collab.updated');
    expect(collabCode({ ...event, op: 'delete' })).toBe('collab.deleted');
    expect(collabCode({ ...event, op: 'restore' })).toBe('collab.undeleted');
  });
});
