import type { AreaDto, CreateAreaRequest, Position } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base } from '../base/en';
import { loadLocalDraft, saveLocalDraft } from '../state/localDraft';
import { areaDto } from '../test/factories';
import type { Harness } from '../test/workspaceHarness';
import { apiProblem, createHarness, flush, ME, mutation, networkError } from '../test/workspaceHarness';
import { DrawingFlow } from './drawingFlow';

const P1: Position = [34.78, 32.08];
const P2: Position = [34.79, 32.08];
const P3: Position = [34.79, 32.09];
const TRIANGLE: Position[] = [P1, P2, P3];

function setup(): { h: Harness; flow: DrawingFlow; saved: AreaDto[]; retries: (() => void)[] } {
  const h = createHarness();
  const saved: AreaDto[] = [];
  const retries: (() => void)[] = [];
  const flow = new DrawingFlow(h.ctx, {
    onSaved: (area) => {
      saved.push(area);
      h.ctx.stores.workspace.getState().patch({ mode: 'area-selected', selectedAreaId: area.id });
    },
    retryAfterSignIn: (action) => {
      retries.push(action);
    },
  });
  return { h, flow, saved, retries };
}

function drawTriangle(flow: DrawingFlow): void {
  flow.start('pointer');
  for (const point of TRIANGLE) expect(flow.place(point)).toBe('added');
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DrawingFlow - draw, validate, finish (UX F-03, C-06)', () => {
  it('UX-AC-09 D enters Drawing: mode drawing, the map is focused, the mode is announced; nothing is sent before the first point', () => {
    const { h, flow } = setup();
    flow.start('keyboard');
    expect(h.ctx.stores.workspace.getState().mode).toBe('drawing');
    expect(h.ctx.stores.drawing.getState().viaKeyboard).toBe(true);
    expect(h.map.focus).toBe(1);
    expect(h.ctx.stores.live.getState().status.text).toBe(base.sr.drawMode);
    expect(h.transport.ofType('draft.start')).toHaveLength(0);
  });

  it('the first point starts the live draft (one drawing action); later points stream updates', async () => {
    const { h, flow } = setup();
    flow.start('pointer');
    flow.place(P1);
    await flush();
    const starts = h.transport.ofType('draft.start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.data).toMatchObject({ areaId: null, resume: false });
    flow.place(P2);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.transport.ofType('draft.update').length).toBeGreaterThan(0);
  });

  it('C-06.2 the per-point announcement speaks the placed points only, never a provisional pointer point', () => {
    const { h, flow } = setup();
    flow.start('keyboard');
    flow.place(P1);
    // The reticle already sits elsewhere (a later pan): the readout may count it, the announcement must not.
    flow.pointer(P3);
    flow.place(P2);
    expect(h.ctx.stores.live.getState().status.text).toBe(base.sr.pointAdded(2, base.sr.areaUnknown));
    flow.pointer([34.785, 32.1]);
    flow.place(P3);
    const placedOnly = h.ctx.stores.live.getState().status.text;
    flow.undo();
    flow.pointer(P1);
    flow.place(P3);
    expect(h.ctx.stores.live.getState().status.text).toBe(placedOnly);
  });

  it('UX-AC-15 / UX-AC-106 a crossing point is refused with exactly one status announcement', () => {
    const { h, flow } = setup();
    flow.start('pointer');
    for (const point of [
      [34.78, 32.08],
      [34.79, 32.09],
      [34.79, 32.08],
    ] as Position[]) {
      flow.place(point);
    }
    const before = h.ctx.stores.live.getState().status.seq;
    expect(flow.place([34.78, 32.09])).toBe('refused');
    const status = h.ctx.stores.live.getState().status;
    expect(status.seq).toBe(before + 1);
    expect(status.text).toBe(base.sr.pointRefused(base.draw.crossing));
    expect(h.ctx.stores.drawing.getState().drawing.points).toHaveLength(3);
    expect(h.ctx.stores.drawing.getState().drawing.refusal?.code).toBe('crossing');
  });

  it('UX-AC-17 undo removes exactly one point and is announced; at 0 points it does nothing', () => {
    const { h, flow } = setup();
    drawTriangle(flow);
    flow.undo();
    expect(h.ctx.stores.drawing.getState().drawing.points).toHaveLength(2);
    expect(h.ctx.stores.live.getState().status.text).toContain('Point removed. 2 points.');
    flow.undo();
    flow.undo();
    const seq = h.ctx.stores.live.getState().status.seq;
    flow.undo();
    expect(h.ctx.stores.live.getState().status.seq).toBe(seq);
  });

  it('finish with < 3 points is refused and announced; with a valid triangle it opens the save form', () => {
    const { h, flow } = setup();
    flow.start('pointer');
    flow.place(P1);
    expect(flow.finish()).toBe(false);
    expect(h.ctx.stores.live.getState().status.text).toBe(base.sr.finishRefused(base.draw.needThree));
    flow.place(P2);
    flow.place(P3);
    expect(flow.finish()).toBe(true);
    expect(h.ctx.stores.workspace.getState()).toMatchObject({ mode: 'naming', panel: 'save' });
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('name-input');
    expect(h.ctx.stores.drawing.getState().finishedRing).toHaveLength(4);
    flow.backToDrawing();
    expect(h.ctx.stores.workspace.getState().mode).toBe('drawing');
    expect(h.ctx.stores.drawing.getState().drawing.points).toHaveLength(3);
  });

  it('UX-AC-18 Esc with points: back to Browse, draft ended, an Undo toast restores the identical points', async () => {
    const { h, flow } = setup();
    drawTriangle(flow);
    await flush();
    flow.cancel();
    expect(h.ctx.stores.workspace.getState().mode).toBe('browse');
    expect(h.transport.ofType('draft.end')[0]?.data).toMatchObject({ outcome: 'cancelled' });
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast).toMatchObject({ kind: 'undo', code: 'toast.drawingDiscarded' });
    toast?.action?.run();
    expect(h.ctx.stores.workspace.getState().mode).toBe('drawing');
    expect(h.ctx.stores.drawing.getState().drawing.points).toEqual(TRIANGLE);
  });

  it('cancel with 0 points exits silently; D while drawing cancels', () => {
    const { h, flow } = setup();
    flow.start('pointer');
    flow.start('pointer');
    expect(h.ctx.stores.workspace.getState().mode).toBe('browse');
    expect(h.ctx.stores.toasts.getState().toasts).toHaveLength(0);
  });

  it('C-06.8 a cancelled drawing is marked discarded at once, so a reload inside the Undo window offers nothing', () => {
    const { flow } = setup();
    drawTriangle(flow);
    saveLocalDraft(ME.id, { kind: 'drawing', points: TRIANGLE }, Date.now());
    flow.cancel();
    expect(loadLocalDraft(ME.id, Date.now())).toBeNull();
  });

  it('D is refused while naming (draw.busy)', () => {
    const { h, flow } = setup();
    drawTriangle(flow);
    flow.finish();
    flow.start('keyboard');
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.draw.busy);
  });
});

