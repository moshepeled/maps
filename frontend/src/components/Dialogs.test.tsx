/**
 * Workspace dialogs in the Studio style (UX C-22, C-23; UI.md section 10.12): the safe choice is the primary and takes
 * focus, the destructive one is a danger-ghost; the single-key switch keeps its native semantics under the drawn
 * track, and the long shortcuts list opens with Close focused.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ServicesProvider, WorkspaceProvider } from '../app/AppContext';
import { createAppServices } from '../app/services';
import { base } from '../base/en';
import { systemScheduler } from '../lib/scheduler';
import { FakeSocket } from '../test/fakeSocket';
import { signedIn } from '../test/workspaceHarness';
import { Workspace } from '../workspace/Workspace';
import { ShortcutsDialog, SignOutConfirmDialog } from './Dialogs';

afterEach(cleanup);

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
        <SignOutConfirmDialog />
        <ShortcutsDialog />
      </WorkspaceProvider>
    </ServicesProvider>,
  );
  return services.stores.workspace;
}

describe('Sign out with unsaved work (UX C-22)', () => {
  it('Keep working is the primary with initial focus; Discard and sign out is a danger-ghost; Esc keeps working', () => {
    const store = setup();
    act(() => {
      store.getState().patch({ signOutConfirmOpen: true });
    });
    const keep = screen.getByRole('button', { name: base.signout.keep });
    const discard = screen.getByRole('button', { name: base.signout.confirm });
    expect(keep.classList.contains('btn-primary')).toBe(true);
    expect(discard.classList.contains('btn-danger-ghost')).toBe(true);
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(screen.getByTestId('signout-confirm-dialog'), { key: 'Escape' });
    expect(store.getState().signOutConfirmOpen).toBe(false);
  });
});

describe('Keyboard shortcuts (UX C-23)', () => {
  it('the single-key switch is a native role=switch checkbox drawn as a track, and it toggles the preference', () => {
    const store = setup();
    act(() => {
      store.getState().patch({ shortcutsOpen: true });
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: base.shortcuts.close }));
    const toggle = screen.getByTestId('single-key-toggle');
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.nextElementSibling?.className).toBe('switch switch--on');
    fireEvent.click(toggle);
    expect(store.getState().singleKeyShortcuts).toBe(false);
    expect(toggle.nextElementSibling?.className).toBe('switch');
  });
});
