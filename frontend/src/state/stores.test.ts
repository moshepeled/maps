import type { PresenceDto } from '@snapland/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { ALICE, BOB, uuid } from '../test/factories';
import {
  clearLocalDraft,
  loadDevicePrefs,
  loadLocalDraft,
  loadViewPreference,
  markLocalDraftDiscarded,
  saveDevicePrefs,
  saveLocalDraft,
  saveViewPreference,
} from './localDraft';
import { activeLock, createLocksStore } from './locksStore';
import { resolveBaseLayer, toggledChoice } from './mapViewStore';
import type { NoticesState } from './noticesStore';
import { IDLE_LOAD, createNoticesStore, topNotice } from './noticesStore';
import { createPresenceStore, groupPresence } from './presenceStore';
import { createToastsStore } from './toastsStore';
import { createLiveRegionStore } from './liveRegionStore';
import { drawingLimits } from './runtimeConfigStore';

function presence(
  userId: string,
  name: string,
  status: PresenceDto['status'],
  connectionId = uuid(),
): PresenceDto {
  return {
    connectionId,
    userId,
    displayName: name,
    color: '#b86e3d',
    status,
    activeAreaId: null,
    viewport: null,
    connectedAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
  };
}

afterEach(() => {
  localStorage.clear();
});

describe('base layers (user decisions D-1, D-7; SPEC section 8.3, UX section 7)', () => {
  it('Aerial is the GovMap 2022 ITM cache; Map is OpenStreetMap', () => {
    expect(resolveBaseLayer('aerial', true)).toBe('govmap-itm');
    expect(resolveBaseLayer('map', true)).toBe('map');
  });

  it('ITM kill switch off: Aerial is Esri World Imagery', () => {
    expect(resolveBaseLayer('aerial', false)).toBe('aerial');
    expect(resolveBaseLayer('map', false)).toBe('map');
  });

  it('L toggles Map <-> Aerial', () => {
    expect(toggledChoice('map')).toBe('aerial');
    expect(toggledChoice('aerial')).toBe('map');
  });

  it('runtime config fallbacks', () => {
    expect(drawingLimits(null).maxPoints).toBe(1999);
  });
});

describe('notices: one slot, UX C-17 total order', () => {
  const base: NoticesState = {
    load: IDLE_LOAD,
    cullingDismissedAtZoom: null,
    emptyDismissed: false,
    emptyView: false,
    outsideCoverage: false,
    tilesFailing: null,
    restoreDraft: false,
  };

  it('picks the highest notice', () => {
    expect(topNotice(base)).toBeNull();
    expect(topNotice({ ...base, emptyView: true })).toBe('empty-hint');
    expect(topNotice({ ...base, emptyView: true, outsideCoverage: true })).toBe('coverage-notice');
    expect(topNotice({ ...base, load: { ...IDLE_LOAD, culledCount: 5, zoom: 12 } })).toBe('culling-notice');
    expect(
      topNotice({ ...base, load: { ...IDLE_LOAD, culledCount: 5, zoom: 12 }, cullingDismissedAtZoom: 12 }),
    ).toBeNull();
    expect(topNotice({ ...base, load: { ...IDLE_LOAD, truncatedShown: 20_000, culledCount: 5 } })).toBe(
      'truncation-notice',
    );
    expect(topNotice({ ...base, tilesFailing: 'map', load: { ...IDLE_LOAD, truncatedShown: 1 } })).toBe(
      'tiles-failing-notice',
    );
    expect(topNotice({ ...base, load: { ...IDLE_LOAD, failure: { kind: 'storage', retryAt: 1 } } })).toBe(
      'storage-notice',
    );
    expect(
      topNotice({ ...base, load: { ...IDLE_LOAD, failure: { kind: 'rate-limited', retryAt: 1 } } }),
    ).toBe('read-rate-limit-notice');
    expect(topNotice({ ...base, load: { ...IDLE_LOAD, failure: { kind: 'error' } } })).toBe('load-error');
    expect(
      topNotice({ ...base, restoreDraft: true, load: { ...IDLE_LOAD, failure: { kind: 'error' } } }),
    ).toBe('restore-draft-banner');
    const store = createNoticesStore();
    store.getState().patch({ emptyView: true });
    expect(topNotice(store.getState())).toBe('empty-hint');
  });
});

