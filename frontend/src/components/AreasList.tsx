/**
 * Areas in view (UX C-10): the text alternative to the map - the loaded areas intersecting the viewport, sortable,
 * filterable, capped at 200 rendered rows (`areas-list-capped` beyond that). Activating a row flies to the area and
 * opens its details with focus on the heading. On phones it also carries the viewport summary and the centre
 * coordinates (UX C-26, C-27).
 */
import type { KeyboardEvent } from 'react';
import { useRef } from 'react';
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../app/AppContext';
import { LIST_RENDER_CAP } from '../constants/ux';
import { base } from '../base/en';
import { formatArea, formatNumber, formatRelativeTime } from '../lib/format';
import { displayName, displayUser } from '../lib/text';
import type { AreaRecord } from '../state/areasStore';
import { activeLock } from '../state/locksStore';
import type { AreaSort } from '../state/selectors';
import { areasInView, listedAreas, viewportSummary } from '../state/selectors';
import { CoordReadout } from './CoordReadout';
import { Icon } from './Icon';
import { useFocusTarget } from './useFocusTarget';

function ListItem({
  area,
  index,
  now,
  locked,
}: {
  area: AreaRecord;
  index: number;
  now: number;
  locked: string | null;
}) {
  const workspace = useWorkspace();
  const ref = useRef<HTMLButtonElement>(null);
  useFocusTarget('list-item', ref, area.id);
  useFocusTarget('list-item', ref, index === 0 ? undefined : `not-first:${area.id}`);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const item = event.currentTarget.closest('li');
    const sibling = event.key === 'ArrowDown' ? item?.nextElementSibling : item?.previousElementSibling;
    sibling?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  const time = formatRelativeTime(new Date(area.updatedAt), new Date(now));
  return (
    <li>
      <button
        ref={ref}
        type="button"
        className="li"
        data-testid="areas-list-item"
        data-area-id={area.id}
        onKeyDown={onKeyDown}
        onClick={() => {
          workspace.ctx.map()?.flyToBbox(area.bbox);
          workspace.area.select(area.id, 'list');
        }}
      >
        <span className="n" title={area.name}>
          <bdi>{displayName(area.name)}</bdi>
        </span>
        <span className="k num">{formatArea(area.areaKm2)}</span>
        <span className="m">
          {base.list.edited(time, displayUser(area.updatedBy.displayName))}
          {locked === null ? null : (
            <span className="lock">
              <Icon name="lock" size="xs" />
              {base.lock.badge(displayUser(locked))}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The viewport summary (C-26): in the status bar at >= 600 px, at the top of the Areas list on phones. */
export function AnalysisSummary({ variant = 'status' }: { variant?: 'status' | 'list' }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const byId = useStore(stores.areas, (state) => state.byId);
  const viewport = useStore(stores.mapView, (state) => state.viewport);
  const hidden = useStore(stores.effects, (state) => state.hidden);
  const summary = viewportSummary(
    [...byId.values()].filter((area) => !hidden.has(area.id)),
    viewport,
  );
  return (
    <p
      className={`summary summary--${variant} num`}
      data-testid="analysis-summary"
      data-count={summary.count}
      data-total-km2={summary.totalKm2}
      title={base.summary.help}
    >
      {base.summary.inView(summary.count, formatArea(summary.totalKm2))}
    </p>
  );
}

export function AreasList() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const byId = useStore(stores.areas, (state) => state.byId);
  const viewport = useStore(stores.mapView, (state) => state.viewport);
  const hidden = useStore(stores.effects, (state) => state.hidden);
  const sort = useStore(stores.workspace, (state) => state.listSort);
  const filter = useStore(stores.workspace, (state) => state.listFilter);
  const locks = useStore(stores.locks, (state) => state);
  const culled = useStore(stores.notices, (state) => state.load.culledCount);
  const truncated = useStore(stores.notices, (state) => state.load.truncatedShown);
  const meId = useStore(stores.auth, (state) => state.user?.id ?? null);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const phone = usePhone();
  const inView = areasInView(
    [...byId.values()].filter((area) => !hidden.has(area.id)),
    viewport,
  );
  const matching = listedAreas(byId.values(), hidden, viewport, filter, sort);
  const shown = matching.slice(0, LIST_RENDER_CAP);
  return (
    <section className="list-panel" data-testid="areas-list" aria-labelledby="areas-list-title">
      {/* The primary slot's header (UX C-28): the list title as the section's kicker, then Close. */}
      <div className="insp-head insp-head--primary">
        <h2 id="areas-list-title" className="insp-kicker micro list-title" tabIndex={-1}>
          {base.list.title(inView.length)}
        </h2>
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          aria-label={base.list.close}
          onClick={() => {
            workspace.area.toggleList(false);
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="list-body">
        {phone ? (
          <div className="list-status">
            <AnalysisSummary variant="list" />
            <p className="hint">{base.summary.help}</p>
            <CoordReadout mapView={stores.mapView} variant="list" />
          </div>
        ) : null}
        {truncated !== null ? (
          <p className="banner warn">
            <Icon name="zoom-in" />
            <span>{base.map.truncatedNoTotal(formatNumber(truncated))}</span>
          </p>
        ) : null}
        {culled > 0 ? (
          <p className="hint">{base.list.culled(culled >= 10_000 ? '10,000+' : formatNumber(culled))}</p>
        ) : null}
        <div className="list-controls">
          <label className="sr-only" htmlFor="areas-list-filter">
            {base.list.filter}
          </label>
          <input
            id="areas-list-filter"
            className="input"
            type="search"
            placeholder={base.list.filter}
            data-testid="areas-list-filter"
            value={filter}
            dir="auto"
            onChange={(event) => {
              stores.workspace.getState().patch({ listFilter: event.target.value });
            }}
          />
          <label className="select-wrap">
            <span className="sr-only">{base.list.sort}</span>
            <select
              className="select"
              value={sort}
              onChange={(event) => {
                stores.workspace.getState().patch({ listSort: event.target.value as AreaSort });
              }}
            >
              <option value="recent">{base.list.sortRecent}</option>
              <option value="name">{base.list.sortName}</option>
              <option value="size">{base.list.sortSize}</option>
            </select>
          </label>
        </div>
        {inView.length === 0 ? <p className="p-empty">{base.list.empty}</p> : null}
        {inView.length > 0 && matching.length === 0 ? (
          <p className="p-empty">{base.list.filterEmpty(filter)}</p>
        ) : null}
        <ul className="list">
          {shown.map((area, index) => {
            const lock = activeLock(locks, area.id, meId, now);
            return (
              <ListItem
                key={area.id}
                area={area}
                index={index}
                now={now}
                locked={lock?.holder.displayName ?? null}
              />
            );
          })}
        </ul>
        {matching.length > LIST_RENDER_CAP ? (
          <p className="list-capped" data-testid="areas-list-capped">
            {base.list.capped(LIST_RENDER_CAP, formatNumber(matching.length))}{' '}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                workspace.ctx.map()?.zoomBy(1);
              }}
            >
              {base.map.zoomIn}
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
