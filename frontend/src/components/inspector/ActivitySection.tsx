/**
 * The Activity section (UX C-31): a quiet, pull-only list of other people's in-scope changes this session, newest
 * first. Each row can *Show* the area (select it and fit the map, like an Areas-list item) while the area still
 * exists. The header says when collaboration toasts are being held (section 6.5). Not a live region: announcements stay
 * with the `collab` region.
 */
import type { MouseEvent } from 'react';
import { useStore } from 'zustand';

import { useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { formatAbsoluteTime, formatArea, formatRelativeTime } from '../../lib/format';
import type { ActivityItem } from '../../state/activityStore';
import { isWorkingMode, sectionExpanded } from '../../state/workspaceStore';
import { Icon } from '../Icon';
import { Avatar } from '../presence/Presence';
import { SectionHeader } from './SectionHeader';

/**
 * Line 1 is the text a single-event collaboration toast would show, in secondary, with the quoted area names in the
 * text colour (UI.md section 10.8.6). Each name is isolated with <bdi> so a Hebrew name never reorders the sentence
 * (UX section 9.12); the text itself is unchanged.
 */
function ActivityText({ text }: { text: string }) {
  // Splitting on a capturing group keeps the names: they are the odd parts. The parts never reorder, so their
  // position is a stable key.
  const parts = text.split(/(“[^”]*”)/u);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <bdi key={index} className="activity-row__name">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}

function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const area = useStore(stores.areas, (state) => state.byId.get(item.areaId));
  const mode = useStore(stores.workspace, (state) => state.mode);
  const at = new Date(item.at);
  const time = formatRelativeTime(at, new Date(now));
  const busy = mode !== 'browse' && mode !== 'area-selected';
  const show = (event: MouseEvent): void => {
    if (area === undefined || busy) return;
    workspace.ctx.map()?.flyToBbox(area.bbox);
    workspace.area.select(area.id, event.detail === 0 ? 'keyboard' : 'map');
  };
  return (
    <li
      className="activity-row"
      data-testid="activity-item"
      data-area-id={item.areaId}
      data-user-id={item.actor.id}
      data-code={item.code}
    >
      <Avatar
        user={{
          displayName: item.actor.displayName,
          color: item.actor.color,
          status: 'unknown',
          isMe: false,
        }}
        size="md"
        badge={false}
      />
      <div className="activity-row__text">
        {/* One line, ellipsized: the full text stays reachable on hover (UX section 9.14). */}
        <p className="activity-row__line" title={item.text}>
          <ActivityText text={item.text} />
        </p>
        <p className="activity-row__meta num" title={formatAbsoluteTime(at)}>
          {item.areaKm2 === null ? time : base.activity.meta(formatArea(item.areaKm2), time)}
        </p>
      </div>
      {/* Only while the area exists: never on a delete row, and gone once the area is deleted (UX C-31). */}
      {area === undefined ? null : (
        <button
          type="button"
          className="btn-text"
          data-testid="activity-show"
          aria-disabled={busy ? true : undefined}
          aria-description={busy ? base.draw.busy : undefined}
          onClick={show}
        >
          {base.toast.show}
        </button>
      )}
    </li>
  );
}

export function ActivitySection() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const items = useStore(stores.activity, (state) => state.items);
  const expanded = useStore(stores.workspace, (state) => sectionExpanded(state, 'activity'));
  const mode = useStore(stores.workspace, (state) => state.mode);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  // Collaboration toasts are held in Drawing, Naming and EditingShape (section 6.5); the note stays visible when collapsed.
  const held = isWorkingMode(mode);
  const note = mode === 'editing-shape' ? base.activity.heldNoteEdit : base.activity.heldNote;
  return (
    <section className="insp-section" data-testid="activity-section" data-expanded={expanded}>
      <SectionHeader
        label={base.inspector.activity}
        count={items.length}
        expanded={expanded}
        bodyId="activity-body"
        testId="activity-toggle"
        onToggle={() => {
          workspace.toggleSection('activity');
        }}
        trailing={
          held ? (
            <span className="held-note" data-testid="activity-held-note" title={base.activity.heldHelp}>
              <Icon name="bell-off" size="xs" />
              {note}
            </span>
          ) : null
        }
      />
      <div id="activity-body" className="insp-body insp-body--list" hidden={!expanded}>
        {!expanded ? null : items.length === 0 ? (
          <p className="insp-empty" data-testid="activity-empty">
            {base.activity.empty}
          </p>
        ) : (
          <ul className="activity-list">
            {items.map((item) => (
              <ActivityRow key={item.id} item={item} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
