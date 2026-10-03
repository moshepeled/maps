/** WebSocket close codes of the `snapland.v1` protocol (SPEC section 7.11) and how the client reacts to them. */
export const CLOSE_CODES = {
  /** Normal closure (logout, page unload): do not reconnect when user-initiated. */
  NORMAL: 1000,
  /** Graceful server shutdown: reconnect with backoff (another instance picks up). */
  GOING_AWAY: 1001,
  /** Binary frame received: reconnect and report via POST /client-errors. */
  UNSUPPORTED_DATA: 1003,
  /** Abnormal closure (network loss, terminate): reconnect with backoff. */
  ABNORMAL: 1006,
  /** Message larger than 64 KiB: reconnect and report. */
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  /** Slow consumer / overloaded: reconnect with backoff (min 2 s), then resync. */
  TRY_AGAIN_LATER: 1013,
  /** Too many invalid messages: reconnect after >= 10 s and report. */
  INVALID_MESSAGES: 4400,
  /** Session revoked or expired: refresh the access token once, then reconnect or sign out. */
  SESSION_REVOKED: 4401,
  /** Client-side heartbeat / welcome timeout. */
  HEARTBEAT_TIMEOUT: 4408,
  /** Message flood: reconnect after >= 10 s. */
  FLOOD: 4429,
} as const;
