/**
 * UX timings and thresholds (docs/design/UX.md section 11) in one module so QA can reference them. Values marked "config" are
 * only fallbacks: the live values come from `GET /api/v1/config` (see `state/runtimeConfigStore.ts`). Protocol timings
 * owned by the SPEC are re-exported from `@snapland/shared` instead of being duplicated here.
 */
import { LIMITS, RATE_LIMITS, REALTIME } from '@snapland/shared';

// -- Limits (config fallbacks) ----------------------------------------------------------------
export const MAX_POSITIONS = LIMITS.maxPositionsTotal;
/** A drawn single-ring shape: the closing position counts toward MAX_POSITIONS. */
export const MAX_POINTS = LIMITS.maxPositionsTotal - 1;
export const NAME_MAX = LIMITS.nameMaxLength;
export const DESCRIPTION_MAX = LIMITS.descriptionMaxLength;
export const DISPLAY_NAME_MAX = LIMITS.displayNameMaxLength;
export const RATE_LIMIT_PER_WINDOW = RATE_LIMITS.drawActionsPerWindow;

// -- Realtime / network (SPEC) ---------------------------------------------------------------
export const DRAFT_BROADCAST_MIN_INTERVAL_MS = REALTIME.draftUpdateMinIntervalMs;
export const DRAFT_IDLE_MS = 10_000;
export const DRAFT_STALE_MS = REALTIME.remoteDraftStaleMs;
export const DRAFT_TOUCH_INTERVAL_MS = REALTIME.draftTouchIntervalMs;
export const DRAFT_RESTART_GUARD_MS = 60_000;
export const ENDED_DRAFT_IGNORE_MS = REALTIME.endedDraftMemoryMs;
export const COMMITTED_GHOST_MAX_MS = REALTIME.committedGhostMaxMs;
export const LOCK_HEARTBEAT_MS = REALTIME.lockRenewIntervalMs;
export const IDLE_AFTER_MS = 120_000;
export const WS_GRACE_MS = REALTIME.wsGraceMs;
export const WS_DEGRADE_AFTER_MS = REALTIME.wsDegradeAfterMs;
export const POLL_INTERVAL_MS = REALTIME.limitedPollChangesMs;
export const PRESENCE_POLL_MS = REALTIME.limitedPollPresenceMs;
export const ANTI_ENTROPY_MS = REALTIME.antiEntropyIntervalMs;
export const TOKEN_REFRESH_LEAD_MS = 60_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const WRITE_503_MAX_RETRIES = 3;
export const WRITE_503_DEFAULT_RETRY_MS = 5000;
/** Default countdown when a 429 carries neither `retryAfterMs` nor `Retry-After` (UX F-12). */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;

// -- Interaction and layout (UX / UI) --------------------------------------------------------
export const SPINNER_DELAY_MS = 300;
export const PROGRESS_DELAY_MS = 400;
export const BOUNDS_DEBOUNCE_MS = 250;
export const TOOLTIP_DELAY_MS = 300;
export const CLICK_TOLERANCE_PX = 5;
export const TAP_TOLERANCE_PX = 10;
export const DUPLICATE_POINT_PX = 6;
export const DUPLICATE_POINT_TOUCH_PX = 12;
export const DBLCLICK_ZOOM_REENABLE_MS = 400;
export const SNAP_FIRST_POINT_PX = 12;
export const SNAP_FIRST_POINT_TOUCH_PX = 22;
export const MIDPOINT_MIN_EDGE_PX = 40;
export const MIDPOINT_MIN_EDGE_TOUCH_PX = 88;
export const KEY_PAN_PX = 80;
export const KEY_PAN_FINE_PX = 10;
export const KEY_MOVE_POINT_PX = 10;
export const KEY_MOVE_POINT_FINE_PX = 1;
export const DRAFT_AUTOSAVE_MS = 300;
export const DRAFT_RETENTION_DAYS = 7;
export const NAME_DISPLAY_MAX_GRAPHEMES = 32;
export const USER_DISPLAY_MAX_GRAPHEMES = 20;
export const COPY_SHORT_MAX_CHARS = 40;
export const COPY_TOAST_PHONE_MAX_CHARS = 70;
export const LIST_RENDER_CAP = 200;
export const PHONE_MAX_PX = 599;
/** v2 (UX section 11): the bottom sheet and bottom bar are phone-only; 600-1,199 px use the overlay inspector. */
export const SHEET_MAX_PX = 599;
/** v2 (D-4): the inspector is docked from this width, and floats over the map from 600 px up to it (UX C-28). */
export const INSPECTOR_DOCK_MIN_PX = 1200;
/** v2: rows kept by the Activity section (UX C-31). */
export const ACTIVITY_MAX_ITEMS = 50;
/** v2 (D-5): the theme is stored per browser under this key; anything but dark / light means the default. */
export const THEME_STORAGE_KEY = 'snapland.theme';
export const THEME_DEFAULT = 'dark';
export const PRESENCE_MAX_AVATARS = 4;
export const COLLAB_BATCH_WINDOW_MS = 3000;
export const COLLAB_TOAST_MIN_GAP_MS = 5000;
export const COLLAB_BURST_LIMIT = 3;
export const COLLAB_BURST_WINDOW_MS = 60_000;
export const COLLAB_COUNTER_RESET_MS = 120_000;
export const COLLAB_SR_MIN_GAP_MS = 30_000;
export const TOAST_INFO_MS = 5000;
export const TOAST_UNDO_MS = 10_000;
export const PULSE_MS = 1500;
export const PULSE_STATIC_MS = 3000;
export const SNAP_BACK_MS = 150;
/** SPEC section 8.4; mirrored by tokens.css `--duration-layer-fade*` (parity asserted in crossfade.test.ts). */
export const LAYER_FADE_MS = 250;
export const LAYER_FADE_TIMEOUT_MS = 1500;
export const LAYER_REMOVE_CAP_MS = 5000;
export const TILE_FAIL_WINDOW_MS = 5000;
export const PANEL_SLIDE_MS = 200;

/** The list of versions requested for History (without geometry). */
export const HISTORY_PAGE_LIMIT = 50;
/** Tombstones outlive two anti-entropy rounds (SPEC section 7.12 step 5). */
export const TOMBSTONE_TTL_MS = 5 * 60_000;
export const TOMBSTONE_MAX = 10_000;
/** Store eviction threshold (SPEC section 7.12 step 4). */
export const AREA_STORE_MAX = 30_000;
/** Bbox paging (SPEC section 8.6): the SPA always asks for the largest page and follows at most 10 of them. */
export const BBOX_PAGE_LIMIT = LIMITS.bboxPageLimitMax;
export const BBOX_MAX_PAGES = 10;
export const CHANGE_FEED_PAGE_LIMIT = 500;
export const CHANGE_FEED_MAX_PAGES = 10;
/** First visit (UX F-02 step 2). */
export const DEFAULT_VIEW = { center: { lat: 31.5, lng: 34.85 }, zoom: 8 } as const;
export const MAP_MIN_ZOOM = 3;
export const MAP_MAX_ZOOM = 21;
