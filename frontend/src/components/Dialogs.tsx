/**
 * The workspace dialogs (UX C-20 ... C-23): deleted while editing, session expired / signed out elsewhere, sign out
 * with unsaved work, and the keyboard shortcuts. All are modal; only the shortcuts and sign-out dialogs close with
 * `Esc` (C-21 cannot be dismissed; C-20's `Esc` keeps editing).
 */
import type { SyntheticEvent } from 'react';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';

import { useServices, useWorkspace } from '../app/AppContext';
import type { AuthFailure } from '../auth/authErrors';
import { classifyAuthError, summaryText } from '../auth/authErrors';
import { base } from '../base/en';
import { formatCountdown } from '../lib/format';
import { displayName, displayUser } from '../lib/text';
import { PasswordInput } from '../auth/LoginPage';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function DeletedWhileEditingDialog() {
  const workspace = useWorkspace();
  const dialog = useStore(workspace.ctx.stores.workspace, (state) => state.deletedWhileEditing);
  const primary = useRef<HTMLButtonElement>(null);
  if (dialog === null) return null;
  const canRestore = workspace.conflict.canRestore();
  const fullUser = dialog.deletedBy?.displayName ?? base.collab.someone;
  const fullTitle = base.deletedWhileEditing.title(fullUser, dialog.name);
  return (
    <Dialog
      role="alertdialog"
      testId="deleted-while-editing-dialog"
      title={base.deletedWhileEditing.title(displayUser(fullUser), displayName(dialog.name))}
      titleTitle={fullTitle}
      initialFocus={primary}
      onEscape={() => {
        workspace.conflict.dismissDeletedDialog();
      }}
    >
      <p className="dialog-body">
        {canRestore
          ? base.deletedWhileEditing.body
          : base.deletedWhileEditing.bodyNoRestore(displayUser(dialog.creatorName ?? base.collab.someone))}
      </p>
      <div className="foot foot--stack">
        {canRestore ? (
          <button
            ref={primary}
            type="button"
            className="btn btn-primary"
            data-testid="dwe-restore"
            aria-disabled={dialog.busy}
            onClick={() => {
              workspace.conflict.restoreWithMine();
            }}
          >
            {base.deletedWhileEditing.restore}
          </button>
        ) : null}
        <button
          ref={canRestore ? undefined : primary}
          type="button"
          className={canRestore ? 'btn btn-secondary' : 'btn btn-primary'}
          data-testid="dwe-save-new"
          aria-disabled={dialog.busy}
          onClick={() => {
            workspace.conflict.saveAsNew();
          }}
        >
          {base.deletedWhileEditing.saveNew}
        </button>
        <button
          type="button"
          className="btn btn-danger-ghost"
          data-testid="dwe-discard"
          onClick={() => {
            workspace.conflict.discardDeleted();
          }}
        >
          {base.deletedWhileEditing.discard}
        </button>
      </div>
    </Dialog>
  );
}

/** C-21: sign in again without losing anything (UX F-11). */
export function SessionExpiredDialog({
  onSignedIn,
  onSignOut,
}: {
  onSignedIn: () => void;
  onSignOut: () => void;
}) {
  const services = useServices();
  const problem = useStore(services.stores.auth, (state) => state.sessionProblem);
  const user = useStore(services.stores.auth, (state) => state.user);
  const now = useStore(services.clock.store, (state) => state.now);
  // "Sign out instead" / "Sign in as someone else" open C-22 on top; *Keep working* there returns to this dialog.
  const confirmingSignOut = useStore(services.stores.workspace, (state) => state.signOutConfirmOpen);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  if (problem === null || user === null || confirmingSignOut) return null;
  const revoked = problem === 'revoked';
  const remaining = lockedUntil === null ? 0 : lockedUntil - now;
  const locked = remaining > 0;
  const summary =
    failure === null || (failure.kind === 'rate-limited' && !locked)
      ? null
      : summaryText(failure, formatCountdown(remaining));

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || locked) return;
    if (password === '') {
      setFailure(null);
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const response = await services.api.auth.login({ username: user.username, password });
      services.adopt(response);
      setPassword('');
      onSignedIn();
    } catch (error) {
      const result = classifyAuthError(error, { password });
      setFailure(result);
      if (result.kind === 'rate-limited') {
        services.clock.store.getState().tick();
        setLockedUntil(services.scheduler.now() + result.retryAfterMs);
      }
      if (result.kind === 'bad-credentials') {
        setPassword('');
        passwordRef.current?.focus();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      role="alertdialog"
      testId="session-expired-dialog"
      title={revoked ? base.session.revokedTitle : base.session.title}
      initialFocus={passwordRef}
      attributes={{ 'data-variant': revoked ? 'revoked' : 'expired' }}
    >
      <p className="dialog-body">{revoked ? base.session.revokedBody : base.session.body}</p>
      {summary !== null ? (
        <div className="banner danger" role="alert" data-testid="auth-error">
          <Icon name="circle-alert" />
          <span>{summary}</span>
        </div>
      ) : null}
      <form
        className="auth-form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="field">
          <label className="label" htmlFor="session-username">
            {base.auth.username}
          </label>
          <input
            id="session-username"
            className="input"
            name="username"
            autoComplete="username"
            value={user.username}
            readOnly
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="session-password">
            {base.auth.password}
          </label>
          <PasswordInput
            ref={passwordRef}
            id="session-password"
            name="password"
            autoComplete="current-password"
            data-testid="password-input"
            value={password}
            readOnly={submitting}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary btn-lg btn-block"
          aria-disabled={submitting || locked}
        >
          {submitting ? <span className="spinner" aria-hidden="true" /> : null}
          {base.session.submit}
        </button>
      </form>
      <div className="dialog-links">
        <button type="button" className="link" onClick={onSignOut}>
          {base.session.switchUser}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link" onClick={onSignOut}>
          {base.session.signOut}
        </button>
      </div>
    </Dialog>
  );
}

