/**
 * The user menu as a menu button (UX C-02, C-30, UX-AC-112): opened from the keyboard, focus moves into the menu and
 * the arrow keys reach the theme options; Esc returns focus to the button. A pointer open leaves focus where it is.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ServicesProvider, WorkspaceProvider } from '../../app/AppContext';
import { createAppServices } from '../../app/services';
import { base } from '../../base/en';
import { systemScheduler } from '../../lib/scheduler';
import { FakeSocket } from '../../test/fakeSocket';
import { signedIn } from '../../test/workspaceHarness';
import { themeController } from '../../theme/theme';
import { Workspace } from '../../workspace/Workspace';
import { UserMenu } from './UserMenu';

afterEach(() => {
  cleanup();
  act(() => {
    themeController().set('dark');
  });
});

/** Every item of the open menu (menuitem, menuitemcheckbox, menuitemradio), in order. */
function menuItems(): HTMLElement[] {
  return Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'));
}

function setup() {
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
    reducedMotion: () => false,
    isPhone: () => false,
    itmLayerEnabled: true,
    appVersion: 'test',
  });
  render(
    <ServicesProvider services={services}>
      <WorkspaceProvider workspace={workspace}>
        <UserMenu />
      </WorkspaceProvider>
    </ServicesProvider>,
  );
  return { services, button: screen.getByTestId('user-menu-button') };
}

describe('UserMenu keyboard (UX-AC-112)', () => {
  it('Enter opens the menu on its first item; arrows reach Light, Enter applies it and keeps focus there', () => {
    const { services, button } = setup();
    button.focus();
    // A keyboard Enter on a button is a click with detail 0.
    fireEvent.click(button, { detail: 0 });
    const items = menuItems();
    expect(document.activeElement).toBe(items[0]);
    const light = screen.getByTestId('theme-option-light');
    const menu = screen.getByRole('menu');
    while (document.activeElement !== light && items.includes(document.activeElement as HTMLElement)) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
    }
    expect(document.activeElement).toBe(light);
    fireEvent.click(light, { detail: 0 });
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(light.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(light);
    expect(services.stores.live.getState().status.text).toBe(base.theme.switchedLight);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('ArrowDown / ArrowUp on the closed button open it on the first / last item', () => {
    const { button } = setup();
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowUp' });
    const items = menuItems();
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it('a pointer click opens the menu without moving focus into it', () => {
    const { button } = setup();
    button.focus();
    fireEvent.click(button, { detail: 1 });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(button);
  });
});

describe('UserMenu *Undo last action* (UX section 3.2, C-02)', () => {
  it('offers menu-undo-last while a replaced Undo is still valid, and runs it once', () => {
    const { services, button } = setup();
    let undone = 0;
    act(() => {
      const now = Date.now();
      const undo = (text: string) => ({
        lane: 'own' as const,
        kind: 'undo' as const,
        code: 'toast.deleted',
        text,
        durationMs: 10_000,
        action: { kind: 'undo' as const, label: 'Undo', run: () => (undone += 1) },
      });
      services.stores.toasts.getState().push(undo('Deleted “A”'), now, 1);
      services.stores.toasts.getState().push(undo('Deleted “B”'), now, 1);
    });
    fireEvent.click(button);
    const item = screen.getByTestId('menu-undo-last');
    expect(item.textContent).toContain('Deleted “A”');
    fireEvent.click(item);
    expect(undone).toBe(1);
    expect(services.stores.toasts.getState().lastUndo).toBeNull();
    fireEvent.click(button);
    expect(screen.queryByTestId('menu-undo-last')).toBeNull();
  });

  it('hides menu-undo-last once the replaced Undo has expired', () => {
    const { services, button } = setup();
    act(() => {
      const past = Date.now() - 60_000;
      const undo = {
        lane: 'own' as const,
        kind: 'undo' as const,
        code: 'toast.deleted',
        text: 'Deleted “Old”',
        durationMs: 10_000,
        action: { kind: 'undo' as const, label: 'Undo', run: () => undefined },
      };
      services.stores.toasts.getState().push(undo, past, 1);
      services.stores.toasts.getState().push({ ...undo, text: 'Deleted “New”' }, past, 1);
    });
    fireEvent.click(button);
    expect(screen.queryByTestId('menu-undo-last')).toBeNull();
  });
});
