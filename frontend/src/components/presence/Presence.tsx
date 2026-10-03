/**
 * Presence (UX C-25, section 6.1; UI.md section 10.4): avatars with status badges, the title-bar presence button, the presence
 * rows and a person's name with their colour dot. The rows render in exactly one place at a time (`presence-list`
 * stays unique): the inspector's People section at >= 600 px, the popover on phones.
 */
import type { CSSProperties } from 'react';
import { useCallback, useState } from 'react';
import { useStore } from 'zustand';

import type { UserRef } from '@snapland/shared';
import { useWorkspace } from '../../app/AppContext';
import { PRESENCE_MAX_AVATARS } from '../../constants/ux';
import { base } from '../../base/en';
import { displayName, displayUser, initials } from '../../lib/text';
import type { PresenceUser } from '../../state/presenceStore';
import { groupPresence } from '../../state/presenceStore';
import type { IconName } from '../Icon';
import { Icon } from '../Icon';

/**
 * A person's name after an 8 px dot in their colour (a person's colour is never text on chrome, UI.md section 2.3). My own
 * dot is the accent: "me" reads as one colour (section 2.2).
 */
export function Who({ user, isMe = false }: { user: UserRef; isMe?: boolean }) {
  return (
    <span
      className={`who${isMe ? ' who--me' : ''}`}
      style={{ '--c': user.color } as CSSProperties}
      title={user.displayName}
    >
      <bdi>{displayUser(user.displayName)}</bdi>
    </span>
  );
}

/** Distinct glyphs, so status is never told by colour alone (UX section 6.1). Viewing gets a quiet eye (v2). */
const STATUS_ICON: Record<PresenceUser['status'], IconName | null> = {
  drawing: 'plus',
  editing: 'pencil',
  viewing: 'eye',
  idle: 'clock',
  unknown: null,
};

export function statusText(user: PresenceUser, areaName: (id: string | null) => string | null): string {
  switch (user.status) {
    case 'viewing':
      return base.presence.viewing;
    case 'drawing':
      return base.presence.drawing;
    case 'editing': {
      const name = areaName(user.activeAreaId);
      return name === null ? base.presence.editingUnknown : base.presence.editing(displayName(name));
    }
    case 'idle':
      return base.presence.idle;
    case 'unknown':
      return '';
  }
}

/**
 * A person's disc: initials in ink on their colour. My avatar keeps my presence colour (what others see) and adds the
 * accent ring and an accent badge: "me" reads as one colour (UI.md section 2.2).
 */
export function Avatar({
  user,
  size = 'lg',
  label,
  badge = true,
  entering = false,
  onEntered,
}: {
  user: Pick<PresenceUser, 'displayName' | 'color' | 'status' | 'isMe'>;
  size?: 'lg' | 'md' | 'sm';
  label?: string;
  badge?: boolean;
  /** A person who just joined: the stack eases them in (UI.md section 10.4) and hears when the animation is over. */
  entering?: boolean;
  onEntered?: () => void;
}) {
  const icon = badge ? STATUS_ICON[user.status] : null;
  return (
    <span
      className={`avatar avatar--${size}${user.isMe ? ' avatar--me' : ''}${entering ? ' avatar--entering' : ''}`}
      style={{ '--c': user.color } as CSSProperties}
      title={label}
      aria-hidden={label === undefined}
      onAnimationEnd={entering ? onEntered : undefined}
    >
      {initials(user.displayName)}
      {icon === null ? null : (
        <span className={`avatar__badge avatar__badge--${user.status}`}>
          <Icon name={icon} size="2xs" />
        </span>
      )}
    </span>
  );
}

export function usePresenceUsers(): PresenceUser[] {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const entries = useStore(stores.presence, (presence) => presence.entries);
  const source = useStore(stores.presence, (presence) => presence.source);
  const me = useStore(stores.auth, (auth) => auth.user);
  return groupPresence(entries.values(), me, source);
}

