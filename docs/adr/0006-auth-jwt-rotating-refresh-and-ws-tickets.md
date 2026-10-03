# ADR-0006: Short-lived JWT, rotating refresh sessions, one-time WebSocket tickets

- Status: Accepted
- Date: 2026-09-27

## Context
We need username/password authentication, session management (list/revoke), and authenticated WebSockets. Long-lived tokens must not
be exposed in URLs or JavaScript-readable storage.

## Decision
- **Passwords**: argon2id via `@node-rs/argon2` (19 MiB, t=2, p=1). Prebuilt binaries cover Alpine/musl and Windows. A dummy-hash
  check for unknown users equalizes timing.
- **Access token**: JWT HS256 (jose), 15-minute TTL, kept in memory by the SPA. Verification pins algorithm, issuer and audience.
  A Redis revocation check makes logout/revoke immediate (fail-open if Redis is down, bounded by the 15-minute TTL).
- **Refresh token**: 32 random bytes in an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie. Only the SHA-256 hash is
  stored, in `sessions`. It rotates on every refresh:
  - Presenting the previous token outside a 10 s race window counts as reuse. It revokes the session and closes its sockets with
    4401.
  - Sessions slide to 14 days, with a 30-day absolute cap.
  - Tabs serialize refreshes with the Web Locks API.
- **WebSocket auth**:
  - `POST /api/v1/auth/ws-ticket` issues a 30 s, single-use ticket, stored hashed in Redis and consumed with `GETDEL` during the
    pre-upgrade hook.
  - The same hook also checks the Origin allowlist and the `snapland.v1` subprotocol.
  - Revocation events close live sockets.
- **Brute force**: 10 register/login requests per minute per IP; refresh has its own per-IP bucket (60/min, because every page load
  refreshes); login failures are capped at 5 per 15 minutes per (username, IP) and 50 per 15 minutes per username. Keying the tight
  cap by (username, IP) stops one attacker from locking a victim out by name.
- **Usernames**: a handle or an email address (user decision D-8), unique and matched case-insensitively; other users only ever
  see the display name.
- **Roles**: registration always creates role `user`. Admins are granted only by the operator CLI
  `backend/src/scripts/user-admin.ts` (`grant-admin | revoke-admin | disable | enable`). `disable` revokes every session and closes
  the user's sockets (4401) through the `sessions` bus channel. There is no bootstrap-admin setting: on a fresh deployment with
  public registration, whoever registered a listed name first would become admin.
- **Profile in the ticket**: the WS ticket carries `displayName`, `color`, `role` and `absoluteExpiresAt`, so the upgrade
  needs no user lookup and the gateway can close the socket at the session's absolute expiry.
- **Socket re-validation**: revocation events travel over at-most-once pub/sub, so every gateway also re-checks the sessions
  of its open sockets against the database every 60 s and right after its Redis subscriber reconnects, closing revoked, expired or
  disabled ones with 4401. A lost event therefore delays the close by at most one interval instead of up to the 30-day session cap.
  The `user-admin` CLI exits 1 when it could not mark a revocation in Redis or publish the event (the DB change stands).
- **Admin role is read fresh**: `requireRole('admin')` reads the current role from the database on each admin request, so
  granting or revoking admin takes effect immediately without logging the user out.
- **Upgrade flood limit**: `GET /ws` has a per-IP limit (60/min) applied before the ticket is consumed.

## Consequences
- An XSS cannot read a long-lived credential (the refresh cookie is HttpOnly). Access tokens expire quickly.
- A ticket in the query string is harmless: it is single-use, lives 30 s, and is redacted from logs.
- Sessions are revocable and listed per user.
- The design needs Redis for tickets. With Redis down, new sockets cannot be opened, and clients fall back to REST mode.

## Alternatives considered
- **Access token in the WS URL**: leaks into proxy/access logs, and is reusable.
- **First-message auth**: leaves an unauthenticated socket open, and every instance must handle a pre-auth state.
- **Server-side sessions only (cookie on every request)**: needs CSRF tokens on all mutations and a store lookup per request.
- **argon2 (node-gyp)**: needs a toolchain on Alpine.
- **Bootstrap admin by username or by a registration token**: any HTTP path to admin rights is an attack surface; a CLI run by the
  operator has none.
