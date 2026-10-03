/**
 * The drawing / editing HUD content (UX C-05, C-06.4, C-12, C-13; UI.md section 10.6, section 10.13). It renders in one of two
 * places (v2 Studio): the docked **options bar** at >= 600 px (`variant="bar"`: mode tag, readout, points, message
 * strip, actions, on one row) or the **phone HUD** docked above the map (`variant="phone"`: readout row + exactly one
 * message line; the actions live in the bottom bar).
 *
 * The strip always shows the `.short` copy (UX section 9 "Short variants", v2) with the full sentence as its `title`; it is
 * NOT a live region - discrete events are announced once through `live-status` by the flows. A pointer activation of
 * a HUD button hands focus back to the map, so Enter / Space never re-activate it (UX C-03).
 */
import type { MouseEvent, ReactNode } from 'react';
import { useState } from 'react';
import { useStore } from 'zustand';

import { useCoarsePointer, useWorkspace } from '../app/AppContext';
import { base } from '../base/en';
import {
  formatArea,
  formatAreaParts,
  formatAreaSpoken,
  formatCountdown,
  formatHectares,
  formatPerimeter,
  formatShortDate,
  formatSquareMetres,
} from '../lib/format';
import { isApplePlatform, platformKeys } from '../lib/platform';
import { displayName, displayUser, keyTextPlain } from '../lib/text';
import type { DrawingView, HudCode, HudMessage } from '../state/drawingReducer';
import { deriveDrawing } from '../state/drawingReducer';
import type { EditState } from '../state/editReducer';
import { editMetrics, isDirty, ringProblem } from '../state/editReducer';
import { drawingLimits } from '../state/runtimeConfigStore';
import { refusalText } from '../workspace/editFlow';
import type { HudText } from '../workspace/hudCopy';
import { drawingMessage, geometryReason, hintText } from '../workspace/hudCopy';
import { KeyText } from './frame/KeyHints';
import { useCollapsedTip } from './frame/useCollapsedTip';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type HudVariant = 'bar' | 'phone';

const UNDO_SHORTCUT = isApplePlatform() ? 'Meta+Z' : 'Control+Z';
const SAVE_SHORTCUT = isApplePlatform() ? 'Meta+S' : 'Control+S';

/** Pointer activation (`detail > 0`) returns focus to the map; keyboard activation keeps it on the button (C-03). */
function pointerRefocus(event: MouseEvent, focusMap: () => void): void {
  if (event.detail > 0) focusMap();
}

/** A key chip inside a button: decorative (the button carries `aria-keyshortcuts`), hidden on narrow bars. */
function ButtonKey({ chip }: { chip: string }) {
  return (
    <kbd className="btn-kbd" aria-hidden="true">
      {platformKeys(chip)}
    </kbd>
  );
}

/**
 * The options bar's first item (`optbar-mode-tag`): accent for my work (drawing, editing, naming, preview), neutral
 * for a selection. On phones it is a decorative icon; the HUD group carries the name. Only the editing `kicker`
 * (it holds the area's name) may ellipsize; the other tags keep their short labels whole.
 */
export function ModeTag({
  icon,
  text,
  tone,
  variant,
  kicker = false,
}: {
  icon: IconName;
  text: ReactNode;
  tone: 'accent' | 'neutral';
  variant: HudVariant;
  kicker?: boolean;
}) {
  if (variant === 'phone') {
    return (
      <span className={`mode-tag mode-tag--${tone} mode-tag--icon`} aria-hidden="true">
        <Icon name={icon} size="lg" />
      </span>
    );
  }
  return (
    <span
      className={`mode-tag mode-tag--${tone}${kicker ? ' mode-tag--kicker' : ''}`}
      data-testid="optbar-mode-tag"
    >
      <Icon name={icon} size="sm" />
      <span className="mode-tag__text">{text}</span>
    </span>
  );
}

