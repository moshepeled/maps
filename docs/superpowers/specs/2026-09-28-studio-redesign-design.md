# Studio redesign: design brief

- Date: 2026-09-28
- Status: approved by the product owner. They chose concept 1, Studio and answered the theme and palette questions below.
- Source concept: `docs/design/concepts/1-studio/` (`mockup.html`, `desktop.png`, `mobile.png`, `mobile-selected.png`,
  `desktop-light-1024.png`, `desktop-map-keyboard.png`, `notes.md`), and the comparison in `docs/design/concepts/README.md`.

## Decisions

| Id | Decision |
|---|---|
| D-4 | The web app adopts the **Studio** look and layout: a precision-instrument feel, docked chrome, and tabular mono values. |
| D-5 | **Dark theme is the default.** A theme switch in the user menu offers the light ("paper") variant. The choice is stored per browser in `localStorage`, key `snapland.theme`, and read inside a try/catch that falls back to dark. The OS `prefers-color-scheme` setting is not followed. |
| D-6 | The **collaborator palette** changes to the Studio neon set, in this order: `--collab-1…12` = `#b4f500` lime, `#f461ff` orchid, `#ffab61` tangerine, `#b86e3d` copper, `#bcfab2` mint, `#a64ef4` violet, `#9888d7` periwinkle, `#ff8fcb` pink, `#f6dd79` gold, `#447ec1` cobalt, `#c44f9d` plum, `#5eae29` grass. Ink on these colours is `#0a0c0f`. `USER_PALETTE` in `packages/shared` mirrors `tokens.css`. A data migration remaps each stored `users.color` from old palette index *i* to new index *i*, so the hash-based assignment stays stable. |

## Engineering rule (product owner, 2026-09-28): simple first

Every file must be as simple as possible while still following best practices. Choose the plainest design that meets the
requirement, and do not add:
- extra abstraction layers;
- configuration nobody asked for;
- generic helpers used once;
- clever CSS or TypeScript tricks.

Components should be small and focused, with clear names. Prefer plain CSS with the design tokens, and keep comments short and
about *why*. When the concept and simplicity conflict, keep the concept's look but implement it the simplest way. If you meet
existing over-engineered code in the files you own, simplify it as long as behaviour and tests stay green.

## What changes

- **Frame (desktop >= 1200 px):**
  - title bar, 44 px: brand, connection pill, presence avatars with status badges, user menu;
  - left **tool rail**, 52 px: Draw area, Edit shape, Areas in view, People, Shortcuts, with key hints in tooltips;
  - **options bar**, 44 px: the docked drawing/editing HUD with the live km² readout, points, Undo / Cancel / Finish;
  - the map;
  - docked right **inspector**, 352 px, with collapsible sections Selection, History, People and Activity. The Activity header
    says "Toasts held while you draw";
  - **status bar**, 26 px: WGS84 and ITM readout, zoom, scale bar, "N areas, X km² in view", and context key hints.
- **Below 1200 px** the inspector becomes an overlay.
- **Phone:** title bar 48, one-line HUD 58, map, and a bottom bar `Cancel ······ Undo · Finish`. AreaSelected uses a peek sheet.
  Presence collapses to a count button. Every target is at least 44 px.
- **Typography:** IBM Plex Sans for the UI, IBM Plex Mono for every value, IBM Plex Sans Hebrew for Hebrew names and attribution.
  The fonts are self-hosted, because the CSP is `font-src 'self'`. No text is smaller than 11 px.
- **Map styling:**
  - Aerial is dimmed about 26%.
  - In the dark theme the OSM "Map" layer is tinted: inverted, hue-rotated and desaturated.
  - Every overlay is a bright core on a dark casing.
  - Mine = cyan accent: my draft and my selection, the selection with CAD corner brackets and a glow. Saved areas are white/neutral.
    Others' drafts are dashed in their colour with a "Name, drawing, km²" chip.
  - The light theme uses dark cores on white casings.
- **Toasts:** one bottom-centre lane (on phones, above the control row) with an Undo countdown. Collaboration toasts are held while
  drawing (UX section 6.5).

## What does not change

Behaviour, flows, REST/WS contracts, `data-testid`s, keyboard map, accessibility rules and UX acceptance criteria. Styling and layout
change; function does not. The UX-AC ids stay stable. New criteria are appended for the theme switch and its persistence.

## Out of scope

The Measure tool: the spec dropped it and the concept removed it. Nothing else is taken from concepts 2-4.
