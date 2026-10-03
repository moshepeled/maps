/**
 * HUD message copy (UX C-05, C-06.5, section 9.3): maps a `hud-message[data-code]` to its full sentence (screen readers,
 * the strip's `title`) and its `.short` variant, which the options-bar and phone strips show (v2; <= 40 characters
 * of fixed text).
 */
import { base } from '../base/en';
import { formatArea } from '../lib/format';
import type { DrawingLimits, HudCode } from '../state/drawingReducer';

export interface HudCopyContext {
  limits: DrawingLimits;
  /** Touch input: hints never say "click" or "press" (UX C-06.10). */
  touch: boolean;
  keyboard: boolean;
  pointCount: number;
}

export interface HudText {
  full: string;
  short: string;
}

function same(text: string): HudText {
  return { full: text, short: text };
}

/** Text of a drawing HUD message; `user` fills the collaboration codes. */
export function drawingMessage(code: HudCode, context: HudCopyContext, user = ''): HudText {
  const { limits } = context;
  switch (code) {
    case 'crossing':
      return { full: base.draw.crossing, short: base.draw.crossingShort };
    case 'spike':
      return { full: base.draw.spike, short: base.draw.spikeShort };
    case 'closing-crosses':
      return { full: base.draw.closingCrosses, short: base.draw.closingCrossesShort };
    case 'need-more':
      return same(base.draw.needThree);
    case 'zero-area':
      return { full: base.draw.zeroArea, short: base.draw.zeroAreaShort };
    case 'too-large':
      return {
        full: base.draw.tooLarge(formatArea(limits.maxAreaKm2)),
        short: base.draw.tooLargeShort(formatArea(limits.maxAreaKm2)),
      };
    case 'extent-too-large':
      return {
        full: base.draw.extentTooLarge(limits.maxExtentDeg),
        short: base.draw.extentTooLargeShort(limits.maxExtentDeg),
      };
    case 'antimeridian':
      return { full: base.draw.antimeridian, short: base.draw.antimeridianShort };
    case 'out-of-range':
      return { full: base.draw.outOfRange, short: base.draw.outOfRangeShort };
    case 'max-points':
      return {
        full: base.draw.maxPoints(limits.maxPoints),
        short: base.draw.maxPointsShort(limits.maxPoints),
      };
    case 'rate-limited':
    case 'sharing-paused':
      return same(base.rate.chipPaused);
    case 'newer-version':
      return { full: base.edit.newerVersion(user, 0), short: base.edit.newerVersionShort(user) };
    case 'other-editing':
      return { full: base.edit.otherEditing(user), short: base.edit.otherEditingShort(user) };
    case 'lock-both':
      return { full: base.lock.hudBoth(user), short: base.lock.hudBothShort(user) };
    case 'lock-race':
      return { full: base.lock.heldRace(user), short: base.lock.heldRaceShort(user) };
    case 'lock-unknown':
      return { full: base.lock.unknown, short: base.lock.unknownShort };
    case 'server-invalid':
      return {
        full: base.edit.serverInvalid(base.save.reason['generic'] ?? ''),
        short: base.edit.serverInvalidShort,
      };
    case 'hint':
      return hintText(context);
  }
}

/**
 * The idle hint: start / finish wording by input modality (UX F-03 step 1, C-06.10). The `.short` form is what the
 * options-bar and phone strips show (v2, UX C-05); the full sentence is the strip's `title` and goes to the status
 * region. Touch hints never mention clicks or keys.
 */
export function hintText(context: HudCopyContext): HudText {
  if (context.pointCount === 0) {
    if (context.keyboard)
      return { full: base.draw.hintStartKeyboard, short: base.draw.hintStartKeyboardShort };
    return same(context.touch ? base.draw.hintStartTouch : base.draw.hintStart);
  }
  if (context.pointCount < 3) return same(base.draw.needThree);
  if (context.touch) return same(base.draw.hintFinishTouch);
  return {
    full: base.draw.hintFinish,
    short: context.keyboard ? base.draw.hintFinishKeyboardShort : base.draw.hintFinishShort,
  };
}

/** `save.reason.*` for a geometry sub-code from a 422 (UX section 9.4). */
export function geometryReason(code: string | null): string {
  if (code === null) return base.save.reason['generic'] ?? '';
  return base.save.reason[code] ?? base.save.reason['generic'] ?? '';
}