/** The presence rows (`presence-list` / `presence-item`), with the Limited / Offline / only-you notes. */
export function PresenceRows({ users }: { users: PresenceUser[] }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const state = useStore(stores.connection, (connection) => connection.state);
  const areas = useStore(stores.areas, (store) => store.byId);
  const viewport = useStore(stores.mapView, (view) => view.viewport);
  const entries = useStore(stores.presence, (presence) => presence.entries);
  const areaName = (id: string | null): string | null => (id === null ? null : (areas.get(id)?.name ?? null));
  const limited = state === 'limited';
  const offline = state === 'offline';
  const others = users.filter((user) => !user.isMe);
  const inView = (user: PresenceUser): boolean =>
    !user.isMe &&
    viewport !== null &&
    [...entries.values()].some(
      (entry) =>
        entry.userId === user.userId &&
        entry.viewport !== null &&
        entry.viewport.bbox[0] <= viewport[2] &&
        entry.viewport.bbox[2] >= viewport[0] &&
        entry.viewport.bbox[1] <= viewport[3] &&
        entry.viewport.bbox[3] >= viewport[1],
    );
  return (
    <>
      {offline ? <p className="presence-note">{base.presence.unavailable}</p> : null}
      {limited ? <p className="presence-note">{base.presence.limited}</p> : null}
      {offline ? null : (
        <ul className={`presence-list${limited ? ' is-limited' : ''}`} data-testid="presence-list">
          {users.map((user) => {
            const status = statusText(user, areaName);
            const icon = STATUS_ICON[user.status];
            // Drawing / editing icons take the person's colour (mine: the accent); viewing and idle stay quiet.
            const busy = user.status === 'drawing' || user.status === 'editing';
            const iconTone = busy
              ? user.isMe
                ? 'presence-row__icon--me'
                : 'presence-row__icon--person'
              : undefined;
            return (
              <li
                key={user.userId}
                className="presence-row"
                style={{ '--c': user.color } as CSSProperties}
                data-testid="presence-item"
                data-user-id={user.userId}
                data-status={user.status}
                title={`${user.displayName} — ${status}`}
              >
                <Avatar user={user} size="md" badge={!limited} />
                <div className="presence-row__text">
                  <div className="presence-row__name">
                    <bdi>{displayUser(user.displayName)}</bdi>
                    {user.isMe ? <span className="tag-you">{base.presence.you}</span> : null}
                  </div>
                  {status !== '' ? (
                    <div className={`presence-row__status presence-row__status--${user.status}`}>
                      {icon === null ? null : <Icon name={icon} size="xs" className={iconTone} />}
                      <span>{status}</span>
                    </div>
                  ) : null}
                </div>
                {inView(user) ? <span className="presence-row__in-view">In view</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      {!offline && others.length === 0 ? (
        <p className="presence-note presence-note--alone">{base.presence.onlyYou}</p>
      ) : null}
    </>
  );
}

/**
 * The people who joined since the stack last changed membership (UI.md section 10.4 animates joins only). The stack re-sorts
 * on every status change (me, then busy, then by name) and React moves keyed avatars with `insertBefore`, which would
 * restart a CSS animation left on them; an avatar that comes back into the four shown slots is not a join either. So
 * a person carries the entering class only until their join animation ends, and the first render animates nobody.
 */
function useNewcomers(ids: readonly string[]): {
  newcomers: ReadonlySet<string>;
  entered: (id: string) => void;
} {
  const key = [...ids].sort().join('|');
  const [seen, setSeen] = useState<{ key: string; newcomers: ReadonlySet<string> } | null>(null);
  let current = seen;
  if (current?.key !== key) {
    // Membership changed: remember it during render (React's "store information from previous renders" pattern).
    const before = current === null ? null : new Set(current.key === '' ? [] : current.key.split('|'));
    current = { key, newcomers: new Set(before === null ? [] : ids.filter((id) => !before.has(id))) };
    setSeen(current);
  }
  const entered = useCallback((id: string) => {
    setSeen((state) =>
      state?.newcomers.has(id) === true
        ? { ...state, newcomers: new Set([...state.newcomers].filter((other) => other !== id)) }
        : state,
    );
  }, []);
  return { newcomers: current.newcomers, entered };
}

/**
 * The title-bar presence button (`presence-button`): avatars + "{n} online" at >= 600 px, a count button on phones.
 * It shows the People section (phones: toggles the popover) - `Workspace.showPeople`.
 */
export function PresenceButton({ phone }: { phone: boolean }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const open = useStore(stores.workspace, (ws) => ws.presenceOpen);
  const changes = useStore(stores.presence, (presence) => presence.changesCounter);
  const state = useStore(stores.connection, (connection) => connection.state);
  const users = usePresenceUsers();
  const count = Math.max(1, users.length);
  const label = `${phone ? base.presence.count(count) : base.presence.button(count)}${
    changes > 0 ? `, ${base.presence.changesCounter(changes)}` : ''
  }`;
  const shown = users.slice(0, PRESENCE_MAX_AVATARS);
  const more = users.length - shown.length;
  const { newcomers, entered } = useNewcomers(users.map((user) => user.userId));
  const limited = state === 'limited';
  return (
    <div className="presence-wrap">
      <button
        type="button"
        className={phone ? 'hit presence-count-hit' : 'presence-btn'}
        data-testid="presence-button"
        data-changes={changes}
        data-offline={state === 'offline' ? 'true' : undefined}
        aria-label={label}
        aria-expanded={phone ? open : undefined}
        onClick={(event) => {
          workspace.showPeople(event.detail === 0);
        }}
      >
        {phone ? (
          <span className="presence-count">
            <Icon name="users" size="lg" />
            <span className="num">{count}</span>
            {changes > 0 ? <span className="presence-count__dot" aria-hidden="true" /> : null}
          </span>
        ) : (
          <>
            <span className="avatar-stack">
              {shown.map((user) => (
                <Avatar
                  key={user.userId}
                  user={user}
                  badge={!limited}
                  entering={newcomers.has(user.userId)}
                  onEntered={() => {
                    entered(user.userId);
                  }}
                />
              ))}
              {more > 0 ? <span className="avatar avatar--lg avatar--more num">+{more}</span> : null}
            </span>
            <span className="presence-online">{base.presence.online(count)}</span>
            {changes > 0 ? (
              <span className="changes-count num">{base.presence.changesCounter(changes)}</span>
            ) : null}
          </>
        )}
      </button>
      {phone && open ? (
        <div className="popover presence-pop" role="dialog" aria-label={base.presence.header}>
          <div className="pop-head">
            <span className="micro">{base.presence.header}</span>
            <span className="count-tag num">{users.length}</span>
          </div>
          <PresenceRows users={users} />
        </div>
      ) : null}
    </div>
  );
}