/** C-22: the only destructive confirmation in the app. */
export function SignOutConfirmDialog() {
  const workspace = useWorkspace();
  const open = useStore(workspace.ctx.stores.workspace, (state) => state.signOutConfirmOpen);
  const keep = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  const close = (): void => {
    workspace.ctx.stores.workspace.getState().patch({ signOutConfirmOpen: false });
  };
  return (
    <Dialog
      role="alertdialog"
      testId="signout-confirm-dialog"
      title={base.signout.title}
      initialFocus={keep}
      onEscape={close}
    >
      <p className="dialog-body">{base.signout.body}</p>
      <div className="foot">
        <button
          type="button"
          className="btn btn-danger-ghost"
          onClick={() => {
            void workspace.signOut(true);
          }}
        >
          {base.signout.confirm}
        </button>
        <button ref={keep} type="button" className="btn btn-primary" onClick={close}>
          {base.signout.keep}
        </button>
      </div>
    </Dialog>
  );
}

const SHORTCUT_GROUPS: readonly { title: string; rows: readonly [string, string][] }[] = [
  {
    title: 'Global',
    rows: [
      ['D', 'Start drawing (again = cancel)'],
      ['L', 'Switch between Map and Aerial'],
      ['A', 'Areas in view'],
      ['P', 'Who is on the map'],
      ['?', 'Keyboard shortcuts'],
      ['Esc', 'Close the topmost layer'],
      ['Ctrl+Z', 'Undo'],
    ],
  },
  {
    title: 'Map focused',
    rows: [
      ['Arrows', 'Pan (Shift: fine)'],
      ['+ / −', 'Zoom in / out'],
    ],
  },
  {
    title: 'Drawing',
    rows: [
      ['Space', 'Add a point at the crosshair'],
      ['Enter', 'Finish'],
      ['Backspace', 'Undo last point'],
      ['Esc', 'Cancel drawing'],
    ],
  },
  {
    title: 'Area selected',
    rows: [
      ['E', 'Edit shape'],
      ['F2', 'Rename'],
      ['Delete', 'Delete (creator or admin)'],
      ['H', 'History'],
      ['Z', 'Zoom to area'],
    ],
  },
  {
    title: 'Editing shape',
    rows: [
      [']  /  [', 'Next / previous point'],
      ['Arrows', 'Move the selected point (Shift: 1 px)'],
      ['Delete', 'Delete the selected point'],
      ['I', 'Insert a point after the selected one'],
      ['Enter', 'Save changes'],
    ],
  },
];

/** C-23: the keyboard map plus the single-key shortcut switch (WCAG 2.1.4). */
export function ShortcutsDialog() {
  const workspace = useWorkspace();
  const store = workspace.ctx.stores.workspace;
  const open = useStore(store, (state) => state.shortcutsOpen);
  const singleKeys = useStore(store, (state) => state.singleKeyShortcuts);
  const close = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  const dismiss = (): void => {
    store.getState().patch({ shortcutsOpen: false });
  };
  return (
    <Dialog
      testId="shortcuts-dialog"
      title={base.shortcuts.title}
      initialFocus={close}
      onEscape={dismiss}
      wide
    >
      <label className="switch-row">
        <span className="switch-row__text">
          <b>{base.shortcuts.singleKeys}</b>
          <span className="hint">{base.shortcuts.singleKeysHelp}</span>
        </span>
        {/* The native checkbox keeps role, state and keyboard; the track beside it is its visible face. */}
        <input
          className="switch-input"
          type="checkbox"
          role="switch"
          data-testid="single-key-toggle"
          checked={singleKeys}
          onChange={(event) => {
            store.getState().patch({ singleKeyShortcuts: event.target.checked });
          }}
        />
        <span className={singleKeys ? 'switch switch--on' : 'switch'} aria-hidden="true" />
      </label>
      <div className="sc-grid">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="sc-group">
            <h3>{group.title}</h3>
            <dl>
              {group.rows.map(([keys, action]) => (
                <div key={`${group.title}-${keys}`} className="sc-row">
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="foot">
        <button ref={close} type="button" className="btn btn-secondary" onClick={dismiss}>
          {base.shortcuts.close}
        </button>
      </div>
    </Dialog>
  );
}
