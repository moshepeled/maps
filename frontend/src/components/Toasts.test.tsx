/**
 * Toasts (UX C-18 v2; UI.md section 10.11): the Studio leading icons per kind, the actor avatar on collaboration toasts,
 * and the Undo countdown bar in its track, frozen with the timer.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ServicesProvider } from '../app/AppContext';
import type { AppServices } from '../app/services';
import { createAppServices } from '../app/services';
import { systemScheduler } from '../lib/scheduler';
import type { Toast } from '../state/toastsStore';
import { BOB } from '../test/factories';
import type { IconName } from './Icon';
import { Icon } from './Icon';
import { Toasts } from './Toasts';

afterEach(cleanup);

function services(): AppServices {
  return createAppServices({
    fetch: () => Promise.resolve(new Response('{}', { status: 404 })),
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
}

function push(
  app: AppServices,
  toast: Partial<Omit<Toast, 'id' | 'createdAt'>> & Pick<Toast, 'kind' | 'code'>,
): void {
  app.stores.toasts
    .getState()
    .push({ lane: 'own', text: toast.code, durationMs: 10_000, ...toast }, Date.now());
}

/** The inner markup of an icon, to tell which glyph a toast leads with. */
function glyph(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const markup = container.querySelector('svg')?.innerHTML ?? '';
  unmount();
  return markup;
}

function toastWithCode(code: string): HTMLElement {
  const toast = screen.getAllByTestId('toast').find((element) => element.getAttribute('data-code') === code);
  if (toast === undefined) throw new Error(`no toast ${code}`);
  return toast;
}

describe('Toasts (UX C-18 v2)', () => {
  it('undo-able results lead with the undone action’s icon; states use their semantic tone', () => {
    const app = services();
    const undo = { kind: 'undo', label: 'Undo', run: () => undefined } as const;
    push(app, { kind: 'undo', code: 'toast.deleted', action: undo });
    push(app, { kind: 'undo', code: 'toast.drawingDiscarded', action: undo });
    push(app, { kind: 'error', code: 'toast.saveFailedServer', durationMs: null });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    const icon = (code: string) => toastWithCode(code).querySelector('svg.toast__icon');
    expect(icon('toast.deleted')?.innerHTML).toBe(glyph('trash-2'));
    expect(icon('toast.deleted')?.classList.contains('toast__icon--neutral')).toBe(true);
    expect(icon('toast.drawingDiscarded')?.innerHTML).toBe(glyph('snap-polygon'));
    expect(icon('toast.saveFailedServer')?.innerHTML).toBe(glyph('circle-alert'));
    expect(icon('toast.saveFailedServer')?.classList.contains('toast__icon--danger')).toBe(true);
  });

  it('a Show action (toast.deleteConflict) renders toast-show and runs once, closing the toast', () => {
    const app = services();
    let shown = 0;
    push(app, {
      kind: 'undo',
      code: 'toast.deleteConflict',
      action: { kind: 'show', label: 'Show', run: () => (shown += 1) },
    });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    fireEvent.click(screen.getByTestId('toast-show'));
    expect(shown).toBe(1);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('a finished action reads as success, a refusal as info', () => {
    const app = services();
    push(app, { kind: 'info', code: 'toast.saved' });
    push(app, { kind: 'info', code: 'toast.forbiddenDelete' });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    expect(toastWithCode('toast.saved').querySelector('.toast__icon--success')?.innerHTML).toBe(
      glyph('circle-check'),
    );
    expect(toastWithCode('toast.forbiddenDelete').querySelector('.toast__icon--info')?.innerHTML).toBe(
      glyph('info'),
    );
  });

  it('collaboration toasts lead with the actor’s avatar', () => {
    const app = services();
    push(app, { kind: 'collab', lane: 'collab', code: 'collab.created', actor: BOB });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    const avatar = toastWithCode('collab.created').querySelector('.avatar');
    expect(avatar?.textContent).toBe('Bo');
    expect((avatar as HTMLElement | null)?.style.getPropertyValue('--c')).toBe(BOB.color);
    expect(toastWithCode('collab.created').querySelector('svg.toast__icon')).toBeNull();
  });

  it('a trailing ", {value}" is set apart in mono, without changing the text or splitting a quoted name', () => {
    const app = services();
    push(app, { kind: 'info', code: 'toast.saved', text: 'Saved “Yarkon Park Plot” · 0.84 km²' });
    push(app, { kind: 'info', code: 'toast.renamed', text: 'Renamed to “North · South”' });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    const saved = toastWithCode('toast.saved').querySelector('.msg');
    expect(saved?.textContent).toBe('Saved “Yarkon Park Plot” · 0.84 km²');
    expect(saved?.querySelector('.msg__value.num')?.textContent).toBe(' · 0.84 km²');
    const renamed = toastWithCode('toast.renamed').querySelector('.msg');
    expect(renamed?.textContent).toBe('Renamed to “North · South”');
    expect(renamed?.querySelector('.msg__value')).toBeNull();
  });

  it('the Undo countdown fills its track and freezes while the toast is hovered', () => {
    const app = services();
    push(app, {
      kind: 'undo',
      code: 'toast.deleted',
      action: { kind: 'undo', label: 'Undo', run: () => undefined },
    });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    const bar = screen.getByTestId('toast-countdown');
    expect(bar.parentElement?.classList.contains('toast-timer')).toBe(true);
    expect(bar.style.getPropertyValue('--toast-duration')).toBe('10000ms');
    expect(bar.style.animationPlayState).toBe('running');
    fireEvent.mouseEnter(screen.getByTestId('toast'));
    expect(bar.style.animationPlayState).toBe('paused');
  });
});

describe('Toast actions and focus (UX section 8.3)', () => {
  it('the toast leaves with its focused button: focus goes to the map unless the action sent it elsewhere', () => {
    const app = services();
    const runs: (boolean | undefined)[] = [];
    push(app, {
      kind: 'undo',
      code: 'toast.deleted',
      action: { kind: 'undo', label: 'Undo', run: (viaKeyboard) => runs.push(viaKeyboard) },
    });
    render(
      <ServicesProvider services={app}>
        <Toasts />
      </ServicesProvider>,
    );
    fireEvent.click(screen.getByTestId('toast-undo'), { detail: 0 });
    expect(runs).toEqual([true]);
    expect(app.stores.workspace.getState().focusRequest?.target).toBe('map');

    act(() => {
      push(app, {
        kind: 'undo',
        code: 'toast.deleted',
        action: {
          kind: 'undo',
          label: 'Undo',
          run: () => {
            app.stores.workspace.getState().requestFocus('panel-heading');
          },
        },
      });
    });
    fireEvent.click(screen.getByTestId('toast-undo'), { detail: 1 });
    expect(app.stores.workspace.getState().focusRequest?.target).toBe('panel-heading');
  });
});
