/**
 * The History list (UX C-13, F-07; UI.md section 10.8.3): a timeline of versions, each a button in a list with a roving
 * `↑` / `↓`; activating one previews it (`aria-current`), with the preview banner (*Restore this version*,
 * *Exit preview*) at the top. v2 renders it in the inspector's History section and in the phone sheet.
 */
import type { CSSProperties, KeyboardEvent } from 'react';
import { useRef } from 'react';
import { useStore } from 'zustand';

import type { AreaVersionDto } from '@snapland/shared';
import { useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import { formatAbsoluteTime, formatArea, formatCountdown, formatRelativeTime } from '../lib/format';
import { displayName } from '../lib/text';
import { Icon } from './Icon';
import { Who } from './presence/Presence';
import { useFocusTarget } from './useFocusTarget';

function changeSummary(version: AreaVersionDto, previous: AreaVersionDto | undefined): string {
  if (version.revertedFrom !== null) return base.history.restoredFrom(version.revertedFrom);
  switch (version.op) {
    case 'create':
      return base.history.created(formatArea(version.areaKm2));
    case 'delete':
      return base.history.deleted;
    case 'restore':
      return base.history.undeleted;
    case 'update': {
      const fields = version.changedFields.filter((field) => field !== 'deleted');
      const merged = version.merged ? base.history.merged : '';
      if (fields.length === 1 && fields[0] === 'geometry') {
        return `${base.history.reshaped(formatArea(previous?.areaKm2 ?? version.areaKm2), formatArea(version.areaKm2))}${merged}`;
      }
      if (fields.length === 1 && fields[0] === 'name')
        return `${base.history.renamed(displayName(previous?.name ?? ''))}${merged}`;
      if (fields.length === 1 && fields[0] === 'description') return `${base.history.described}${merged}`;
      if (fields.includes('geometry') && fields.includes('name')) return `${base.history.multi}${merged}`;
      return `${base.history.updated}${merged}`;
    }
  }
}

/** The visible cue on a hovered or focused item (UI.md section 10.8.3). Decoration only: the row itself is the control. */
const PREVIEW_CUE = 'Preview';

/**
 * The history copy is one string per change (UX section 9.6): "Reshaped, 0.79 km² -> 0.84 km²", "Renamed from "Yarkon
 * Plot"". The timeline shows the change as the item title and the rest on the person line (UI.md section 10.8.3): the
 * figures after ", " in mono, a "from ..." source as text. The source is looked for first, so a ", " inside an old
 * name is never taken for figures.
 */
function splitChange(text: string): { title: string; detail: string | null; figures: boolean } {
  const from = text.indexOf(' from ');
  if (from !== -1) return { title: text.slice(0, from), detail: text.slice(from + 1), figures: false };
  const dot = text.indexOf(' · ');
  if (dot !== -1) return { title: text.slice(0, dot), detail: text.slice(dot + 3), figures: true };
  return { title: text, detail: null, figures: false };
}

function HistoryItem({
  version,
  previous,
  current,
  previewed,
  meId,
  now,
}: {
  version: AreaVersionDto;
  previous: AreaVersionDto | undefined;
  current: boolean;
  previewed: boolean;
  meId: string | null;
  now: number;
}) {
  const workspace = useWorkspace();
  const ref = useRef<HTMLButtonElement>(null);
  useFocusTarget('history-current', ref, current ? undefined : `v${version.version}`);
  useFocusTarget('history-item', ref, version.version);
  const created = new Date(version.createdAt);
  const { title, detail, figures } = splitChange(changeSummary(version, previous));
  const mine = version.actor !== null && version.actor.id === meId;
  // The node takes the actor's colour; mine is the accent, like every other "me" mark (UI.md section 2.2).
  const node = mine ? 'var(--color-accent)' : (version.actor?.color ?? 'var(--color-border-strong)');
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const item = event.currentTarget.closest('li');
    const sibling = event.key === 'ArrowDown' ? item?.nextElementSibling : item?.previousElementSibling;
    sibling?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  return (
    <li className={`tl-item${current ? ' tl-item--current' : ''}`}>
      <button
        ref={ref}
        type="button"
        className="tl-button"
        style={{ '--node': node } as CSSProperties}
        data-testid="history-item"
        data-version={version.version}
        aria-current={previewed ? 'true' : undefined}
        aria-describedby={`hist-abs-${version.version}`}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          void workspace.area.previewVersion(version.version, event.detail === 0);
        }}
      >
        <span className="tl-node" aria-hidden="true" />
        <span className="tl-top">
          <span className="ver num">v{version.version}</span>
          <span className="tl-title">{title}</span>
          {current ? <span className="tag-current">{base.history.current}</span> : null}
        </span>
        <span className="tl-sub">
          {version.actor !== null ? <Who user={version.actor} isMe={mine} /> : null}
          {version.actor !== null && detail !== null ? (
            <span className="sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {detail === null ? null : figures ? (
            <span className="num">{detail}</span>
          ) : (
            // The source can hold an old name (the user's text): isolated so Hebrew never reorders the line (UX section 9.12).
            <bdi className="tl-detail">{detail}</bdi>
          )}
        </span>
        <span className="tl-time num" title={formatAbsoluteTime(created)}>
          {formatRelativeTime(created, new Date(now))}
        </span>
        <span className="tl-preview" aria-hidden="true">
          {PREVIEW_CUE}
        </span>
        <span className="sr-only" id={`hist-abs-${version.version}`}>
          {formatAbsoluteTime(created)}
        </span>
      </button>
    </li>
  );
}