function Readout({
  km2,
  perimeterKm,
  variant,
  suffix,
}: {
  km2: number | null;
  perimeterKm: number | null;
  variant: HudVariant;
  suffix?: ReactNode;
}) {
  const [tip, setTip] = useState(false);
  const tooltip =
    km2 === null || perimeterKm === null
      ? null
      : base.draw.readoutTooltip(formatHectares(km2), formatSquareMetres(km2), formatPerimeter(perimeterKm));
  const parts = km2 === null ? null : formatAreaParts(km2);
  return (
    <div
      className={`readout readout--${variant}`}
      tabIndex={0}
      data-testid="area-readout"
      data-km2={km2 ?? undefined}
      data-perimeter-km={perimeterKm ?? undefined}
      aria-label={`${base.draw.readoutLabel} ${km2 === null ? base.sr.areaUnknown : formatAreaSpoken(km2)}`}
      aria-describedby={tip && tooltip !== null ? 'readout-tip' : undefined}
      onMouseEnter={() => {
        setTip(true);
      }}
      onMouseLeave={() => {
        setTip(false);
      }}
      onFocus={() => {
        setTip(true);
      }}
      onBlur={() => {
        setTip(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && tip) {
          event.stopPropagation();
          setTip(false);
        }
      }}
    >
      {variant === 'bar' ? <span className="micro">{base.draw.readoutLabel}</span> : null}
      <span className="readout__value num">{parts === null ? base.draw.readoutEmpty : parts.value}</span>
      {parts === null ? null : <span className="readout__unit">{parts.unit}</span>}
      {variant === 'bar' && km2 !== null ? (
        <span className="readout__ha num">{formatHectares(km2)}</span>
      ) : null}
      {suffix}
      {tip && tooltip !== null ? (
        <span className="tooltip num" role="tooltip" id="readout-tip">
          {tooltip}
        </span>
      ) : null}
    </div>
  );
}

function PointCount({ count, variant }: { count: number; variant: HudVariant }) {
  if (variant === 'phone') {
    return (
      <span className="points points--phone num" data-testid="point-count" data-count={count}>
        · {base.draw.points(count)}
      </span>
    );
  }
  return (
    <div className="points" data-testid="point-count" data-count={count}>
      <span className="micro">Points</span>
      <span className="points__value num">{count}</span>
    </div>
  );
}

function Separator() {
  return <span className="optbar-sep" aria-hidden="true" />;
}

/** One strip message: its `data-code`, look, copy and any extra data attributes. */
interface StripMessage {
  code: HudCode;
  severity: 'error' | 'warning' | 'hint' | 'armed';
  text: HudText;
  extra?: Record<string, string | number | undefined>;
}

function MessageStrip({ code, severity, text, children, extra }: StripMessage & { children?: ReactNode }) {
  const icon = severity === 'error' ? 'circle-alert' : severity === 'warning' ? 'triangle-alert' : 'info';
  return (
    <div
      className={`hud-msg hud-msg--${severity}${children === undefined ? '' : ' with-actions'}`}
      data-testid="hud-message"
      data-code={code}
      title={keyTextPlain(text.full)}
      {...extra}
    >
      <span className="msg-text">
        <Icon name={icon} size="xs" />
        <span className="msg-text__copy">
          <KeyText text={text.short} />
        </span>
      </span>
      {children === undefined ? null : <span className="msg-acts">{children}</span>}
    </div>
  );
}

function RateChip({ until, now }: { until: number | null; now: number }) {
  const seconds = until === null ? undefined : Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div
      className="hud-msg hud-msg--rate"
      data-testid="hud-message"
      data-code={until === null ? 'sharing-paused' : 'rate-limited'}
    >
      <span
        className="rate-chip"
        data-testid="rate-limit-notice"
        data-seconds={seconds}
        title={base.rate.chipHelp}
      >
        <Icon name="clock" size="xs" />
        {until === null ? base.rate.chipPaused : base.rate.chip(formatCountdown(until - now))}
      </span>
    </div>
  );
}

function drawingStrip(
  view: DrawingView,
  pointCount: number,
  touch: boolean,
  keyboard: boolean,
  limits: ReturnType<typeof drawingLimits>,
): { message: HudMessage; text: HudText } {
  const message = view.message;
  const context = { limits, touch, keyboard, pointCount };
  const text = message.code === 'hint' ? hintText(context) : drawingMessage(message.code, context);
  return { message, text };
}