describe('presence grouping (UX section 6.1)', () => {
  it('groups tabs per user, busiest status wins, me first', () => {
    const rows = groupPresence(
      [
        presence(BOB.id, 'Bob', 'viewing'),
        presence(BOB.id, 'Bob', 'editing'),
        presence(ALICE.id, 'Alice', 'viewing'),
        presence(uuid(), 'Zed', 'drawing'),
      ],
      ALICE,
      'ws',
    );
    expect(rows.map((row) => row.displayName)).toEqual(['Alice', 'Bob', 'Zed']);
    expect(rows[0]?.status).toBe('viewing');
    expect(rows[1]?.status).toBe('editing');
    expect(rows[1]?.connections).toBe(2);
    expect(groupPresence([presence(BOB.id, 'Bob', 'drawing')], null, 'rest')[0]?.status).toBe('unknown');
  });

  it('keeps me first and counted when the polled list of Limited mode has no connection of mine', () => {
    const rows = groupPresence([presence(BOB.id, 'Bob', 'viewing')], ALICE, 'rest');
    expect(rows.map((row) => [row.displayName, row.isMe, row.status])).toEqual([
      ['Alice', true, 'unknown'],
      ['Bob', false, 'unknown'],
    ]);
  });

  it('the store upserts and removes connections', () => {
    const store = createPresenceStore();
    const entry = presence(BOB.id, 'Bob', 'viewing');
    store.getState().snapshot([entry], 1, false, 'ws');
    store.getState().upsert({ ...entry, status: 'drawing' });
    expect(store.getState().entries.get(entry.connectionId)?.status).toBe('drawing');
    store.getState().remove(entry.connectionId);
    expect(store.getState().entries.size).toBe(0);
    store.getState().clear();
    expect(store.getState().source).toBe('none');
  });
});

describe('locks (SPEC section 7.9)', () => {
  it('hides my own and expired locks', () => {
    const store = createLocksStore();
    const areaId = uuid();
    store.getState().snapshot([
      {
        areaId,
        holder: { userId: BOB.id, displayName: 'Bob', color: '#b86e3d' },
        scope: 'geometry',
        expiresAt: new Date(2000).toISOString(),
      },
    ]);
    expect(activeLock(store.getState(), areaId, ALICE.id, 1000)?.holder.displayName).toBe('Bob');
    expect(activeLock(store.getState(), areaId, ALICE.id, 3000)).toBeNull();
    expect(activeLock(store.getState(), areaId, BOB.id, 1000)).toBeNull();
    store.getState().changed({ areaId, holder: null, scope: null, expiresAt: null });
    expect(store.getState().locks.size).toBe(0);
    expect(store.getState().known).toBe(true);
    store.getState().clear();
    expect(store.getState().known).toBe(false);
  });
});

describe('local draft autosave (UX C-06.8, C-24)', () => {
  it('restores the latest drawing, hides a discarded one and expires after 7 days', () => {
    saveLocalDraft(
      ALICE.id,
      {
        kind: 'drawing',
        points: [
          [34.78, 32.08],
          [34.79, 32.08],
        ],
      },
      1000,
    );
    expect(loadLocalDraft(ALICE.id, 2000)?.points).toHaveLength(2);
    expect(loadLocalDraft(BOB.id, 2000)).toBeNull();
    markLocalDraftDiscarded(ALICE.id, 3000);
    expect(loadLocalDraft(ALICE.id, 4000)).toBeNull();
    saveLocalDraft(ALICE.id, { kind: 'naming', points: [[1, 1]], name: 'North' }, 1000);
    expect(loadLocalDraft(ALICE.id, 1000 + 8 * 24 * 3_600_000)).toBeNull();
    clearLocalDraft(ALICE.id);
    expect(loadLocalDraft(ALICE.id, 1000)).toBeNull();
  });

  it('view preference and device preferences round-trip', () => {
    expect(loadViewPreference(ALICE.id)).toBeNull();
    saveViewPreference(ALICE.id, { center: { lat: 32.08, lng: 34.78 }, zoom: 14, choice: 'aerial' });
    expect(loadViewPreference(ALICE.id)?.choice).toBe('aerial');
    expect(loadDevicePrefs()).toEqual({ quietMode: false, singleKeyShortcuts: true });
    saveDevicePrefs({ quietMode: true, singleKeyShortcuts: false });
    expect(loadDevicePrefs()).toEqual({ quietMode: true, singleKeyShortcuts: false });
  });
});

