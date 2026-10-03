/**
 * The single map-notice slot (UX C-17, C-24): exactly one notice by the total order of `topNotice()`, below the HUD
 * (or the top bar). Phones show it on one line (tap to expand) and hide it while the HUD shows an error (UX section 3.2).
 * Also the loading bar, shown only when the whole paginated load takes longer than 400 ms (UX-AC-05).
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useStore } from 'zustand';

import { usePhone, useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import { formatCountdown, formatNumber, formatRelativeTime } from '../lib/format';
import { displayName } from '../lib/text';
import { topNotice } from '../state/noticesStore';
import { deriveDrawing } from '../state/drawingReducer';
import { drawingLimits } from '../state/runtimeConfigStore';
import type { IconName } from './Icon';
import { Icon } from './Icon';

function Notice({
  testId,
  tone,
  icon,
  text,
  children,
  onDismiss,
  attributes,
}: {
  testId: string;
  tone: 'info' | 'warning' | 'error' | 'accent';
  icon: IconName;
  text: string;
  children?: ReactNode;
  onDismiss?: () => void;
  attributes?: Record<string, string | number>;
}) {
  const phone = usePhone();
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`notice ${tone}${phone && !expanded ? ' is-clamped' : ''}`}
      data-testid={testId}
      role="status"
      {...attributes}
    >
      <Icon name={icon} />
      <span
        className="notice-text"
        title={text}
        onClick={() => {
          if (phone) setExpanded((value) => !value);
        }}
      >
        {text}
      </span>
      {children}
      {onDismiss === undefined ? null : (
        <button type="button" className="icon-btn" aria-label={base.map.dismiss} onClick={onDismiss}>
          <Icon name="x" size="sm" />
        </button>
      )}
    </div>
  );
}

export function NoticeSlot() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const notices = useStore(stores.notices, (state) => state);
  const localDraft = useStore(stores.workspace, (state) => state.localDraft);
  const mode = useStore(stores.workspace, (state) => state.mode);
  const drawing = useStore(stores.drawing, (state) => state.drawing);
  const config = useStore(stores.runtime, (state) => state.config);
  const zoom = useStore(stores.mapView, (state) => state.mercatorZoom);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const phone = usePhone();
  const top = topNotice(notices);
  if (top === null) return null;
  // Phones: the notice hides while the HUD shows an error (overlay budget, UX section 3.2).
  if (
    phone &&
    mode === 'drawing' &&
    deriveDrawing(drawing, drawingLimits(config)).message.severity === 'error'
  )
    return null;
  const zoomIn = (
    <button
      type="button"
      className="btn btn-sm btn-secondary"
      onClick={() => {
        workspace.ctx.map()?.zoomBy(1);
      }}
    >
      {base.map.zoomIn}
    </button>
  );
  switch (top) {
    case 'restore-draft-banner': {
      if (localDraft === null) return null;
      const time = formatRelativeTime(new Date(localDraft.savedAt), new Date(now));
      const edit = localDraft.kind === 'edit' && localDraft.edit !== null;
      return (
        <Notice
          testId="restore-draft-banner"
          tone="accent"
          icon="rotate-ccw"
          text={
            edit && localDraft.edit !== null
              ? base.restore.edit(displayName(localDraft.edit.name), time)
              : base.restore.drawing(time)
          }
        >
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              workspace.restoreLocalDraft();
            }}
          >
            {edit ? base.restore.resume : base.restore.restore}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              workspace.discardLocalDraft();
            }}
          >
            {base.restore.discard}
          </button>
        </Notice>
      );
    }
    case 'load-error':
      return (
        <Notice testId="load-error" tone="error" icon="circle-alert" text={base.map.loadError}>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              workspace.viewportSync.retry();
            }}
          >
            {base.map.retry}
          </button>
        </Notice>
      );
    case 'read-rate-limit-notice':
    case 'storage-notice': {
      const failure = notices.load.failure;
      const retryAt = failure !== null && failure.kind !== 'error' ? failure.retryAt : now;
      const wait = formatCountdown(retryAt - now);
      return top === 'read-rate-limit-notice' ? (
        <Notice
          testId="read-rate-limit-notice"
          tone="warning"
          icon="clock"
          text={base.map.rateLimited(wait)}
        />
      ) : (
        <Notice
          testId="storage-notice"
          tone="warning"
          icon="cloud-off"
          text={base.map.storageUnavailable(wait)}
        />
      );
    }
    case 'tiles-failing-notice': {
      const failing = notices.tilesFailing ?? 'map';
      const other = failing === 'map' ? 'aerial' : 'map';
      return (
        <Notice
          testId="tiles-failing-notice"
          tone="info"
          icon="info"
          text={base.layer.tilesFailing(failing === 'map' ? base.layer.map : base.layer.aerial)}
        >
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              workspace.selectLayer(other);
            }}
          >
            {base.layer.switchTo(other === 'map' ? base.layer.map : base.layer.aerial)}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              workspace.ctx.map()?.retryTiles();
            }}
          >
            {base.map.retry}
          </button>
        </Notice>
      );
    }
    case 'truncation-notice':
      return (
        <Notice
          testId="truncation-notice"
          tone="warning"
          icon="zoom-in"
          text={base.map.truncatedNoTotal(formatNumber(notices.load.truncatedShown ?? 0))}
          attributes={{ 'data-count': notices.load.truncatedShown ?? 0 }}
        >
          {zoomIn}
        </Notice>
      );
    case 'culling-notice': {
      const count = notices.load.culledCount;
      return (
        <Notice
          testId="culling-notice"
          tone="warning"
          icon="zoom-in"
          text={base.map.culled(count >= 10_000 ? '10,000+' : formatNumber(count))}
          attributes={{ 'data-count': count }}
          onDismiss={() => {
            stores.notices.getState().patch({ cullingDismissedAtZoom: zoom });
          }}
        >
          {zoomIn}
        </Notice>
      );
    }
    case 'coverage-notice':
      return <Notice testId="coverage-notice" tone="info" icon="info" text={base.layer.outsideCoverage} />;
    case 'empty-hint':
      return (
        <Notice
          testId="empty-hint"
          tone="info"
          icon="snap-polygon"
          text={`${base.map.emptyTitle} ${base.map.emptyBody}`}
          onDismiss={() => {
            stores.notices.getState().patch({ emptyDismissed: true });
          }}
        >
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={(event) => {
              workspace.drawing.start(event.detail === 0 ? 'keyboard' : 'pointer');
            }}
          >
            {base.draw.button}
          </button>
        </Notice>
      );
  }
}

export function ProgressBar() {
  const workspace = useWorkspace();
  const show = useStore(
    workspace.ctx.stores.notices,
    (state) => state.load.showProgress && state.load.loading,
  );
  if (!show) return null;
  return (
    <div className="progress" data-testid="map-loading" role="progressbar" aria-label={base.map.loading}>
      <span className="sr-only">{base.map.loading}</span>
    </div>
  );
}
