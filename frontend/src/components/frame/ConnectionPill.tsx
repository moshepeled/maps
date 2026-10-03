/**
 * The connection pill (UX C-16; UI.md section 10.3): a text label in every state (short labels below 600 px, the full state
 * in `aria-label`), inside a transparent hit wrapper, with a detail popover and *Reconnect now*.
 */
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import type { ConnectionState } from '../../realtime/RealtimeClient';
import { Icon } from '../Icon';

const FULL_LABEL: Record<ConnectionState, string> = {
  connecting: base.conn.connecting,
  live: base.conn.live,
  reconnecting: base.conn.reconnecting,
  limited: base.conn.limited,
  offline: base.conn.offline,
  'signed-out': base.conn.signedOut,
};

const PILL_TONE: Record<ConnectionState, string> = {
  connecting: 'neutral',
  live: 'live',
  reconnecting: 'warning',
  limited: 'warning',
  offline: 'danger',
  'signed-out': 'neutral',
};

export function ConnectionPill() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const state = useStore(stores.connection, (connection) => connection.state);
  const nextRetryAt = useStore(stores.connection, (connection) => connection.nextRetryAt);
  const open = useStore(stores.workspace, (ws) => ws.connectionPopoverOpen);
  const now = useStore(workspace.ctx.clock, (clock) => clock.now);
  const phone = usePhone();
  const full = FULL_LABEL[state];
  const detail =
    state === 'live'
      ? base.conn.liveDetail
      : state === 'reconnecting'
        ? base.conn.reconnectingDetail(Math.max(0, Math.ceil(((nextRetryAt ?? now) - now) / 1000)))
        : state === 'limited'
          ? base.conn.limitedDetail(5)
          : state === 'offline'
            ? base.conn.offlineDetail
            : null;
  const toggle = (): void => {
    stores.workspace
      .getState()
      .patch({ connectionPopoverOpen: !open, presenceOpen: false, userMenuOpen: false });
  };
  return (
    <div className="pill-wrap">
      <button
        type="button"
        className="hit pill-hit"
        data-testid="connection-status"
        data-state={state}
        aria-label={base.conn.ariaLabel(full)}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={`pill pill--${PILL_TONE[state]}`}>
          {state === 'live' ? <span className="pill__dot" aria-hidden="true" /> : null}
          {state === 'reconnecting' || state === 'connecting' ? (
            <span className="spinner xs" aria-hidden="true" />
          ) : null}
          {state === 'limited' ? <Icon name="cloud-off" size="sm" /> : null}
          {state === 'offline' ? <Icon name="wifi-off" size="sm" /> : null}
          {state === 'signed-out' ? <Icon name="lock" size="sm" /> : null}
          <span>{phone ? base.conn.short[state] : full}</span>
        </span>
      </button>
      {open && detail !== null ? (
        <div className="popover pill-pop" role="dialog" aria-label={full}>
          <p className="pop-title">{full}</p>
          <p className="pop-text">{detail}</p>
          {state === 'reconnecting' || state === 'limited' ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                workspace.retryConnectionNow();
                stores.workspace.getState().patch({ connectionPopoverOpen: false });
              }}
            >
              <Icon name="refresh-cw" />
              {base.conn.reconnectNow}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