/** Drawing, Naming and SavingNew (`options-bar[data-content=drawing|naming]`, the phone HUD while drawing). */
export function DrawHud({ variant }: { variant: HudVariant }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const drawing = useStore(stores.drawing, (state) => state.drawing);
  const viaKeyboard = useStore(stores.drawing, (state) => state.viaKeyboard);
  const sharing = useStore(stores.drawing, (state) => state.sharing);
  const config = useStore(stores.runtime, (state) => state.config);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const coarse = useCoarsePointer();
  const undoTip = useCollapsedTip(base.draw.undoPoint, 'Ctrl Z');
  if (mode !== 'drawing' && mode !== 'naming' && mode !== 'saving-new') return null;
  const naming = mode !== 'drawing';
  // Phone Naming hides the HUD: the naming sheet shows the area (UX section 3.2).
  if (naming && variant === 'phone') return null;
  const limits = drawingLimits(config);
  const view = deriveDrawing(drawing, limits);
  const count = drawing.points.length;
  const focusMap = (): void => {
    workspace.ctx.map()?.focusMap();
  };
  const tag = <ModeTag icon="snap-polygon" text={base.optbar.tagDraw} tone="accent" variant={variant} />;
  if (naming) {
    return (
      <div className="hud hud--compact" data-testid="draw-hud" data-state={view.hudState}>
        {tag}
        <Separator />
        <Readout km2={view.areaKm2} perimeterKm={view.perimeterKm} variant={variant} />
        <Separator />
        <PointCount count={count} variant={variant} />
      </div>
    );
  }
  const strip = drawingStrip(view, count, coarse, viaKeyboard, limits);
  const blocker = view.finishBlocker;
  const blockerText =
    blocker === null
      ? null
      : drawingMessage(blocker, { limits, touch: coarse, keyboard: viaKeyboard, pointCount: count }).full;
  const showRate =
    strip.message.severity === 'hint' && (sharing.kind === 'rate-limited' || sharing.kind === 'paused');
  const message = showRate ? (
    <RateChip until={sharing.kind === 'rate-limited' ? sharing.retryAt : null} now={now} />
  ) : (
    <MessageStrip
      code={strip.message.code}
      severity={
        strip.message.severity === 'error'
          ? 'error'
          : strip.message.severity === 'warning'
            ? 'warning'
            : 'hint'
      }
      text={strip.text}
    />
  );
  if (variant === 'phone') {
    return (
      <div className="hud hud--phone" data-testid="draw-hud" data-state={view.hudState}>
        {tag}
        <div className="hud-lines">
          <div className="hud-line">
            <Readout km2={view.areaKm2} perimeterKm={view.perimeterKm} variant="phone" />
            <PointCount count={count} variant="phone" />
          </div>
          {message}
        </div>
      </div>
    );
  }
  return (
    <div className="hud" data-testid="draw-hud" data-state={view.hudState}>
      {tag}
      <Separator />
      <Readout km2={view.areaKm2} perimeterKm={view.perimeterKm} variant="bar" />
      <Separator />
      <PointCount count={count} variant="bar" />
      {message}
      <div className="hud-actions">
        {/* Named by its visible label "Undo point" (WCAG 2.5.3 label in name); what it does is its description. */}
        <button
          type="button"
          className="btn btn-sm btn-ghost btn-collapsible"
          data-testid="undo-point-button"
          aria-describedby="undo-point-help"
          aria-keyshortcuts={UNDO_SHORTCUT}
          aria-disabled={count === 0}
          {...undoTip.handlers}
          onClick={(event) => {
            undoTip.hide();
            workspace.drawing.undo();
            pointerRefocus(event, focusMap);
          }}
        >
          <Icon name="undo-2" />
          <span className="btn-label">{base.draw.undoPoint}</span>
          <ButtonKey chip="Ctrl Z" />
          <span className="sr-only" id="undo-point-help">
            {base.draw.undoPointHelp}
          </span>
          {undoTip.tip}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          data-testid="cancel-draw-button"
          aria-keyshortcuts="Escape"
          onClick={() => {
            workspace.drawing.cancel();
          }}
        >
          {base.draw.cancel}
          <ButtonKey chip="Esc" />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          data-testid="finish-button"
          aria-disabled={!view.canFinish}
          aria-describedby={blockerText === null ? undefined : 'finish-reason'}
          title={blockerText === null ? undefined : base.draw.finishDisabled(blockerText)}
          onClick={(event) => {
            workspace.drawing.finish();
            if (stores.workspace.getState().mode === 'drawing') pointerRefocus(event, focusMap);
          }}
        >
          <Icon name="check" />
          {base.draw.finish}
        </button>
        {blockerText === null ? null : (
          <span className="sr-only" id="finish-reason">
            {base.draw.finishDisabled(blockerText)}
          </span>
        )}
      </div>
    </div>
  );
}

