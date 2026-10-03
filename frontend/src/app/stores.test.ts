import type { ConfigResponse } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { applyChange } from '../state/areasStore';
import { areaDto, uuid } from '../test/factories';
import { signedIn } from '../test/workspaceHarness';
import { createAppStores, resetUserStores } from './stores';

describe('resetUserStores (UX F-11: the next user never sees the previous user’s state)', () => {
  it('returns every per-user store to its initial state and keeps the session and the runtime config', () => {
    const stores = createAppStores();
    const config = { limits: {} } as unknown as ConfigResponse;
    stores.auth.getState().setSession(signedIn());
    stores.runtime.getState().setConfig(config);
    stores.workspace.getState().patch({ mode: 'drawing', panel: 'list' });
    stores.drawing.getState().setDrawing({
      ...stores.drawing.getState().drawing,
      points: [
        [34.78, 32.08],
        [34.79, 32.08],
      ],
    });
    stores.notices.getState().patch({ restoreDraft: true, emptyView: true });
    stores.mapView.getState().setView({
      center: { lat: 48.9, lng: 2.3 },
      zoom: 12,
      mercatorZoom: 12,
      viewport: [2.2, 48.8, 2.4, 49],
    });
    stores.toasts.getState().push({ lane: 'own', kind: 'info', code: 'x', text: 'x', durationMs: 1000 }, 0);
    stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(state, { op: 'create', area: areaDto({ id: uuid() }) }, 0, { requested: true }).state,
      );
    const revision = stores.areas.getState().revision;
    stores.activity.getState().record({
      areaId: uuid(),
      code: 'collab.created',
      actor: { id: uuid(), displayName: 'Bob', color: '#b86e3d' },
      text: 'Bob created “North Field” · 2.31 km²',
      areaKm2: 2.31,
      at: 0,
    });

    resetUserStores(stores);

    expect(stores.workspace.getState().mode).toBe('browse');
    expect(stores.workspace.getState().panel).toBe('none');
    expect(stores.drawing.getState().drawing.points).toHaveLength(0);
    expect(stores.notices.getState().restoreDraft).toBe(false);
    expect(stores.mapView.getState().center).toEqual(createAppStores().mapView.getState().center);
    expect(stores.toasts.getState().toasts).toHaveLength(0);
    expect(stores.activity.getState().items).toHaveLength(0);
    expect(stores.areas.getState().byId.size).toBe(0);
    expect(stores.areas.getState().revision).toBeGreaterThan(revision); // renderers see the change
    // Actions survive the reset.
    stores.workspace.getState().patch({ mode: 'naming' });
    expect(stores.workspace.getState().mode).toBe('naming');
    // Not per-user: the session and the server configuration.
    expect(stores.auth.getState().status).toBe('signed-in');
    expect(stores.runtime.getState().config).toBe(config);
  });
});
