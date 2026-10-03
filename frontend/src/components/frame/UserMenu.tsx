/**
 * The user menu (UX C-02, C-30, F-15; UI.md section 10.2): display name and username, *Keyboard shortcuts*, *Quiet mode*,
 * the *Theme* group (Dark / Light, `menuitemradio`), *Undo last action* while one is still valid, and *Sign out*.
 * A menu button with arrow-key navigation; `Esc` closes it and returns focus to the button. Choosing a theme keeps
 * the menu open with focus on the chosen item, like *Quiet mode*.
 */
import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { displayUser } from '../../lib/text';
import type { Theme } from '../../theme/theme';
import { themeController } from '../../theme/theme';
import { useTheme } from '../../theme/useTheme';
import type { IconName } from '../Icon';
import { Icon } from '../Icon';

const THEME_OPTIONS: { theme: Theme; label: string; icon: IconName; testId: string }[] = [
  { theme: 'dark', label: base.menu.themeDark, icon: 'moon', testId: 'theme-option-dark' },
  { theme: 'light', label: base.menu.themeLight, icon: 'sun', testId: 'theme-option-light' },
];

/** The *Theme* group (C-30): exactly one option checked; a change is announced once through `status`. */
function ThemeSwitch() {
  const workspace = useWorkspace();
  const theme = useTheme();
  const choose = (next: Theme): void => {
    if (next === theme) return;
    themeController().set(next);
    workspace.ctx.stores.live
      .getState()
      .announce('status', next === 'light' ? base.theme.switchedLight : base.theme.switchedDark);
  };
  return (
    <div className="menu-group" role="group" aria-label={base.menu.theme} data-testid="theme-switch">
      <div className="menu-group__label" aria-hidden="true">
        {base.menu.theme}
      </div>
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.theme}
          type="button"
          role="menuitemradio"
          aria-checked={theme === option.theme}
          className="menu-item"
          data-testid={option.testId}
          onClick={() => {
            choose(option.theme);
          }}
        >
          <Icon name={option.icon} />
          <span className="grow">{option.label}</span>
          {theme === option.theme ? <Icon name="check" className="menu-item__check" /> : null}
        </button>
      ))}
    </div>
  );
}

export function UserMenu() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const open = useStore(stores.workspace, (ws) => ws.userMenuOpen);
  const quiet = useStore(stores.workspace, (ws) => ws.quietMode);
  const user = useStore(stores.auth, (auth) => auth.user);
  const lastUndo = useStore(stores.toasts, (toasts) => toasts.lastUndo);
  const now = useStore(workspace.ctx.clock, (clock) => clock.now);
  const phone = usePhone();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Opened from the keyboard: the item to focus once the menu is rendered (APG menu button). */
  const focusOnOpen = useRef<'first' | 'last' | null>(null);
  const menuItems = (): HTMLElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  useEffect(() => {
    const target = focusOnOpen.current;
    focusOnOpen.current = null;
    if (!open || target === null) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    (target === 'first' ? items[0] : items.at(-1))?.focus();
  }, [open]);
  const openMenu = (focus: 'first' | 'last' | null): void => {
    focusOnOpen.current = focus;
    stores.workspace
      .getState()
      .patch({ userMenuOpen: true, presenceOpen: false, connectionPopoverOpen: false });
  };
  const close = (refocus: boolean): void => {
    stores.workspace.getState().patch({ userMenuOpen: false });
    if (refocus) button.current?.focus();
  };
  /** `↓` / `↑` on the button open the menu on its first / last item, or move into an open one (C-02). */
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const target = event.key === 'ArrowDown' ? 'first' : 'last';
    if (!open) {
      openMenu(target);
      return;
    }
    const items = menuItems();
    (target === 'first' ? items[0] : items.at(-1))?.focus();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items.at(-1))?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  const undoAvailable = lastUndo !== null && lastUndo.expiresAt > now;
  return (
    <div className="menu-wrap">
      <button
        ref={button}
        type="button"
        className={phone ? 'icon-btn menu-btn' : 'user-btn'}
        data-testid="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={phone ? (quiet ? base.menu.labelQuiet : base.menu.label) : undefined}
        onKeyDown={onButtonKey}
        onClick={(event) => {
          // Enter / Space arrive as a click with `detail` 0: the keyboard lands on the first item.
          if (open) close(false);
          else openMenu(event.detail === 0 ? 'first' : null);
        }}
      >
        {phone ? <Icon name="menu" size="lg" /> : <bdi>{displayUser(user?.displayName ?? '')}</bdi>}
        {phone ? null : <Icon name="chevron-down" size="sm" className="user-btn__chevron" />}
        {phone && quiet ? (
          <span className="menu-badge" data-testid="quiet-chip" aria-hidden="true">
            <Icon name="bell-off" size="2xs" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={menu}
          className="popover menu"
          role="menu"
          aria-label={base.menu.label}
          onKeyDown={onMenuKey}
        >
          <div className="menu-user">
            <b>
              <bdi>{user?.displayName}</bdi>
            </b>
            <span>{user?.username}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close(false);
              stores.workspace.getState().patch({ shortcutsOpen: true });
            }}
          >
            <Icon name="keyboard" />
            <span className="grow">{base.menu.shortcuts}</span>
            <kbd aria-hidden="true">?</kbd>
          </button>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={quiet}
            className="menu-item"
            data-testid="quiet-toggle"
            onClick={() => {
              stores.workspace.getState().patch({ quietMode: !quiet });
            }}
          >
            <Icon name="bell-off" />
            <span className="grow">{base.menu.quietMode}</span>
            <span className={`switch${quiet ? ' switch--on' : ''}`} aria-hidden="true" />
          </button>
          <p className="menu-help">{base.menu.quietModeHelp}</p>
          <ThemeSwitch />
          {undoAvailable ? (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid="menu-undo-last"
              onClick={(event) => {
                close(false);
                stores.toasts.getState().clearLastUndo();
                lastUndo.run(event.detail === 0);
              }}
            >
              <Icon name="undo-2" />
              <span className="grow">
                {base.menu.undoLast}
                <span className="menu-sub">{lastUndo.text}</span>
              </span>
            </button>
          ) : null}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close(false);
              workspace.requestSignOut();
            }}
          >
            <Icon name="log-out" />
            <span className="grow">{base.menu.signOut}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