describe('DrawingFlow - save (UX F-03 steps 7-9, C-09)', () => {
  function naming(name: string): ReturnType<typeof setup> {
    const context = setup();
    drawTriangle(context.flow);
    context.flow.finish();
    context.h.ctx.stores.drawing.getState().patchNaming({ name });
    return context;
  }

  it('UX-AC-23 an empty (or zero-width-only) name shows save.nameRequired and sends nothing', () => {
    const { h, flow } = naming('​​ ');
    flow.save();
    expect(h.ctx.stores.drawing.getState().naming.nameError).toBe(base.save.nameRequired);
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
  });

  it('UX-AC-24 a successful save creates the area with the draft id, reports it, clears the local draft', async () => {
    const { h, flow, saved } = naming('North Field');
    await flush();
    const draftId = h.draft.draftId;
    h.api.create.mockImplementation((request: CreateAreaRequest) =>
      Promise.resolve(mutation(areaDto({ id: request.id ?? 'no-id', name: request.name }))),
    );
    saveLocalDraft(ME.id, { kind: 'naming', points: TRIANGLE, name: 'North Field' }, Date.now());
    flow.save();
    expect(h.ctx.stores.workspace.getState().mode).toBe('saving-new');
    expect(h.ctx.stores.drawing.getState().save.kind).toBe('saving');
    await flush();
    expect(h.api.create).toHaveBeenCalledTimes(1);
    const request = h.api.create.mock.calls[0]?.[0];
    expect(request?.id).toBe(draftId);
    expect(request?.geometry.coordinates[0]).toEqual([...TRIANGLE, TRIANGLE[0]]);
    expect(saved[0]?.name).toBe('North Field');
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('toast.saved');
    expect(h.transport.ofType('draft.end').at(-1)?.data).toMatchObject({
      outcome: 'committed',
      areaId: draftId,
    });
    expect(loadLocalDraft(ME.id, Date.now())).toBeNull();
    expect(h.ctx.stores.drawing.getState().drawing.points).toHaveLength(0);
  });

  it('UX-AC-63 a 429 shows the countdown; Cancel prevents the request and keeps the form', async () => {
    const { h, flow } = naming('North Field');
    h.api.create.mockRejectedValue(apiProblem(429, 'RATE_LIMITED', { retryAfterMs: 5000 }, 5000));
    flow.save();
    await flush();
    const save = h.ctx.stores.drawing.getState().save;
    expect(save.kind).toBe('countdown');
    flow.cancelSaveCountdown();
    await flush();
    expect(h.ctx.stores.drawing.getState().save.kind).toBe('idle');
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.api.create).toHaveBeenCalledTimes(1);
    expect(h.ctx.stores.drawing.getState().naming.name).toBe('North Field');
  });

  it('UX-AC-26 a 422 keeps Naming, records the problem location and says why', async () => {
    const { h, flow } = naming('North Field');
    h.api.create.mockRejectedValue(
      apiProblem(422, 'INVALID_GEOMETRY', {
        errors: [{ path: 'geometry', code: 'SELF_INTERSECTION', message: 'x', location: [34.785, 32.085] }],
      }),
    );
    flow.save();
    await flush();
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
    expect(h.ctx.stores.drawing.getState().serverInvalid).toEqual({
      code: 'SELF_INTERSECTION',
      location: [34.785, 32.085],
    });
    expect(h.ctx.stores.live.getState().alert.text).toBe(
      base.save.serverInvalid(base.save.reason['SELF_INTERSECTION'] ?? ''),
    );
  });

  it('UX-AC-25 a network failure keeps the work and offers Retry, which reuses the same id', async () => {
    const { h, flow } = naming('North Field');
    h.api.create.mockRejectedValueOnce(networkError());
    flow.save();
    await flush();
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast).toMatchObject({ kind: 'error', code: 'toast.saveFailedNetwork', durationMs: null });
    expect(h.ctx.stores.drawing.getState().save.kind).toBe('failed');
    h.api.create.mockImplementation((request: CreateAreaRequest) =>
      Promise.resolve(mutation(areaDto({ id: request.id ?? 'no-id', name: request.name }))),
    );
    toast?.action?.run();
    await flush();
    expect(h.api.create).toHaveBeenCalledTimes(2);
    expect(h.api.create.mock.calls[1]?.[0].id).toBe(h.api.create.mock.calls[0]?.[0].id);
  });

  it('SG-21 AREA_ID_CONFLICT: a fresh id and one silent retry', async () => {
    const { h, flow, saved } = naming('North Field');
    h.api.create
      .mockRejectedValueOnce(apiProblem(409, 'AREA_ID_CONFLICT'))
      .mockImplementationOnce((request: CreateAreaRequest) =>
        Promise.resolve(mutation(areaDto({ id: request.id ?? 'no-id', name: request.name }))),
      );
    flow.save();
    await flush();
    expect(h.api.create).toHaveBeenCalledTimes(2);
    expect(h.api.create.mock.calls[1]?.[0].id).not.toBe(h.api.create.mock.calls[0]?.[0].id);
    expect(saved).toHaveLength(1);
  });

  it('a 400 on the name maps to the field error; a 401 is retried once after signing in again', async () => {
    const { h, flow, retries } = naming('North Field');
    h.api.create.mockRejectedValueOnce(
      apiProblem(400, 'VALIDATION_FAILED', { errors: [{ path: 'name', code: 'too_big', message: 'x' }] }),
    );
    flow.save();
    await flush();
    expect(h.ctx.stores.drawing.getState().naming.nameError).toBe(base.save.nameTooLong(120));
    h.api.create.mockRejectedValueOnce(apiProblem(401, 'SESSION_ENDED'));
    flow.save();
    await flush();
    expect(retries).toHaveLength(1);
  });

  it('UX-AC-92 503 then success: the storage toast shows while retrying and disappears', async () => {
    const { h, flow } = naming('North Field');
    h.api.create
      .mockRejectedValueOnce(apiProblem(503, 'DEPENDENCY_UNAVAILABLE', {}, 5000))
      .mockImplementationOnce((request: CreateAreaRequest) =>
        Promise.resolve(mutation(areaDto({ id: request.id ?? 'no-id', name: request.name }))),
      );
    flow.save();
    await flush();
    expect(
      h.ctx.stores.toasts.getState().toasts.some((toast) => toast.code === 'toast.storageUnavailable'),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(
      h.ctx.stores.toasts.getState().toasts.some((toast) => toast.code === 'toast.storageUnavailable'),
    ).toBe(false);
    expect(h.api.create).toHaveBeenCalledTimes(2);
  });

  it('C-14 "Save a copy" opens Naming prefilled, as a brand-new area', () => {
    const { h, flow } = setup();
    flow.startNamingWith(TRIANGLE, 'Copy of North Field', 'desc');
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
    expect(h.ctx.stores.drawing.getState().naming).toMatchObject({
      name: 'Copy of North Field',
      description: 'desc',
    });
    expect(h.ctx.stores.drawing.getState().finishedRing).toHaveLength(4);
    expect(h.draft.isOpen).toBe(false);
  });

  it('the restore banner brings a drawing back and fits the map to it', () => {
    const { h, flow } = setup();
    flow.restore({ kind: 'naming', points: TRIANGLE, name: 'Saved name', description: '' });
    expect(h.ctx.stores.workspace.getState().mode).toBe('naming');
    expect(h.ctx.stores.drawing.getState().naming.name).toBe('Saved name');
    expect(h.map.fits).toHaveLength(1);
  });
});
