/**
 * Contract constants shared by backend and frontend (SPEC section 9.1, section 10, section 6.4). Changing a value here changes the
 * behaviour of both sides at once, which is the point of the shared package (ADR-0001).
 */

/** Geometry, text and request-size limits (SPEC section 9.1, section 6.3, section 5.5). */
export const LIMITS = {
  /** Positions over all rings, closing positions included. */
  maxPositionsTotal: 2000,
  /** 1 exterior ring + 10 holes. */
  maxRings: 11,
  /** 3 distinct vertices + the closing position (RFC 7946). */
  minRingPositions: 4,
  /** 1 m²: rejects degenerate and collinear rings. */
  minAreaKm2: 0.000001,
  /** About 4.5 x Israel. */
  maxAreaKm2: 100_000,
  /** Maximum bbox width and height of one polygon, in degrees. */
  maxExtentDeg: 20,
  /**
   * Web-Mercator latitude limit (~ atan(sinh(π))): the valid latitude range and the clamp of the EPSG:3857 math, so
   * every polygon is displayable in every base layer.
   */
  maxLatitude: 85.05112878,
  maxLongitude: 180,
  /** Code points after sanitisation. */
  nameMaxLength: 120,
  descriptionMaxLength: 2000,
  displayNameMaxLength: 64,
  /**
   * A handle (3-32 of A-Z a-z 0-9 _ . -) or an email address of up to `usernameMaxLength` characters (user decision
   * D-8), ASCII only so one lower-case fold is exact in JavaScript and PostgreSQL. Migration 0010 uses the same pattern
   * in `users_username_format_ck`.
   */
  usernamePattern:
    '^(?:[A-Za-z0-9_.-]{3,32}|(?=.{6,128}$)[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+)$',
  /** The longest username `usernamePattern` accepts (the `{6,128}` of its email branch). */
  usernameMaxLength: 128,
  passwordMinLength: 8,
  passwordMaxLength: 128,
  /** Raw (pre-sanitisation) caps: 4 x the sanitised limits, only to bound abuse. */
  nameRawMaxLength: 480,
  descriptionRawMaxLength: 8000,
  displayNameRawMaxLength: 256,
  /** Transport caps of PolygonGeometryIn (stage 0, section 9.2). */
  transportMaxRings: 64,
  transportMaxPositionsTotal: 10_000,
  transportTypeMaxLength: 32,
  /** Web-Mercator pixel span a bbox request may cover at its zoom (section 5.5). */
  bboxMaxSpanPx: 8192,
  /** Stored positions one bbox page may carry (~ 3.6 MB of GeoJSON at 7 dp, section 5.5). */
  bboxPagePositionBudget: 150_000,
  bboxParamMaxLength: 120,
  bboxPageLimitDefault: 1000,
  bboxPageLimitMax: 2000,
  cursorMaxLength: 256,
  maxZoom: 22,
  changeFeedLimitDefault: 500,
  changeFeedLimitMax: 1000,
  versionsLimitDefault: 50,
  versionsLimitMax: 200,
  versionsWithGeometryLimitMax: 20,
  auditLogsLimitDefault: 100,
  auditLogsLimitMax: 500,
  auditStatsMaxWindowDays: 31,
  /** Culled-area count cap of the first bbox page (section 5.5). */
  culledCountCap: 10_000,
  clientErrorMessageMaxLength: 500,
  clientErrorContextMaxKeys: 20,
  clientErrorBodyMaxBytes: 8192,
  requestIdPattern: '^[A-Za-z0-9._-]{1,64}$',
} as const;

/** The drawing-action limit of the assignment and the generic HTTP limits' defaults (section 10.1). */
export const RATE_LIMITS = {
  drawActionsPerWindow: 50,
  drawWindowMs: 60_000,
  clientErrorsPerMinute: 30,
} as const;

/** Realtime protocol constants (section 7). Server-side timings are configurable through env; these are client contracts. */
export const REALTIME = {
  wsPath: '/ws',
  subprotocol: 'snapland.v1',
  /** Client draft.update throttle (10 Hz). */
  draftUpdateMinIntervalMs: 100,
  /** Keepalive of an open, quiet draft (section 7.6). */
  draftTouchIntervalMs: 20_000,
  /** The client pings when nothing was received for this long (section 7.11). */
  clientPingAfterInboundIdleMs: 20_000,
  /** No message of any kind for this long -> close 4408 and reconnect. */
  clientLivenessTimeoutMs: 45_000,
  /** `welcome` must arrive this soon after `open`, else close 4408. */
  clientWelcomeTimeoutMs: 5000,
  /** Receivers drop a remote draft not updated for this long (section 7.6). */
  remoteDraftStaleMs: 15_000,
  /** Receivers ignore draft.updated for ids that ended within this window. */
  endedDraftMemoryMs: 30_000,
  /** A committed ghost stays at most this long while its area has not arrived. */
  committedGhostMaxMs: 2000,
  lockRenewIntervalMs: 10_000,
  maxDraftVertices: 2000,
  refPattern: '^[A-Za-z0-9_-]{1,64}$',
  presenceSnapshotMax: 500,
  lockSnapshotMax: 500,
  /** Client reconnect backoff: full jitter over min(cap, base, 2^attempt) (section 7.12). */
  reconnectBaseMs: 500,
  reconnectCapMs: 30_000,
  /** A WS outage shorter than this is not shown; longer than degradeAfter -> REST ("limited") mode. */
  wsGraceMs: 3000,
  wsDegradeAfterMs: 10_000,
  limitedPollChangesMs: 5000,
  limitedPollPresenceMs: 15_000,
  antiEntropyIntervalMs: 60_000,
} as const;

/**
 * The 12 collaborator colours (decision D-6, the Studio set), lowercase, in the order of `docs/design/tokens.css`
 * `--collab-1...12` (the single source; `constants.test.ts` parses it and fails on any drift). Stored in `users.color`.
 * The order is part of the contract: registration stores `USER_PALETTE[fnv1a32(id) mod 12]`, so a palette change needs
 * a migration that remaps stored colours slot by slot (0009 did it for D-6).
 */
export const USER_PALETTE = [
  '#b4f500', // lime
  '#f461ff', // orchid
  '#ffab61', // tangerine
  '#b86e3d', // copper
  '#bcfab2', // mint
  '#a64ef4', // violet
  '#9888d7', // periwinkle
  '#ff8fcb', // pink
  '#f6dd79', // gold
  '#447ec1', // cobalt
  '#c44f9d', // plum
  '#5eae29', // grass
] as const;

export type UserColor = (typeof USER_PALETTE)[number];

/** The `users_color_ck` CHECK format. */
export const COLOR_PATTERN = '^#[0-9a-f]{6}$';