function HistoryLoading({ retryAt, now }: { retryAt: number | null; now: number }) {
  return (
    <div className="history-loading" aria-busy="true">
      <p className="hint">
        {retryAt !== null ? base.common.waitRetry(formatCountdown(retryAt - now)) : base.history.loading}
      </p>
      {[0, 1].map((row) => (
        <div key={row} className="skel-row" aria-hidden="true">
          <span className="skel skel--node" />
          <span className="skel-row__bars">
            <span className="skel skel--short" />
            <span className="skel skel--long" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function HistoryList({ areaId, currentVersion }: { areaId: string; currentVersion: number }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const history = useStore(stores.workspace, (state) => state.history);
  const preview = useStore(stores.workspace, (state) => state.preview);
  const meId = useStore(stores.auth, (state) => state.user?.id ?? null);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const restoreRef = useRef<HTMLButtonElement>(null);
  useFocusTarget('restore-version-button', restoreRef);
  if (history?.areaId !== areaId || history.status === 'loading') {
    return <HistoryLoading retryAt={history?.retryAt ?? null} now={now} />;
  }
  if (history.status === 'error') {
    return (
      <div className="banner danger history-error">
        <Icon name="circle-alert" />
        <div>
          <b>{base.history.loadError}</b>
          <div className="acts">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                void workspace.area.loadHistory(areaId);
              }}
            >
              {base.map.retry}
            </button>
          </div>
        </div>
      </div>
    );
  }
  // "Current" and the Restore rule follow the area's version, not the list's first row: the list can lag a change
  // by one request (UX F-07).
  const previewedVersion = preview?.version;
  const disabledReason =
    previewedVersion === undefined
      ? null
      : previewedVersion.version === currentVersion
        ? base.history.restoreDisabledCurrent
        : previewedVersion.op === 'delete'
          ? base.history.restoreDisabledDeleted
          : null;
  return (
    <>
      {previewedVersion !== undefined && preview !== null ? (
        <div className="banner accent preview-banner" data-testid="history-preview-banner">
          <Icon name="history" />
          <div>
            <b>
              {base.history.previewBanner(
                previewedVersion.version,
                formatRelativeTime(new Date(previewedVersion.createdAt), new Date(now)),
              )}
            </b>
            <div className="acts">
              <button
                ref={restoreRef}
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="restore-version-button"
                aria-disabled={disabledReason !== null || preview.restoring}
                aria-description={disabledReason ?? undefined}
                onClick={() => {
                  if (disabledReason === null) workspace.area.restoreVersion();
                }}
              >
                {preview.countdownUntil !== null
                  ? base.rate.restoreButton(formatCountdown(preview.countdownUntil - now))
                  : preview.restoring
                    ? base.history.restoring
                    : base.history.restore}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                data-testid="exit-preview-button"
                onClick={() => {
                  workspace.area.exitPreview();
                }}
              >
                {base.history.exitPreview}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ol className="timeline">
        {history.items.map((version, index) => (
          <HistoryItem
            key={version.version}
            version={version}
            previous={history.items[index + 1]}
            current={version.version === currentVersion}
            previewed={previewedVersion?.version === version.version}
            meId={meId}
            now={now}
          />
        ))}
      </ol>
    </>
  );
}
