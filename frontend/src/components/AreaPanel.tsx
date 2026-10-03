/**
 * Area details (UX C-11, C-14, F-05, F-06, F-10; UI.md section 10.8.2) - the inspector's Selection section (v2): a header
 * with *Zoom to area* and *Close*, the name with *Rename*, the readout well (km², ha, perimeter, points, version),
 * who created it and who edited it last, *Edit shape* (or *Edit anyway* under someone's lock) and *Delete* for the
 * creator or an admin only (decided from `createdById` immediately), the description, and the deleted-by-other
 * state. History is its own section (`HistorySection`); on phones the sheet's *History* button opens it.
 */
import type { CSSProperties, KeyboardEvent } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { useLayout, useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import {
  formatAbsoluteTime,
  formatAreaParts,
  formatCountdown,
  formatHectares,
  formatPerimeter,
  formatRelativeTime,
} from '../lib/format';
import { displayUser, sanitizedLength } from '../lib/text';
import { activeLock } from '../state/locksStore';
import { descriptionMaxLength, nameMaxLength } from '../state/runtimeConfigStore';
import { canDelete } from '../state/selectors';
import { sectionExpanded } from '../state/workspaceStore';
import { Icon } from './Icon';
import { Avatar, Who } from './presence/Presence';
import { useFocusTarget } from './useFocusTarget';

/** Labels of the readout cells and the properties (UX C-11 v2 names them; UI.md section 10.8.2). */
const LABEL = {
  perimeter: 'Perimeter',
  points: 'Points',
  version: 'Version',
  created: 'Created',
  lastEdit: 'Last edit',
} as const;

/** "3.91 km" as a mono number and a sans unit; the text content stays the formatted string. */
function ValueUnit({ text }: { text: string }) {
  const at = text.lastIndexOf(' ');
  return (
    <>
      <span className="num">{text.slice(0, at)}</span> <span className="unit">{text.slice(at + 1)}</span>
    </>
  );
}

function AreaFigure({ km2, className }: { km2: number; className: string }) {
  const area = formatAreaParts(km2);
  return (
    <span className={className} data-testid="area-panel-km2" data-km2={km2}>
      <span className="num">{area.value}</span> <span className="unit">{area.unit}</span>
    </span>
  );
}

/** Docked / overlay: the instrument well - the km² figure with ha, then perimeter, points, version cells. */
function ReadoutWell({
  km2,
  perimeter,
  vertices,
  version,
}: {
  km2: number;
  perimeter: number | null;
  vertices: number | null;
  version: number;
}) {
  return (
    <div className="well">
      <div className="well__top">
        <div className="well__area">
          <span className="micro">{base.draw.readoutLabel}</span>
          <AreaFigure km2={km2} className="well__figure" />
        </div>
        <span className="well__ha num" data-testid="area-panel-ha">
          {formatHectares(km2)}
        </span>
      </div>
      <dl className="well__cells">
        <div className="well__cell">
          <dt className="micro">{LABEL.perimeter}</dt>
          <dd data-testid="area-panel-perimeter" data-perimeter-km={perimeter ?? undefined}>
            {perimeter === null ? '—' : <ValueUnit text={formatPerimeter(perimeter)} />}
          </dd>
        </div>
        <div className="well__cell">
          <dt className="micro">{LABEL.points}</dt>
          <dd className="num" data-testid="area-panel-vertices" data-count={vertices ?? undefined}>
            {vertices ?? '—'}
          </dd>
        </div>
        <div className="well__cell">
          <dt className="micro">{LABEL.version}</dt>
          <dd className="num" data-testid="area-panel-version">
            v{version}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Phone sheet: one metrics line, "0.84 km²  84.0 ha, 3.91 km, 6 points" (UI.md section 10.13). */
function SheetMetrics({
  km2,
  perimeter,
  vertices,
}: {
  km2: number;
  perimeter: number | null;
  vertices: number | null;
}) {
  return (
    <p className="sheet-metrics">
      <AreaFigure km2={km2} className="sheet-metrics__figure" />
      <span className="sheet-metrics__meta num">
        <span data-testid="area-panel-ha">{formatHectares(km2)}</span>
        {' · '}
        <span data-testid="area-panel-perimeter" data-perimeter-km={perimeter ?? undefined}>
          {perimeter === null ? '—' : formatPerimeter(perimeter)}
        </span>
        {' · '}
        <span data-testid="area-panel-vertices" data-count={vertices ?? undefined}>
          {vertices === null ? '—' : base.draw.points(vertices)}
        </span>
      </span>
    </p>
  );
}

/**
 * UX F-09 step 1 for rename / description: someone saved a newer version while the input is open. Nothing changes in
 * my text; saving then goes through the conflict rules because the save keeps the version I started from.
 */
function NewerVersionWarning({ areaId, baseVersion }: { areaId: string; baseVersion: number }) {
  const workspace = useWorkspace();
  const record = useStore(workspace.ctx.stores.areas, (state) => state.byId.get(areaId));
  if (record === undefined || record.version <= baseVersion) return null;
  return (
    <div className="banner warn">
      <Icon name="triangle-alert" />
      <p>{base.edit.newerVersion(displayUser(record.updatedBy.displayName), record.version)}</p>
    </div>
  );
}

function DetailsEditor({ field }: { field: 'name' | 'description' }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const edit = useStore(stores.workspace, (state) => state.detailsEdit);
  const config = useStore(stores.runtime, (state) => state.config);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = field === 'name' ? inputRef : areaRef;
  useFocusTarget('rename-input', fieldRef);
  // Closing the input (Enter, Esc, a save or a revert) would drop focus to <body> with it: the heading takes it,
  // unless a flow has already sent focus elsewhere (the conflict panel, UX section 8.3). A layout-effect cleanup runs while
  // the input is still in the document, so it can still tell whether the input had focus.
  useLayoutEffect(() => {
    const element = fieldRef.current;
    return () => {
      const state = stores.workspace.getState();
      if (
        element !== null &&
        element === document.activeElement &&
        state.focusRequest?.target === 'rename-input'
      )
        state.requestFocus('panel-heading');
    };
  }, [fieldRef, stores]);
  if (edit?.field !== field) return null;
  const max = field === 'name' ? nameMaxLength(config) : descriptionMaxLength(config);
  const length = sanitizedLength(edit.text, field === 'description');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      workspace.area.cancelDetailsEdit();
      return;
    }
    const submitKey =
      field === 'name' ? event.key === 'Enter' : event.key === 'Enter' && (event.ctrlKey || event.metaKey);
    if (submitKey) {
      event.preventDefault();
      workspace.area.commitDetailsEdit();
    }
  };
  const common = {
    dir: 'auto' as const,
    value: edit.text,
    readOnly: edit.saving,
    'aria-invalid': edit.error !== null,
    'aria-describedby': edit.error !== null ? `${field}-edit-error` : undefined,
    onKeyDown,
  };
  return (
    <div className={`field details-edit details-edit--${field}`}>
      {field === 'name' ? (
        <input
          ref={inputRef}
          {...common}
          className="input rename-input"
          aria-label={base.panel.rename}
          data-testid="rename-input"
          onChange={(event) => {
            workspace.area.setDetailsText(event.target.value);
          }}
          onBlur={() => {
            if (stores.workspace.getState().detailsEdit?.field === 'name') workspace.area.commitDetailsEdit();
          }}
        />
      ) : (
        <textarea
          ref={areaRef}
          {...common}
          className="input"
          aria-label={base.panel.description}
          data-testid="description-input"
          onChange={(event) => {
            workspace.area.setDetailsText(event.target.value);
          }}
        />
      )}
      {length >= Math.floor(max * 0.8) ? <p className="counter">{base.save.charCount(length, max)}</p> : null}
      <NewerVersionWarning areaId={edit.areaId} baseVersion={edit.baseVersion} />
      {edit.error !== null ? (
        <p className="field-error" id={`${field}-edit-error`}>
          <Icon name="circle-alert" size="sm" />
          <span>{edit.error}</span>
        </p>
      ) : null}
      {edit.saving && edit.countdownUntil === null ? (
        <p className="status-line">
          <span className="spinner xs" aria-hidden="true" />
          {base.save.saving}
        </p>
      ) : null}
      {edit.countdownUntil !== null ? (
        <p className="hint">
          {base.rate.renameLine(formatCountdown(edit.countdownUntil - now))}{' '}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              workspace.area.cancelDetailsEdit();
            }}
          >
            {base.rate.cancel}
          </button>
        </p>
      ) : null}
      {field === 'description' ? (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              workspace.area.commitDetailsEdit();
            }}
          >
            {base.panel.descriptionSave}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              workspace.area.cancelDetailsEdit();
            }}
          >
            {base.panel.descriptionCancel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DeletedState() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const detail = useStore(stores.workspace, (state) => state.detail);
  const unsaved = useStore(stores.workspace, (state) => state.unsavedText);
  const restoring = useStore(stores.workspace, (state) => state.restoring);
  const me = useStore(stores.auth, (state) => state.user);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  if (detail?.status !== 'deleted') return null;
  const area = detail.area;
  const deleter = area.deletedBy ?? area.updatedBy;
  const when = area.deletedAt === null ? '' : formatRelativeTime(new Date(area.deletedAt), new Date(now));
  const allowed = canDelete(me, { createdById: area.createdBy.id, createdBy: area.createdBy });
  const countdown = restoring?.areaId === area.id ? restoring.until : null;
  return (
    <div className="deleted-state banner neutral" data-testid="deleted-state">
      <Icon name="trash-2" />
      <div>
        <b>{base.panel.deletedByOther(displayUser(deleter.displayName), when)}</b>
        {unsaved !== null ? <p>{base.panel.unsavedName(unsaved)}</p> : null}
        {allowed ? null : (
          <p data-testid="ask-to-restore">{base.panel.askToRestore(displayUser(deleter.displayName))}</p>
        )}
        <div className="acts">
          {allowed ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="restore-area-button"
              aria-disabled={restoring !== null}
              onClick={() => {
                workspace.area.restoreSelected();
              }}
            >
              {countdown !== null
                ? base.rate.restoreButton(formatCountdown(countdown - now))
                : base.panel.restoreArea}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              data-testid="save-copy-button"
              onClick={() => {
                workspace.area.saveCopy();
              }}
            >
              {base.panel.saveCopy}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              workspace.area.close();
            }}
          >
            {base.panel.closeButton}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AreaPanel() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const areaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const detail = useStore(stores.workspace, (state) => state.detail);
  const invoker = useStore(stores.workspace, (state) => state.panelInvoker);
  const detailsEdit = useStore(stores.workspace, (state) => state.detailsEdit);
  const preview = useStore(stores.workspace, (state) => state.preview);
  const mode = useStore(stores.workspace, (state) => state.mode);
  const historyExpanded = useStore(stores.workspace, (state) => sectionExpanded(state, 'history'));
  const record = useStore(stores.areas, (state) => (areaId === null ? undefined : state.byId.get(areaId)));
  const locks = useStore(stores.locks, (state) => state);
  const me = useStore(stores.auth, (state) => state.user);
  const connection = useStore(stores.connection, (state) => state.state);
  const loadingEdit = useStore(stores.edit, (state) => state.loadingDetail);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const phone = useLayout() === 'phone';
  const sheet = useStore(stores.workspace, (state) => state.sheet);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  useFocusTarget('panel-heading', headingRef);
  useFocusTarget('edit-shape-button', editRef);
  if (areaId === null) return null;
  const full =
    detail?.areaId === areaId && (detail.status === 'ready' || detail.status === 'deleted')
      ? detail.area
      : null;
  // One version's fields: the map record can be newer than the detail (a change reaches the store first), and a
  // previewed version shows its own name, description and figures (UX F-07 step 3).
  const current = record !== undefined && record.version > (full?.version ?? 0) ? record : (full ?? record);
  const previewed = preview?.areaId === areaId ? preview.version : null;
  const shown = previewed ?? current;
  const name = shown?.name ?? '';
  const km2 = shown?.areaKm2 ?? 0;
  const version = shown?.version ?? 0;
  const perimeter = shown?.perimeterKm ?? null;
  const vertices = shown?.vertexCount ?? null;
  const description = previewed !== null ? previewed.description : full?.description;
  const updatedBy = current?.updatedBy ?? null;
  const updatedAt = current?.updatedAt ?? null;
  const createdBy = full?.createdBy ?? record?.createdBy ?? null;
  const createdById = full?.createdBy.id ?? record?.createdById ?? '';
  const holes = (full?.geometry.coordinates.length ?? record?.rings.length ?? 1) > 1;
  const allowedDelete = canDelete(me, { createdById, createdBy });
  const lock = activeLock(locks, areaId, me?.id ?? null, now);
  const lockUnknown = !locks.known && (connection === 'limited' || connection === 'offline');
  const deleted = detail?.areaId === areaId && detail.status === 'deleted';
  const readOnlyMode = mode !== 'area-selected';
  const meId = me?.id ?? null;
  // Phones use 44 px sheet buttons (UI.md section 10.13); the inspector uses md (32).
  const size = phone ? ' btn-lg' : '';
  const close = (): void => {
    workspace.area.close();
  };
  const zoomTo = (): void => {
    workspace.area.zoomTo();
  };
  return (
    <section className="area-panel" data-testid="area-panel" aria-labelledby="panel-title">
      {/* The Selection section header (UX C-11 v2): kicker, Back to list, Zoom to area, Close. Phones use the sheet's. */}
      {phone ? null : (
        <div className="insp-head insp-head--primary">
          <span className="insp-kicker micro" aria-hidden="true">
            {base.inspector.selection}
          </span>
          <span className="grow" />
          {invoker === 'list' ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                workspace.area.backToList();
              }}
            >
              {base.list.back}
            </button>
          ) : null}
          {deleted ? null : (
            <button
              type="button"
              className="icon-btn"
              data-testid="zoom-to-area-button"
              aria-label={base.panel.zoomTo}
              aria-keyshortcuts="Z"
              title={base.rail.tooltip(base.panel.zoomTo, 'Z')}
              onClick={zoomTo}
            >
              <Icon name="scan" />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            data-testid="close-panel-button"
            aria-label={base.panel.close}
            aria-keyshortcuts="Escape"
            onClick={close}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      <div className="area-body">
        <div className="title-row">
          {detailsEdit?.field === 'name' ? (
            <DetailsEditor field="name" />
          ) : (
            <>
              <span className="swatch" aria-hidden="true" />
              <h2
                ref={headingRef}
                className="area-name"
                id="panel-title"
                tabIndex={-1}
                data-testid="area-panel-name"
                dir="auto"
              >
                <bdi>{name}</bdi>
              </h2>
              {previewed === null ? null : (
                <span className="tag-current" data-testid="area-panel-preview-tag">
                  {base.history.previewTag}
                </span>
              )}
              {/* Phones: Rename lives in the expanded sheet; the peek is name, figures and actions (UX section 3.2). */}
              {deleted || (phone && sheet !== 'expanded') ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  data-testid="rename-button"
                  aria-label={base.panel.renameLabel(name)}
                  aria-keyshortcuts="F2"
                  aria-disabled={readOnlyMode}
                  title={base.rail.tooltip(base.panel.rename, 'F2')}
                  onClick={() => {
                    workspace.area.startDetailsEdit('name');
                  }}
                >
                  <Icon name="pencil" />
                </button>
              )}
            </>
          )}
        </div>
        {deleted ? (
          <DeletedState />
        ) : (
          <>
            {phone ? (
              <SheetMetrics km2={km2} perimeter={perimeter} vertices={vertices} />
            ) : (
              <ReadoutWell km2={km2} perimeter={perimeter} vertices={vertices} version={version} />
            )}
            <dl className="props">
              {createdBy !== null && full !== null ? (
                <div className="props__row">
                  <dt>{LABEL.created}</dt>
                  <dd>
                    <Who user={createdBy} isMe={createdBy.id === meId} />
                    <span className="sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="num props__time" title={formatAbsoluteTime(new Date(full.createdAt))}>
                      {formatAbsoluteTime(new Date(full.createdAt)).split(',')[0]}
                    </span>
                  </dd>
                </div>
              ) : null}
              {updatedBy !== null && updatedAt !== null ? (
                <div className="props__row">
                  <dt>{LABEL.lastEdit}</dt>
                  <dd>
                    <Who user={updatedBy} isMe={updatedBy.id === meId} />
                    <span className="sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="num props__time" title={formatAbsoluteTime(new Date(updatedAt))}>
                      {formatRelativeTime(new Date(updatedAt), new Date(now))}
                    </span>
                    {phone ? (
                      <>
                        <span className="sep" aria-hidden="true">
                          ·
                        </span>
                        <span className="ver num" data-testid="area-panel-version">
                          v{version}
                        </span>
                      </>
                    ) : null}
                  </dd>
                </div>
              ) : null}
            </dl>
            {lock !== null ? (
              <div
                className="banner lock"
                data-testid="lock-banner"
                style={{ '--c': lock.holder.color } as CSSProperties}
              >
                <Avatar
                  user={{
                    displayName: lock.holder.displayName,
                    color: lock.holder.color,
                    status: 'unknown',
                    isMe: false,
                  }}
                  size="sm"
                  badge={false}
                />
                <div>
                  <b>{base.lock.bannerTitle(displayUser(lock.holder.displayName))}</b>
                  <p>{base.lock.bannerBody}</p>
                </div>
              </div>
            ) : lockUnknown ? (
              <div className="banner neutral">
                <Icon name="info" />
                <p>{base.lock.unknown}</p>
              </div>
            ) : null}
            <div className="panel-actions">
              <button
                ref={editRef}
                type="button"
                className={`btn btn-secondary${size} panel-actions__edit`}
                data-testid="edit-shape-button"
                aria-keyshortcuts="E"
                aria-disabled={holes || readOnlyMode}
                aria-description={holes ? base.edit.holesDisabled : undefined}
                onClick={() => {
                  if (!holes) workspace.edit.start('button');
                }}
              >
                {loadingEdit ? (
                  <span className="spinner xs" aria-hidden="true" />
                ) : (
                  <Icon name="vector-square" />
                )}
                {lock !== null ? base.edit.buttonLocked : base.edit.button}
                <kbd className="btn-kbd" aria-hidden="true">
                  E
                </kbd>
              </button>
              {phone ? (
                // The sheet's *History* (UX section 3.2 peek actions): expands the sheet and the History section.
                <button
                  type="button"
                  className="btn btn-secondary btn-lg"
                  data-testid="history-tab"
                  aria-expanded={historyExpanded}
                  aria-controls="history-body"
                  onClick={() => {
                    if (historyExpanded) stores.workspace.getState().patch({ historyExpanded: false });
                    else workspace.area.showHistory(false);
                  }}
                >
                  <Icon name="history" />
                  {base.inspector.history}
                </button>
              ) : null}
              {allowedDelete ? (
                <button
                  type="button"
                  className={`btn btn-danger${size}`}
                  data-testid="delete-area-button"
                  aria-keyshortcuts="Delete"
                  aria-disabled={readOnlyMode}
                  onClick={() => {
                    workspace.area.deleteSelected();
                  }}
                >
                  <Icon name="trash-2" />
                  {base.panel.delete}
                </button>
              ) : null}
            </div>
            <div className="details">
              {detail?.status === 'loading' ? (
                <p className="status-line">
                  <span className="spinner xs" aria-hidden="true" />
                  {base.edit.loadingDetail}
                </p>
              ) : null}
              {detail?.status === 'rate-limited' ? (
                <p className="hint">{base.common.waitRetry(formatCountdown(detail.retryAt - now))}</p>
              ) : null}
              {detail?.status === 'error' ? (
                <p className="hint">
                  {base.map.loadError}{' '}
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      void workspace.area.loadDetail(areaId);
                    }}
                  >
                    {base.map.retry}
                  </button>
                </p>
              ) : null}
              {detailsEdit?.field !== 'description' && full !== null && description === null ? (
                // No description yet: one row, "No description." and *Add description* (UI.md section 10.8.3).
                <div className="d-label">
                  <p className="d-empty">{base.panel.noDescription}</p>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    aria-disabled={readOnlyMode}
                    onClick={() => {
                      workspace.area.startDetailsEdit('description');
                    }}
                  >
                    {base.panel.descriptionAdd}
                  </button>
                </div>
              ) : (
                <>
                  <div className="d-label">
                    <span>{base.panel.description}</span>
                    {detailsEdit?.field === 'description' || full === null ? null : (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        aria-disabled={readOnlyMode}
                        onClick={() => {
                          workspace.area.startDetailsEdit('description');
                        }}
                      >
                        <Icon name="pencil" size="sm" />
                        {base.panel.descriptionEdit}
                      </button>
                    )}
                  </div>
                  {detailsEdit?.field === 'description' ? (
                    <DetailsEditor field="description" />
                  ) : description !== null && description !== undefined ? (
                    <p className="d-text" dir="auto">
                      {description}
                    </p>
                  ) : (
                    <p className="d-empty">{base.panel.noDescription}</p>
                  )}
                </>
              )}
              {phone ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-lg"
                  data-testid="zoom-to-area-button"
                  aria-keyshortcuts="Z"
                  onClick={zoomTo}
                >
                  <Icon name="scan" />
                  {base.panel.zoomTo}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