describe('toasts and live regions', () => {
  it('keeps at most 3 own toasts and remembers a replaced Undo', () => {
    const store = createToastsStore();
    let undone = 0;
    store.getState().push(
      {
        lane: 'own',
        kind: 'undo',
        code: 'toast.deleted',
        text: 'Deleted',
        durationMs: 10_000,
        action: { kind: 'undo', label: 'Undo', run: () => (undone += 1) },
      },
      0,
    );
    for (let i = 0; i < 3; i += 1)
      store.getState().push({ lane: 'own', kind: 'info', code: 'x', text: `t${i}`, durationMs: 5000 }, 1);
    expect(store.getState().toasts).toHaveLength(3);
    store.getState().lastUndo?.run();
    expect(undone).toBe(1);
    store.getState().push({ lane: 'collab', kind: 'collab', code: 'c1', text: 'a', durationMs: 5000 }, 2);
    store.getState().push({ lane: 'collab', kind: 'collab', code: 'c2', text: 'b', durationMs: 5000 }, 3);
    expect(
      store
        .getState()
        .toasts.filter((toast) => toast.lane === 'collab')
        .map((toast) => toast.code),
    ).toEqual(['c2']);
    store.getState().dismissByCode('c2');
    expect(store.getState().toasts.some((toast) => toast.code === 'c2')).toBe(false);
  });

  it('phones keep one own toast in the store: the replaced Undo goes to lastUndo with its own expiry (UX section 3.2)', () => {
    const store = createToastsStore();
    let undone = '';
    const undoToast = (text: string) => ({
      lane: 'own' as const,
      kind: 'undo' as const,
      code: 'toast.deleted',
      text,
      durationMs: 10_000,
      action: { kind: 'undo' as const, label: 'Undo', run: () => (undone = text) },
    });
    store.getState().push(undoToast('Deleted “PU1”'), 1_000, 1);
    store.getState().push(undoToast('Deleted “PU2”'), 4_000, 1);
    // The older toast is gone from the store, so it can never resurface once the newer one expires.
    expect(store.getState().toasts.map((toast) => toast.text)).toEqual(['Deleted “PU2”']);
    const last = store.getState().lastUndo;
    expect(last?.text).toBe('Deleted “PU1”');
    // Its original deadline (created at 1 s + 10 s), not a fresh 10 s from the replacement.
    expect(last?.expiresAt).toBe(11_000);
    last?.run();
    expect(undone).toBe('Deleted “PU1”');
    // Collaboration toasts never touch the own lane.
    store
      .getState()
      .push({ lane: 'collab', kind: 'collab', code: 'c', text: 'c', durationMs: 5000 }, 5_000, 1);
    expect(store.getState().toasts.map((toast) => toast.text)).toEqual(['Deleted “PU2”', 'c']);
  });

  it('does not repeat identical consecutive alerts', () => {
    const store = createLiveRegionStore();
    store.getState().announce('alert', 'Save conflict.');
    store.getState().announce('alert', 'Save conflict.');
    expect(store.getState().alert.seq).toBe(1);
    store.getState().announce('status', 'Saved');
    store.getState().announce('status', 'Saved');
    expect(store.getState().status.seq).toBe(2);
  });
});
