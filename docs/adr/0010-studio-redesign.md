# ADR-0010: Studio redesign - look, dark default theme and a slot-preserving palette change (user decisions D-4...D-6)

- Status: Accepted - product-owner decisions, 2026-09-28 (brief: `docs/superpowers/specs/2026-09-28-studio-redesign-design.md`).
- Date: 2026-09-28

## Context
The product owner compared four redesign concepts (`docs/design/concepts/`) and chose concept 1, Studio: docked chrome around the
map, tabular mono values, a dark default, and a neon collaborator palette that stays legible on dark imagery. The v1 palette (tokens.css
v1.1) was tuned for light chrome and a light map, so its dark colours disappear on the dimmed aerial imagery and the tinted map.

Two constraints shaped the decisions:
- **Nothing functional may move.** Flows, REST/WS contracts, test ids, the keyboard map, the accessibility rules and the UX acceptance
  criteria stay as they are. Existing criteria keep their ids, and new ones are appended.
- **A stored colour is a palette slot.** `users.color` stores `USER_PALETTE[fnv1a32(id) mod 12]` at registration (SPEC section 6.2).

## Decision
- **D-4, look and layout.**
  - The frame is docked: title bar, tool rail, options bar (the drawing HUD), inspector and status bar.
  - Type is self-hosted IBM Plex from `@fontsource/*`, so CSP `font-src 'self'` does not change.
  - Values come from `UI.md` v2 and `tokens.css`; where UI.md and UX.md differ on a control, role or id, UX.md wins (SPEC section 8.6).
- **D-5, theme.**
  - Dark is the default and the OS preference is ignored. The light theme is chosen in the user menu.
  - The choice is stored per browser in `localStorage['snapland.theme']`. Every access is in a try/catch that falls back to dark.
  - A same-origin `theme-boot.js` sets `<html data-theme>` before the first paint. The CSP forbids inline scripts, and a flash of the
    wrong theme is avoided.
  - The theme is not an account setting and never reaches the server.
- **D-6, palette.**
  - `USER_PALETTE` becomes the Studio set, in the fixed order of `tokens.css` `--collab-1…12`. `constants.test.ts` enforces the match.
  - Migration `0009_studio_palette_colors.sql` moves every stored colour from v1.1 slot *i* to Studio slot *i*, with an exact inverse.

## Alternatives considered
- **Re-derive colours from the hash** (`UPDATE users SET color = palette[fnv1a32(id) mod 12]`). This needs FNV-1a in SQL or a
  Node-side data job. The slot remap reaches the same values for every hash-assigned row, with one set-based statement.
- **Keep old colours for existing users, new palette only for new registrations.** Rejected: 24 colours cannot be kept apart, and
  the v1.1 set was tuned for light chrome, not for the dark map tone that the Studio gates check.
- **Follow the OS colour scheme** (v1 behaviour). The product owner rejected it (D-5). The frames and contrast checks are designed
  dark-first.
- **Store the theme on the account.** Rejected: that would change the REST contract. A per-browser choice is enough for a map tool
  used on one or two devices.

## Consequences
- **Pros:**
  - The contracts do not change: `color` stays a lowercase `#rrggbb` from `USER_PALETTE`, and no schema, endpoint or message changes.
  - Every user keeps their slot, so a user's colour and a newly registered user's colour agree before and after the migration.
  - The migration's reverse section restores the rows exactly. It does not touch `updated_at`, and it leaves colours outside the old
    palette alone.
- **Cons and risks:**
  - Copies of a colour outside `users` stay stale until they expire or are re-fetched: WS-ticket claims (30 s), lock records (30 s),
    cached bbox pages (`CACHE_BBOX_TTL_S`, 120 s) and open clients (until they fetch again or reload). In compose, the `migrate`
    one-shot runs before the rebuilt backends start, and sockets that reconnect rebuild presence with the new colours.
  - Self-hosted fonts add a few same-origin woff2 requests: only the weights and unicode ranges in use are fetched. `theme-boot.js`
    adds one tiny request.
  - Pale neons need a hairline edge on the light chrome. `UI.md` section 2.3 specifies it.
- **Tests:**
  - `packages/shared/src/constants.test.ts`: `USER_PALETTE` equals `tokens.css`.
  - `backend/src/modules/auth/palette.test.ts`: slot assignment.
  - `backend/test/integration/foundation/palette-migration.int.test.ts`: 0009's up and down on seeded v1.1 colours.
  - `migrations.int.test.ts`: the 9-migration round trip.
  - `contrast-check.mjs`: the palette gates.
  - UX-AC-111...123: theme and frame, as E2E tests.