/** `hud-message[data-code]` of an edit refusal (UX section 12 codes). */
const REFUSAL_CODE: Record<NonNullable<EditState['refusal']>, HudCode> = {
  'reverted-crossing': 'crossing',
  'too-large': 'too-large',
  'min-points': 'need-more',
  'delete-would-cross': 'crossing',
  'max-points': 'max-points',
};

/** EditingShape / SavingEdit (and, read-only, a shape conflict): `options-bar[data-content=editing]`. */
export function EditHud({ variant }: { variant: HudVariant }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const edit = useStore(stores.edit, (state) => state.edit);
  const lock = useStore(stores.edit, (state) => state.lock);
  const lockHolder = useStore(stores.edit, (state) => state.lockHolder);
  const newer = useStore(stores.edit, (state) => state.newerVersion);
  const saving = useStore(stores.edit, (state) => state.saving);
  const countdownUntil = useStore(stores.edit, (state) => state.countdownUntil);
  const serverInvalid = useStore(stores.edit, (state) => state.serverInvalid);
  const dragging = useStore(stores.edit, (state) => state.dragging);
  const drafts = useStore(stores.remoteDrafts, (state) => state.drafts);
  const config = useStore(stores.runtime, (state) => state.config);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const touch = useCoarsePointer();
  const moveTip = useCollapsedTip(base.edit.movePoint);
  const deleteTip = useCollapsedTip(base.edit.deletePoint);
  const undoTip = useCollapsedTip(base.edit.undo, 'Ctrl Z');
  const editing = mode === 'editing-shape' || mode === 'saving-edit';
  if (edit === null || (!editing && mode !== 'resolving-conflict')) return null;
  const limits = drawingLimits(config);
  const points =
    dragging === null
      ? edit.points
      : edit.points.map((point, index) => (index === dragging.index ? dragging.position : point));
  const metrics = editMetrics(points);
  const dirty = isDirty(edit);
  const invalid = ringProblem(edit.points, limits) !== null;
  const focusMap = (): void => {
    workspace.ctx.map()?.focusMap();
  };
  const title = base.edit.title(displayName(edit.name));
  const tag = (
    <ModeTag icon="vector-square" text={<bdi>{title}</bdi>} tone="accent" variant={variant} kicker />
  );
  const delta = dirty ? (
    <span className="readout__delta num">{base.edit.readoutDelta(formatArea(edit.originalAreaKm2))}</span>
  ) : null;

  if (!editing) {
    // ResolvingConflict: the conflict panel owns the actions; the bar only says what is being resolved.
    return (
      <div className="hud hud--compact" data-testid="draw-hud" data-state={invalid ? 'invalid' : 'valid'}>
        {tag}
        <Separator />
        <Readout km2={metrics.areaKm2} perimeterKm={metrics.perimeterKm} variant={variant} suffix={delta} />
      </div>
    );
  }

  const otherEditor = [...drafts.values()].find((draft) => draft.areaId === edit.areaId);
  const selected = edit.selected;
  // One message, the most important wins (UX C-05: error > warning > hint); a selected point keeps its actions
  // next to whatever message shows, so a warning never hides *Move point* / *Delete point* (F-09 step 1).
  let message: StripMessage;
  const refusal = refusalText(edit.refusal, limits);
  const lockUser = displayUser(lockHolder?.displayName ?? base.collab.someone);
  if (refusal !== null) {
    message = {
      code: REFUSAL_CODE[edit.refusal ?? 'reverted-crossing'],
      severity: 'error',
      text: refusal,
      extra: { 'data-refusal': edit.refusal ?? undefined },
    };
  } else if (serverInvalid !== null) {
    const reason = geometryReason(serverInvalid.code);
    message = {
      code: 'server-invalid',
      severity: 'error',
      text: { full: base.edit.serverInvalid(reason), short: base.edit.serverInvalidShort },
    };
  } else if (newer !== null) {
    const user = displayUser(newer.user?.displayName ?? base.collab.someone);
    message = {
      code: 'newer-version',
      severity: 'warning',
      text: { full: base.edit.newerVersion(user, newer.version), short: base.edit.newerVersionShort(user) },
    };
  } else if (lock === 'both') {
    message = {
      code: 'lock-both',
      severity: 'warning',
      text: { full: base.lock.hudBoth(lockUser), short: base.lock.hudBothShort(lockUser) },
    };
  } else if (lock === 'race') {
    message = {
      code: 'lock-race',
      severity: 'warning',
      text: { full: base.lock.heldRace(lockUser), short: base.lock.heldRaceShort(lockUser) },
    };
  } else if (otherEditor !== undefined) {
    const user = displayUser(otherEditor.user.displayName);
    message = {
      code: 'other-editing',
      severity: 'warning',
      text: { full: base.edit.otherEditing(user), short: base.edit.otherEditingShort(user) },
    };
  } else if (lock === 'unknown') {
    message = {
      code: 'lock-unknown',
      severity: 'warning',
      text: { full: base.lock.unknown, short: base.lock.unknownShort },
    };
  } else if (selected !== null && edit.moveArmed) {
    message = {
      code: 'hint',
      severity: 'armed',
      text: {
        full: touch ? base.edit.movePointArmedTouch : base.edit.movePointArmed,
        short: base.edit.movePointArmedTouch,
      },
    };
  } else if (selected !== null) {
    const text = base.edit.pointSelected(selected + 1, edit.points.length);
    message = { code: 'hint', severity: 'hint', text: { full: text, short: text } };
  } else {
    message = {
      code: 'hint',
      severity: 'hint',
      text: touch
        ? { full: base.edit.hintTouch, short: base.edit.hintTouch }
        : { full: base.edit.hint, short: base.edit.hintShort },
    };
  }
  let pointActions: ReactNode = null;
  if (selected !== null && edit.moveArmed) {
    pointActions = (
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        data-testid="stop-move-button"
        onClick={(event) => {
          workspace.edit.toggleMove();
          pointerRefocus(event, focusMap);
        }}
      >
        {base.edit.stopMove}
      </button>
    );
  } else if (selected !== null) {
    pointActions = (
      <>
        <button
          type="button"
          className="btn btn-sm btn-secondary btn-collapsible"
          data-testid="move-point-button"
          {...moveTip.handlers}
          onClick={(event) => {
            moveTip.hide();
            workspace.edit.toggleMove();
            pointerRefocus(event, focusMap);
          }}
        >
          <Icon name="move" />
          <span className="btn-label">{base.edit.movePoint}</span>
          {moveTip.tip}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-ghost btn-collapsible"
          data-testid="delete-point-button"
          {...deleteTip.handlers}
          onClick={(event) => {
            deleteTip.hide();
            workspace.edit.deleteSelected();
            pointerRefocus(event, focusMap);
          }}
        >
          <Icon name="trash-2" />
          <span className="btn-label">{base.edit.deletePoint}</span>
          {deleteTip.tip}
        </button>
      </>
    );
  }

  if (variant === 'phone') {
    // A selected point's actions sit beside the two lines as 44 px icon buttons (their text stays their name), so
    // the 58 px HUD keeps its readout row and a readable message (UX C-12, UI.md section 10.13).
    return (
      <div className="hud hud--phone" data-testid="draw-hud" data-state={invalid ? 'invalid' : 'valid'}>
        {tag}
        <div className="hud-lines">
          <div className="hud-line">
            <Readout km2={metrics.areaKm2} perimeterKm={metrics.perimeterKm} variant="phone" suffix={delta} />
            <PointCount count={points.length} variant="phone" />
            {pointActions === null ? (
              <span className="hud-kicker" title={base.edit.title(edit.name)}>
                <bdi>{title}</bdi>
              </span>
            ) : null}
          </div>
          <MessageStrip {...message} />
        </div>
        {pointActions === null ? null : <div className="hud-acts--phone">{pointActions}</div>}
      </div>
    );
  }

  const saveLabel =
    countdownUntil !== null
      ? base.rate.saveButton(formatCountdown(countdownUntil - now))
      : saving
        ? base.edit.saving
        : base.edit.save;
  return (
    <div className="hud" data-testid="draw-hud" data-state={invalid ? 'invalid' : 'valid'}>
      {tag}
      <Separator />
      <Readout km2={metrics.areaKm2} perimeterKm={metrics.perimeterKm} variant="bar" suffix={delta} />
      <Separator />
      <PointCount count={points.length} variant="bar" />
      <MessageStrip {...message}>{pointActions ?? undefined}</MessageStrip>
      <div className="hud-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost btn-collapsible"
          data-testid="undo-edit-button"
          aria-keyshortcuts={UNDO_SHORTCUT}
          aria-disabled={edit.undoStack.length === 0}
          {...undoTip.handlers}
          onClick={(event) => {
            undoTip.hide();
            workspace.edit.undo();
            pointerRefocus(event, focusMap);
          }}
        >
          <Icon name="undo-2" />
          <span className="btn-label">{base.edit.undo}</span>
          <ButtonKey chip="Ctrl Z" />
          {undoTip.tip}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          data-testid="cancel-edit-button"
          aria-keyshortcuts="Escape"
          onClick={() => {
            workspace.edit.cancel();
          }}
        >
          {base.edit.cancel}
          <ButtonKey chip="Esc" />
        </button>
        {countdownUntil !== null ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              workspace.edit.cancelSaveCountdown();
            }}
          >
            {base.rate.cancel}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          data-testid="save-edit-button"
          aria-keyshortcuts={SAVE_SHORTCUT}
          aria-disabled={!dirty || invalid || saving}
          aria-description={countdownUntil !== null ? base.rate.help : undefined}
          onClick={(event) => {
            workspace.edit.save(event.detail === 0);
          }}
        >
          {saving && countdownUntil === null ? (
            <span className="spinner xs" aria-hidden="true" />
          ) : (
            <Icon name="check" />
          )}
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * PreviewingVersion: the history preview legend (UX C-13) - the colour-independent key telling the dotted ghost (the
 * old version) from the solid current shape. Non-interactive and `aria-hidden`: the banner names the version.
 */
export function PreviewLegend({ variant }: { variant: HudVariant }) {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const preview = useStore(stores.workspace, (state) => state.preview);
  const areas = useStore(stores.areas, (state) => state.byId);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  if (preview === null) return null;
  const current = areas.get(preview.areaId)?.version ?? preview.version.version;
  const date = formatShortDate(new Date(preview.version.createdAt), new Date(now));
  return (
    <>
      <ModeTag icon="history" text={base.optbar.tagPreview} tone="accent" variant={variant} />
      <div className="pv-legend" data-testid="history-preview-legend" aria-hidden="true">
        <span>
          <svg viewBox="0 0 22 8">
            <path d="M2 4h18" className="pv-legend__casing" strokeWidth="6" strokeLinecap="round" />
            <path
              d="M2 4h18"
              className="pv-legend__ghost"
              strokeWidth="3"
              strokeDasharray="0.5 5"
              strokeLinecap="round"
            />
          </svg>
          {base.history.legendGhost(preview.version.version, date)}
        </span>
        <span>
          <svg viewBox="0 0 22 8">
            <path d="M2 4h18" className="pv-legend__casing" strokeWidth="6" strokeLinecap="round" />
            <path d="M2 4h18" className="pv-legend__current" strokeWidth="3" strokeLinecap="round" />
          </svg>
          {base.history.legendCurrent(current)}
        </span>
      </div>
    </>
  );
}
