/**
 * Toasts (UX C-18, UI.md section 10.11): two lanes - my own results (max 3; phones 1) and collaboration (max 1). Timers
 * pause on hover, on focus inside the toast and while the tab is hidden (WCAG 2.2.1); errors and countdowns persist.
 * Toasts never take focus; their actions are reachable by Tab and by `Ctrl/Cmd+Z` (Undo).
 */
import type { CSSProperties, MouseEvent } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';

import { usePhone, useServices } from '../app/AppContext';
import { base } from '../base/en';
import { formatCountdown } from '../lib/format';
import type { Toast } from '../state/toastsStore';
import type { IconName } from './Icon';
import { Icon } from './Icon';
import { Avatar } from './presence/Presence';

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => {
    document.removeEventListener('visibilitychange', onChange);
  };
}

function useTabHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'hidden',
    () => false,
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);

/** Undo-able results lead with the icon of what was undone (UI.md section 10.11); anything else undo-able restored a version. */
const UNDO_ICON: Readonly<Record<string, IconName>> = {
  'toast.deleted': 'trash-2',
  'toast.drawingDiscarded': 'snap-polygon',
  'toast.changesDiscarded': 'vector-square',
};

/** Info toasts that report a finished action of mine; the rest (refusals, notes) get the neutral info mark. */
const SUCCESS_CODES = new Set([
  'toast.saved',
  'toast.editSaved',
  'toast.renamed',
  'toast.undeleted',
  'toast.backOnline',
  'toast.backOnlineNoChanges',
]);

/** The leading icon and its tone per toast kind (UI.md section 10.11). */
function leadingIcon(toast: Toast): {
  name: IconName;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
} {
  switch (toast.kind) {
    case 'error':
      return { name: 'circle-alert', tone: 'danger' };
    case 'countdown':
      return { name: 'clock', tone: 'warning' };
    case 'undo':
      return { name: UNDO_ICON[toast.code] ?? 'rotate-ccw', tone: 'neutral' };
    case 'info':
    case 'collab':
      if (SUCCESS_CODES.has(toast.code)) return { name: 'circle-check', tone: 'success' };
      return { name: toast.code.startsWith('toast.autoMerged') ? 'git-merge' : 'info', tone: 'info' };
  }
}

/**
 * A trailing value after the last middle-dot separator (the area or the version, as in a "Saved" toast) is set in
 * secondary mono (UI.md section 10.11); the text itself is unchanged. Only a tail after the last quoted name counts, so
 * a separator inside a name never splits.
 */
function Message({ text }: { text: string }) {
  const at = text.lastIndexOf(' · ');
  if (at === -1 || text.includes('”', at)) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="msg__value num"> · {text.slice(at + 3)}</span>
    </>
  );
}

function ToastItem({ toast, phone }: { toast: Toast; phone: boolean }) {
  const services = useServices();
  const now = useStore(services.clock.store, (state) => state.now);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hidden = useTabHidden();
  const remaining = useRef<number | null>(toast.durationMs);
  const startedAt = useRef(0);
  const paused = hovered || focused || hidden;

  useEffect(() => {
    remaining.current = toast.durationMs;
  }, [toast.durationMs]);

  useEffect(() => {
    const left = remaining.current;
    if (paused || left === null) return undefined;
    startedAt.current = services.scheduler.now();
    const handle = services.scheduler.setTimeout(() => {
      services.stores.toasts.getState().dismiss(toast.id);
    }, left);
    return () => {
      services.scheduler.clearTimeout(handle);
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (services.scheduler.now() - startedAt.current));
      }
    };
  }, [paused, toast.id, toast.durationMs, services]);

  const countdown =
    toast.countdownUntil !== undefined && toast.countdownText !== undefined
      ? toast.countdownText(formatCountdown(toast.countdownUntil - now))
      : null;
  const text = countdown ?? (phone && toast.shortText !== undefined ? toast.shortText : toast.text);
  const icon = leadingIcon(toast);
  const action = toast.action;
  const run = (event: MouseEvent<HTMLButtonElement>): void => {
    if (action === undefined) return;
    const workspace = services.stores.workspace;
    const pendingFocus = workspace.getState().focusRequest;
    services.stores.toasts.getState().dismiss(toast.id);
    action.run(event.detail === 0);
    // The toast leaves with its focused button: unless the action sent focus somewhere, the map takes it (UX section 8.3).
    if (workspace.getState().focusRequest === pendingFocus) workspace.getState().requestFocus('map');
  };

  return (
    <div
      className={`toast toast--${toast.kind}`}
      data-testid="toast"
      data-kind={toast.kind}
      data-code={toast.code}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {toast.actor !== undefined ? (
        <Avatar user={{ ...toast.actor, status: 'unknown', isMe: false }} size="sm" badge={false} />
      ) : (
        <Icon name={icon.name} className={`toast__icon toast__icon--${icon.tone}`} />
      )}
      <p className="msg">
        <Message text={text} />
        {action?.kind === 'undo' ? (
          <span className="sr-only"> {IS_MAC ? 'Press Command Z to undo.' : 'Press Control Z to undo.'}</span>
        ) : null}
      </p>
      {action !== undefined ? (
        <button type="button" className="t-action" data-testid={`toast-${action.kind}`} onClick={run}>
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="t-close"
        aria-label={base.toast.dismiss}
        data-testid="toast-dismiss"
        onClick={() => {
          services.stores.toasts.getState().dismiss(toast.id);
        }}
      >
        <Icon name="x" size="sm" />
      </button>
      {toast.durationMs !== null && action !== undefined && countdown === null ? (
        // The time left of a timed action (UX C-18 v2). It freezes with the timer (hover, focus, hidden tab), so it
        // never shows less time than the toast really has; reduced motion removes the animation (CSS).
        <span className="toast-timer" aria-hidden="true">
          <span
            className="toast-countdown"
            data-testid="toast-countdown"
            style={
              {
                '--toast-duration': `${toast.durationMs}ms`,
                animationPlayState: paused ? 'paused' : 'running',
              } as CSSProperties
            }
            aria-hidden="true"
          />
        </span>
      ) : null}
    </div>
  );
}

export function Toasts() {
  const services = useServices();
  const toasts = useStore(services.stores.toasts, (state) => state.toasts);
  const phone = usePhone();
  const own = toasts.filter((toast) => toast.lane === 'own');
  const collab = toasts.filter((toast) => toast.lane === 'collab');
  return (
    <section className="toasts" role="region" aria-label={base.a11y.notifications}>
      <div className="lane lane--collab">
        {collab.slice(-1).map((toast) => (
          <ToastItem key={toast.id} toast={toast} phone={phone} />
        ))}
      </div>
      <div className="lane lane--own">
        {/* The store already keeps one own toast on phones (toastsStore `ownMax`). */}
        {own.map((toast) => (
          <ToastItem key={toast.id} toast={toast} phone={phone} />
        ))}
      </div>
    </section>
  );
}
