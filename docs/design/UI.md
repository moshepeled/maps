# Snapland - UI (visual design) specification, v2 "Studio"

| | |
|---|---|
| **Owner** | ui-design-expert |
| **Status** | v2.0 - the Studio redesign. It implements decisions D-4, D-5 and D-6 (`docs/superpowers/specs/2026-09-28-studio-redesign-design.md`) and supersedes v1.1. section 15 summarises what changed. |
| **Audience** | Frontend engineer (implements), QA (visual, axe, contrast and target-size checks), UX designer (flows in `UX.md`), team lead (requests in section 16) |
| **Inputs** | `instractions.md`, `docs/SPEC.md` v1.2, `docs/design/UX.md` v1.2, concept 1, Studio (`docs/design/concepts/1-studio/`) |
| **Decisions** | **D-1** Aerial shows GovMap imagery per SPEC section 8.3 / ADR-0009 (unchanged). **D-4** Studio look and layout. **D-5** Dark theme by default, with a light "paper" theme switch in the user menu, stored in `localStorage` under `snapland.theme`. The OS setting is not followed. **D-6** New collaborator palette in a fixed order. |
| **Deliverables** | This file, [`tokens.css`](tokens.css) (single source of every visual value, imported by `frontend/src/main.tsx`), [`contrast-check.mjs`](contrast-check.mjs) (CI gate, exits 1 on any failure), reference frames in [`concepts/1-studio/`](concepts/1-studio/) |
| **Precedence** | `UX.md` owns flows, copy, behaviour, the keyboard map, test ids and acceptance criteria. `SPEC.md` owns contracts. This file owns colours, type, sizes, elevation, motion, overlay styling and layout. |
| **Scope rule** | Styling and layout change. Behaviour, flows, REST/WS contracts, `data-testid`s, the keyboard map and the accessibility rules do not. Where Studio needs a new visible string, test id or criterion, section 16 asks UX to **append** it. No existing id changes. |

---

## 0. How to use this document

- **Tokens.** Every value is a token in `tokens.css`. Components reference **semantic** tokens (`--color-*`, `--ov-*`, `--map-*`, `--size-*`, `--duration-*`), never raw hex. The one exception is a person's colour. It arrives from the server as `#rrggbb` and is applied as an inline custom property (`style="--c: #b4f500"`).
- **References.** Component IDs (`C-xx`), constants (`ALL_CAPS`), copy keys (`copy.*`) and test ids refer to `UX.md`.
- **Tags.** **[M]** must-have, **[N]** nice-to-have. Untagged text is [M].
- **Reference frames** (look at the PNGs). They were rendered from `concepts/1-studio/mockup.html#theme=…&base=…&frame=…&input=…`:

  | Frame | File | What it shows | Read it with |
  |---|---|---|---|
  | Desktop 1440 x 900, dark, Aerial, drawing with the mouse | `desktop.png` | Title bar, rail, options bar, inspector, status bar. My draft is cyan. Omer's draft is dashed tangerine with a chip. Saved areas are white. The selection has CAD brackets. | A **composite**: Drawing and an open selection at once, which the app never shows together (UX section 3.4). No toast, because collaboration toasts are held while drawing. |
  | Desktop, dark, tinted OSM, drawing with the keyboard | `desktop-map-keyboard.png` | Map focus frame, C-06.9 reticle, readout of the map centre ("Map centre"), keyboard hints | Same composite rule |
  | Desktop 1024 x 768, light, OSM, area selected | `desktop-light-1024.png` | Paper chrome, light map tone, overlay inspector (below 1200 px), Undo toast bottom-centre | The light accent is now `#0d7377`. The frame still shows `#0e7490` (section 2.7). |
  | Phone 390 x 844, drawing (touch) | `mobile.png` | Title bar 48, docked HUD 58, bottom bar 72, control row, 2-line Aerial attribution, touch draft drawn closed with no cursor | |
  | Phone 390 x 844, area selected | `mobile-selected.png` | Peek sheet, own Undo toast above the control row | |

  The frames predate a few gated values: casing opacity (0.75 / 0.62 -> **0.85**), the light accent, the invalid-edge outline, the selected-segment ring (section 2.7) and the message strip (section 10.6). They also use Google Fonts and Esri tiles as stand-ins; the app self-hosts IBM Plex (section 3) and shows GovMap per D-1. Where a frame and this file disagree, **this file wins**. The v1 artefacts in `docs/design/` (`mockup.html`, `mockup-*.png`, `palette-test.html`, `palette-legibility.png`, `impl-*.png`) show v1 and are kept only as history.

---

## 1. Visual principles

1. **The map is the hero, and chrome is docked.** Studio is a precision instrument. The title bar, tool rail, options bar, inspector and status bar are docked around the map, so no panel floats over the work at desktop widths. Only small controls, chips, notices and toasts sit on the map.
2. **Chrome is greyscale; colour comes from the imagery and the shapes.** Each colour has one job:
   - **White/neutral** is saved data.
   - **Cyan** is *me*: my draft, my selection, my primary action and focus.
   - **The 12 neon colours** are *other people*, and nothing else.
   - **Red, amber, green and blue** mean state.

   No colour does double duty. Saved areas are never coloured by author.
3. **Colour is never the only identifier.** Every person-coloured mark keeps a name or initials (chip, disc, avatar). Every state that colour carries is also carried by a pattern (dash, dots, x ticks, CAD brackets) or by text.
4. **Every overlay line is a core on a casing.** In the dark map tone (imagery, and tinted OSM) a bright core sits on a dark casing. In the light tone (OSM in the light theme) a dark core sits on a white casing. Collaborator colours always keep a dark casing (section 2.5).
5. **Numbers are instruments.** Every value is set in IBM Plex Mono with tabular numerals: areas, lengths, coordinates, versions, counts and times. A number and its unit never wrap apart.
6. **No text sits directly on tiles.** Map text lives in a chip or on a translucent plate (attribution) with an opaque-enough background (section 2.6).
7. **Motion explains, never decorates.** It appears in the base-map cross-fade, the remote-change pulse, the overlay inspector, the sheet and toasts. Nothing animates forever. Every motion has a `prefers-reduced-motion` fallback.
8. **Calm density.**
   - 4 px grid.
   - 13/18 UI text, with 11 px as the hard floor.
   - Controls are 30 / 32 / 44 px.
   - **Every hit box is at least 44 x 44 whenever any pointer is coarse** (section 10.0).
9. **One token contract, two themes.** Dark is the default. Light ("paper") is a user choice. Only tokens differ between the themes; components never branch on the theme.

---

## 2. Colour

### 2.1 Chrome surfaces, borders and text

| Token | Dark (default) | Light ("paper") | Used for |
|---|---|---|---|
| `--color-bg` | `#0a0c0f` | `#e9ecf0` | **Frame:** title bar, status bar, phone bottom bar, auth page, `body` |
| `--color-surface` | `#111418` | `#f6f7f9` | Rail, options bar, inspector, sheet |
| `--color-surface-raised` | `#181c22` | `#ffffff` | Secondary buttons, cards on a surface |
| `--color-surface-raised-hover` | `#20252d` | `#e3e7ec` | Hover on a raised element; rail tool hover |
| `--color-surface-hover` | `#181c22` | `#ffffff` | Hover on a row or ghost control on a surface or the frame |
| `--color-surface-pressed` | `#20252d` | `#e3e7ec` | Active press, neutral mode tag, tags |
| `--color-surface-inset` (= `--color-surface-subtle`) | `#0c0f13` | `#eef1f4` | Readout wells, message strip, read-only fields, table headers |
| `--color-surface-sunken` | `#0c0f13` | `#e3e7ec` | Disabled button fill, skeleton base |
| `--color-surface-float` | `rgb(12 15 19 / .92)` | `rgb(255 255 255 / .96)` | Floating map controls (base-map switch, zoom, phone layer toggle) |
| `--color-input-bg` | `#0c0f13` | `#ffffff` | Text inputs. With this fill, `--color-border-strong` reaches 3:1. |
| `--color-elevated` / `-hover` | `#1a1e25` / `#242a33` | `#ffffff` / `#eef1f4` | Toasts, tooltips, popovers, menus, dialogs, map notices |
| `--color-skeleton-highlight` | `#20252d` | `#f6f7f9` | Skeleton shimmer |
| `--color-scrim` | `rgb(0 0 0 / .6)` | `rgb(18 22 28 / .4)` | Modal backdrop |
| `--color-handle` | `#3a414c` | `#c3c9d2` | Sheet grab handle (decorative) |
| `--color-border-subtle` | `#232831` | `#dce0e6` | Hairlines: bar edges, section dividers (decorative) |
| `--color-border` | `#2e343e` | `#cbd1d9` | Control rings paired with a fill, separators (decorative) |
| `--color-border-strong` | `#5c6676` | `#838c99` | Input boundaries (>= 3:1) |
| `--color-text` | `#e8ebf0` | `#12161c` | Primary text |
| `--color-text-secondary` / `--color-icon` | `#a9b2bf` | `#434c59` | Secondary text, default icons |
| `--color-text-tertiary` | `#8b95a4` | `#58616e` | Labels, meta, placeholders. At least 4.5:1 on every chrome step. |
| `--color-text-disabled` | `#5d6674` | `#9aa2ad` | Disabled labels (exempt from contrast) |
| `--color-icon-strong` | `#e8ebf0` | `#12161c` | Hovered icons |
| `--color-kbd-bg` / `-text` / `--shadow-kbd` | `#20252d` / `#e8ebf0` / inset bottom edge + `#2e343e` ring | `#ffffff` / `#12161c` / inset edge + `#cbd1d9` ring | Keyboard keys |
| `--color-neutral-badge-bg` / `-text` | `#20252d` / `#a9b2bf` | `#e3e7ec` / `#434c59` | Counts, version tags, `+n`, busy counter |
| `--color-badge-viewing-bg` / `-fg` | `#20252d` / `#a9b2bf` | `#cfd5dd` / `#2b323c` | Presence "viewing" eye badge |
| `--color-switch-track-off` / `-thumb-off` | `#8b95a4` / `#1a1e25` | `#58616e` / `#ffffff` | Switches (they sit on elevated menus) |
| `--color-switch-track-on` / `-thumb-on` | accent / on-accent | accent / on-accent | |
| `--color-segment-selected` / `-border` / `--color-on-segment-selected` | `#20252d` / `#6b7585` / `#e8ebf0` | `#e3e7ec` / `#838c99` / `#12161c` | Selected base-map segment. The 1 px ring is the >= 3:1 state indicator over any map pixel. |

### 2.2 Accent = me

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--color-accent` | `#22d3ee` | `#0d7377` | Primary buttons, the pressed-tool bar, selected tab bar, my person dot, switch on |
| `--color-accent-hover` / `-active` | `#67e8f9` / `#06b6d4` | `#0a5f63` / `#0a585b` | Primary button hover / press |
| `--color-text-on-accent` | `#03161a` | `#ffffff` | Label on the accent, glyph of my status badge |
| `--color-accent-text` (= `--color-text-link`) | `#67e8f9` | `#0a5f63` | Accent text and icons on tints and surfaces, links, toast actions |
| `--color-accent-faint` | cyan at 10% | teal at 8% | "You" tag, Current tag, *Preview*, previewing row, toast action hover |
| `--color-accent-subtle` / `-hover` | cyan at 16% / 22% | teal at 11% / 16% | Pressed rail tool, accent mode tag, selected list row |
| `--color-accent-border` | cyan at 32% | teal at 36% | Inset rings of accent tints |
| `--color-focus-ring` | = accent | = accent | Focus (section 10.0) |
| `--color-focus-ring-halo` | `#05070a` | `#ffffff` | Second ring of two-tone focus over the map |

**"Me" reads as one colour.**
- My draft, my edit, my selection, my history nodes and my person dots use the accent. On the map they use the map-tone "me" colour (section 2.5).
- My avatar keeps **my palette colour**, because that is what others see. It adds a 1.5 px accent ring outside its 2 px gap, and my status badge is accent-filled.
- The People row marks me with a "You" tag.
- The accent is never used for anyone else. The remote-change pulse uses the actor's colour.

### 2.3 Collaborator palette (D-6)

| Token | Name | Hex (server value) | Ink `#0a0c0f` on it |
|---|---|---|---|
| `--collab-1` | lime | `#b4f500` | 14.92 |
| `--collab-2` | orchid | `#f461ff` | 7.46 |
| `--collab-3` | tangerine | `#ffab61` | 10.49 |
| `--collab-4` | copper | `#b86e3d` | 4.98 |
| `--collab-5` | mint | `#bcfab2` | 16.28 |
| `--collab-6` | violet | `#a64ef4` | 4.68 |
| `--collab-7` | periwinkle | `#9888d7` | 6.38 |
| `--collab-8` | pink | `#ff8fcb` | 9.37 |
| `--collab-9` | gold | `#f6dd79` | 14.49 |
| `--collab-10` | cobalt | `#447ec1` | 4.66 |
| `--collab-11` | plum | `#c44f9d` | 4.62 |
| `--collab-12` | grass | `#5eae29` | 7.05 |

- **Assignment.** SPEC section 6.2: `users.color = USER_PALETTE[fnv1a32(userId) mod 12]`. `USER_PALETTE` in `packages/shared` **must** equal these lowercase values in this order; `constants.test.ts` parses `tokens.css` and fails on any drift. A data migration remaps every stored `users.color` from old index *i* to new index *i*, so each person keeps their slot. The client applies the value it receives and never recomputes it, except for an event actor who is not in the presence store (section 8, pulse).
- **Ink.** Anything drawn **on** a person's colour uses `--collab-ink` `#0a0c0f`: initials, status-badge glyphs, chip text and chip icons. The lowest contrast is 4.62:1 (plum). The old `--collab-on` (white) is now a deprecated alias of `--collab-ink`.
- **Never as text on chrome.** A person's colour appears on chrome only as a filled shape that carries ink (avatar, badge, disc, person chip), as an 8 px dot beside the person's name, or as a history-node ring.
  - Dots and nodes get `--shadow-collab-dot`, a hairline that gives pale neons an edge on the light chrome.
  - In the light theme avatars add `--avatar-edge`, an inset 1 px hairline.
  - A decorative status icon in a person's colour (People list) is allowed in the dark theme only, where every palette colour reaches at least 4.36:1 on `--color-surface`. The light theme uses `--color-text-secondary` for those icons, because lime or mint on white is about 1.2:1.
- **How it is checked.** `contrast-check.mjs` gates the palette:
  - ink >= 4.5:1;
  - CIEDE2000 >= 14 between any two colours in normal vision;
  - >= 6 under simulated deuteranopia and protanopia (Machado 2009, severity 1);
  - >= 15 from the reserved map colours (me, danger, saved);
  - >= 3:1 between each core and its dark casing on both map tones.

  The closest pairs are orchid/violet at 14.9 (normal), tangerine/gold at 6.6 (deuteranopia) and periwinkle/cobalt at 6.3 (protanopia). The concept's first neon draft failed these gates (gold/amber 10.4 normal, orchid/violet 0.4 under protanopia); D-6 is the rebuilt set.
- **Principle 3 still applies.** A ΔE of 6-10 is "clearly different side by side" but can still be confused from memory. That is why every person-coloured mark carries a name or initials; the palette is the second line of defence.

### 2.4 Semantic colours

| Role | Tokens | Dark | Light | Used by |
|---|---|---|---|---|
| Live / success | `--color-live` (= `-success-dot`, `-success-icon`), `-success-text`, `-success-bg`, `-success-border` | `#34d399`, `#6ee7b7`, green at 10%, 30% | `#047857`, `#065f46`, green at 9%, 32% | Live pill, success toast icon |
| Warning | `--color-warning-text`, `-icon`, `-bg`, `-border` | `#fcd34d`, `#fbbf24`, amber at 10%, 32% | `#92400e`, `#b45309`, amber at 8%, 34% | Reconnecting / Limited pill, warning strip, notices, "too large" |
| Danger | `--color-danger` (solid), `-hover`, `-text`, `-icon`, `-bg`, `-bg-hover`, `-border`, `--color-text-on-danger` | `#f87171`, `#fca5a5`, `#fca5a5`, `#f87171`, red at 8% / 14% / 34%, ink `#0a0c0f` | `#dc2626`, `#b91c1c`, `#b91c1c`, `#dc2626`, red at 6% / 10% / 34%, white | *Delete*, errors, Offline pill, error strip |
| Info | `--color-info-text`, `-icon`, `-bg`, `-border` | `#93c5fd`, `#60a5fa`, blue at 10%, 32% | `#1d4ed8`, `#2563eb`, blue at 7%, 30% | Info notices, auto-merged toast |

The *Delete* button is a tinted danger button: `--color-danger-text` on `--color-danger-bg` with an inset `--color-danger-border` ring. A solid danger fill is reserved for the invalid marker on the map (section 9.7). Info blue is deliberately far from the cyan "me".

### 2.5 Map tone, tiles and the core + casing rule

The overlay tokens (`--ov-*`), the attribution plate (`--map-attr-*`) and the map focus ring (`--map-focus-*`) depend on the **map tone**, not on the chrome theme:

| Base layer | Dark theme | Light theme |
|---|---|---|
| **Map** (OSM) | OSM **tinted**: `--map-filter-osm` = `invert(1) hue-rotate(180deg) brightness(.9) contrast(.86) saturate(.5)`. Backdrop `#1b1e22`. **Dark tone.** | OSM untouched (`--map-filter-osm: none`). Backdrop `#e8e4dc`. **Light tone.** |
| **Aerial** (imagery) | Imagery **dimmed about 26%**: `--map-filter-imagery` = `brightness(.74) saturate(.82) contrast(1.06)`, never inverted. Backdrop `#0b0e12`. **Dark tone.** | Same, **dark tone** |

- The dark-tone values live on `:root`. The light-tone values live in `:root[data-theme="light"] [data-base-layer="map"]` (the alias `osm` is also accepted). They are re-declared literally in that block, because custom properties inherit as computed values.
- Filters apply **per tile layer** (Leaflet `className`), never on `tilePane`. During a cross-fade the outgoing layer therefore keeps its own filter until it is removed.
- The tint changes OSM brand colours: parks turn dark green and highways muted rose. Geometry and labels do not change.

**Core + casing.** Widths are the core; the casing is core + extra.

| | Dark tone | Light tone |
|---|---|---|
| Casing for me / saved / invalid (`--ov-casing`, `-opacity`) | `#05070a` at **0.85** | `#ffffff` at 0.92 |
| "Me" core (`--ov-own-stroke`, `--ov-selected-stroke`, `--ov-handle-stroke`) | `#22d3ee` | `#0d7377` |
| Saved and ghost core (`--ov-area-stroke`, `--ov-ghost-stroke`) | `#eef1f5` | `#2f3a4a` |
| Invalid core (`--ov-invalid`) | `#f87171`, plus a white outline (section 9.7) | `#b91c1c` |
| Collaborators (`--ov-remote-casing`, `-opacity`, `-extra`) | `--c` on `#05070a` at 0.85, +4 px | `--c` on `#05070a` at 0.85, +3 px |

**Why 0.85.** A casing at 0.75 (the concept's value) turns mid-grey when it is composited over a bright pixel. Cobalt, plum, violet and copper then drop to 2.3:1 against their own casing. From 0.82 upwards, every palette core stays at least 3.29:1 against its casing on any pixel (section 2.6).

### 2.6 Verification (computed from `tokens.css`)

Reproduce every number with `node docs/design/contrast-check.mjs`. It has no dependencies, parses `tokens.css` (dark `:root`, the light theme and the light map tone), prints these tables, and **exits 1** if any gate fails. Translucent tokens are composited over the surface they sit on. Text needs 4.5:1; UI parts and graphics need 3:1 (WCAG 2.2 1.4.3 / 1.4.11). **Every gate passes.**

**Chrome, both themes:**

| # | Pair | Dark fg / bg | Dark | Light fg / bg | Light | Needs |
|---|---|---|---|---|---|---|
| 1 | Body text on surface (rail, options bar, inspector) | `#e8ebf0` / `#111418` | **15.45** | `#12161c` / `#f6f7f9` | **16.93** | 4.5 |
| 2 | Body text on frame (title bar, status bar) | `#e8ebf0` / `#0a0c0f` | **16.39** | `#12161c` / `#e9ecf0` | **15.31** | 4.5 |
| 3 | Body text on raised (secondary button) | `#e8ebf0` / `#181c22` | **14.31** | `#12161c` / `#ffffff` | **18.15** | 4.5 |
| 4 | Body text on elevated (toast, menu, dialog) | `#e8ebf0` / `#1a1e25` | **13.99** | `#12161c` / `#ffffff` | **18.15** | 4.5 |
| 5 | Secondary text on surface | `#a9b2bf` / `#111418` | **8.63** | `#434c59` / `#f6f7f9` | **8.11** | 4.5 |
| 6 | Secondary text on frame (status bar values) | `#a9b2bf` / `#0a0c0f` | **9.15** | `#434c59` / `#e9ecf0` | **7.33** | 4.5 |
| 7 | Secondary text on hover row | `#a9b2bf` / `#181c22` | **7.99** | `#434c59` / `#ffffff` | **8.69** | 4.5 |
| 8 | Secondary text on elevated | `#a9b2bf` / `#1a1e25` | **7.81** | `#434c59` / `#ffffff` | **8.69** | 4.5 |
| 9 | Tertiary text on surface | `#8b95a4` / `#111418` | **6.10** | `#58616e` / `#f6f7f9` | **5.85** | 4.5 |
| 10 | Tertiary text on frame (status bar labels) | `#8b95a4` / `#0a0c0f` | **6.46** | `#58616e` / `#e9ecf0` | **5.29** | 4.5 |
| 11 | Tertiary text on hover row | `#8b95a4` / `#181c22` | **5.65** | `#58616e` / `#ffffff` | **6.27** | 4.5 |
| 12 | Tertiary text on inset well / message strip | `#8b95a4` / `#0c0f13` | **6.34** | `#58616e` / `#eef1f4` | **5.53** | 4.5 |
| 13 | Tertiary text on elevated | `#8b95a4` / `#1a1e25` | **5.52** | `#58616e` / `#ffffff` | **6.27** | 4.5 |
| 14 | Link / accent text on surface | `#67e8f9` / `#111418` | **12.74** | `#0a5f63` / `#f6f7f9` | **6.92** | 4.5 |
| 15 | Accent text on elevated (toast action) | `#67e8f9` / `#1a1e25` | **11.53** | `#0a5f63` / `#ffffff` | **7.42** | 4.5 |
| 16 | Accent text on accent-faint (Current, You, Preview) | `#67e8f9` / `#13272d` | **10.69** | `#0a5f63` / `#e3ecef` | **6.19** | 4.5 |
| 17 | Accent text on accent-subtle (mode tag, pressed tool) | `#67e8f9` / `#14333a` | **9.26** | `#0a5f63` / `#dce8eb` | **5.93** | 4.5 |
| 18 | Accent text on accent-subtle-hover | `#67e8f9` / `#153e47` | **8.00** | `#0a5f63` / `#d1e2e4` | **5.55** | 4.5 |
| 19 | Primary button label | `#03161a` / `#22d3ee` | **10.25** | `#ffffff` / `#0d7377` | **5.62** | 4.5 |
| 20 | Primary button label (hover) | `#03161a` / `#67e8f9` | **12.78** | `#ffffff` / `#0a5f63` | **7.42** | 4.5 |
| 21 | Primary button label (active) | `#03161a` / `#06b6d4` | **7.63** | `#ffffff` / `#0a585b` | **8.20** | 4.5 |
| 22 | Danger text on danger bg (*Delete*) | `#fca5a5` / `#231b1f` | **8.87** | `#b91c1c` / `#f4eaec` | **5.49** | 4.5 |
| 23 | Danger text on danger bg (hover) | `#fca5a5` / `#312124` | **8.06** | `#b91c1c` / `#f3e2e4` | **5.18** | 4.5 |
| 24 | Danger text on surface | `#fca5a5` / `#111418` | **9.73** | `#b91c1c` / `#f6f7f9` | **6.04** | 4.5 |
| 25 | Danger text on elevated (error toast, dialog) | `#fca5a5` / `#1a1e25` | **8.81** | `#b91c1c` / `#ffffff` | **6.47** | 4.5 |
| 26 | Danger button label (solid) | `#0a0c0f` / `#f87171` | **7.08** | `#ffffff` / `#dc2626` | **4.83** | 4.5 |
| 27 | Warning text on warning bg (strip, notice) | `#fcd34d` / `#282519` | **10.64** | `#92400e` / `#f4ede6` | **6.11** | 4.5 |
| 28 | Warning text on warning bg (pill, title bar) | `#fcd34d` / `#221e11` | **11.54** | `#92400e` / `#e8e3dd` | **5.56** | 4.5 |
| 29 | Success text on success bg (Live pill) | `#6ee7b7` / `#0e201d` | **11.08** | `#065f46` / `#d4e4e4` | **5.86** | 4.5 |
| 30 | Info text on info bg | `#93c5fd` / `#19232f` | **8.80** | `#1d4ed8` / `#e7edf8` | **5.70** | 4.5 |
| 31 | Neutral badge (count, version tag) | `#a9b2bf` / `#20252d` | **7.19** | `#434c59` / `#e3e7ec` | **7.00** | 4.5 |
| 32 | kbd label | `#e8ebf0` / `#20252d` | **12.88** | `#12161c` / `#ffffff` | **18.15** | 4.5 |
| 33 | Selected segment label | `#e8ebf0` / `#20252d` | **12.88** | `#12161c` / `#e3e7ec` | **14.61** | 4.5 |
| 34 | Input boundary on input fill | `#5c6676` / `#0c0f13` | **3.31** | `#838c99` / `#ffffff` | **3.40** | 3 |
| 35 | Input boundary on surface | `#5c6676` / `#111418` | **3.18** | `#838c99` / `#f6f7f9` | **3.17** | 3 |
| 36 | Icons on surface | `#a9b2bf` / `#111418` | **8.63** | `#434c59` / `#f6f7f9` | **8.11** | 3 |
| 37 | Icons on frame | `#a9b2bf` / `#0a0c0f` | **9.15** | `#434c59` / `#e9ecf0` | **7.33** | 3 |
| 38 | Focus ring on surface | `#22d3ee` / `#111418` | **10.22** | `#0d7377` / `#f6f7f9` | **5.24** | 3 |
| 39 | Focus ring on frame | `#22d3ee` / `#0a0c0f` | **10.84** | `#0d7377` / `#e9ecf0` | **4.74** | 3 |
| 40 | Focus ring on raised | `#22d3ee` / `#181c22` | **9.46** | `#0d7377` / `#ffffff` | **5.62** | 3 |
| 41 | Focus ring on elevated (toast, menu) | `#22d3ee` / `#1a1e25` | **9.25** | `#0d7377` / `#ffffff` | **5.62** | 3 |
| 42 | Focus ring on accent-subtle | `#22d3ee` / `#14333a` | **7.43** | `#0d7377` / `#dce8eb` | **4.49** | 3 |
| 43 | Accent indicator on surface (rail bar, tab bar) | `#22d3ee` / `#111418` | **10.22** | `#0d7377` / `#f6f7f9` | **5.24** | 3 |
| 44 | Danger icon on surface | `#f87171` / `#111418` | **6.68** | `#dc2626` / `#f6f7f9` | **4.51** | 3 |
| 45 | Warning icon on warning bg | `#fbbf24` / `#282519` | **9.19** | `#b45309` / `#f4ede6` | **4.33** | 3 |
| 46 | Info icon on info bg | `#60a5fa` / `#19232f` | **6.24** | `#2563eb` / `#e7edf8` | **4.40** | 3 |
| 47 | Live dot on success bg (title bar) | `#34d399` / `#0e201d` | **8.79** | `#047857` / `#d4e4e4` | **4.18** | 3 |
| 48 | Switch track (off) on elevated menu | `#8b95a4` / `#1a1e25` | **5.52** | `#58616e` / `#ffffff` | **6.27** | 3 |
| 49 | Switch thumb on its track (off) | `#1a1e25` / `#8b95a4` | **5.52** | `#ffffff` / `#58616e` | **6.27** | 3 |
| 50 | Switch track (on) on elevated menu | `#22d3ee` / `#1a1e25` | **9.25** | `#0d7377` / `#ffffff` | **5.62** | 3 |
| 51 | Switch thumb on its track (on) | `#03161a` / `#22d3ee` | **10.25** | `#ffffff` / `#0d7377` | **5.62** | 3 |
| 52 | Viewing badge glyph | `#a9b2bf` / `#20252d` | **7.19** | `#2b323c` / `#cfd5dd` | **8.75** | 3 |
| 53 | Me badge glyph on accent | `#03161a` / `#22d3ee` | **10.25** | `#ffffff` / `#0d7377` | **5.62** | 3 |

Disabled text is exempt (1.4.3): 3.18 dark, 2.41 light.

**Floating map controls.** `--color-surface-float` is measured over a black or white map pixel, and the table gives the worst of the two:

| Theme | Segment / button label | Selected-segment ring | Focus ring |
|---|---|---|---|
| dark | **7.46** | **3.43** | **8.84** |
| light | **7.97** | **3.12** | **5.16** |

**Map chrome per map tone** (worst of a black or white map pixel under the translucent plate):

| Map tone | Attribution text | Attribution link | Inset link focus ring | Chip text | Chip value | Selected-chip value | Map focus ring vs halo | Ring or halo vs any pixel | Invalid marker x | Invalid tick x |
|---|---|---|---|---|---|---|---|---|---|---|
| dark | **7.50** | **9.39** | **7.53** | **13.15** | **7.34** | **10.84** | **11.16** | **3.36** | **7.08** | **7.08** |
| light | **7.88** | **5.95** | **4.50** | **16.21** | **7.76** | **5.02** | **5.62** | **3.18** | **6.47** | **6.47** |

**Collaborator palette on the map.** For the dark tone, the background is swept over every luminance from 0 to 1. For the light tone, it is the 25 OpenStreetMap Carto area and road fills.

| Token | Name | Ink | Dark tone: core vs casing | Dark tone: line vs any pixel (info) | Light tone: core vs casing | Light tone: casing vs OSM | On dark surface (info) | On light surface (info) |
|---|---|---|---|---|---|---|---|---|
| `--collab-1` | lime | **14.92** | **10.64** | 3.72 | **10.64** | **8.91** | 14.07 | 1.22 |
| `--collab-2` | orchid | **7.46** | **5.32** | 2.67 | **5.32** | **8.91** | 7.04 | 2.45 |
| `--collab-3` | tangerine | **10.49** | **7.48** | 3.14 | **7.48** | **8.91** | 9.89 | 1.74 |
| `--collab-4` | copper | **4.98** | **3.55** | 2.20 | **3.55** | **8.91** | 4.69 | 3.67 |
| `--collab-5` | mint | **16.28** | **11.61** | 3.86 | **11.61** | **8.91** | 15.35 | 1.12 |
| `--collab-6` | violet | **4.68** | **3.34** | 2.13 | **3.34** | **8.91** | 4.41 | 3.90 |
| `--collab-7` | periwinkle | **6.38** | **4.55** | 2.47 | **4.55** | **8.91** | 6.01 | 2.86 |
| `--collab-8` | pink | **9.37** | **6.68** | 2.96 | **6.68** | **8.91** | 8.83 | 1.95 |
| `--collab-9` | gold | **14.49** | **10.33** | 3.66 | **10.33** | **8.91** | 13.66 | 1.26 |
| `--collab-10` | cobalt | **4.66** | **3.32** | 2.13 | **3.32** | **8.91** | 4.40 | 3.92 |
| `--collab-11` | plum | **4.62** | **3.29** | 2.12 | **3.29** | **8.91** | 4.36 | 3.96 |
| `--collab-12` | grass | **7.05** | **5.03** | 2.60 | **5.03** | **8.91** | 6.65 | 2.59 |

The "line vs any pixel" column is informational.
- **The limit.** A near-black casing cannot reach 3:1 against backgrounds darker than about Y 0.1. On such a background only a core lighter than about Y 0.42 can reach 3:1 by itself, and the deeper neons are not that light.
- **What still holds.** The core always reaches at least 3.29:1 against its own casing, so every dashed draft line stays legible as a line. Each draft also always carries its point dots and a name chip, which identify it.
- **Why the reserved overlays pass.** Me, saved and invalid do pass this criterion (below). The invalid edge passes only because it adds a white outline.

**Colour-blind separation** (CIEDE2000, Machado 2009 severity 1):

| Vision | Closest pair | ΔE00 | Gate | Pairs below 10 |
|---|---|---|---|---|
| Normal | orchid / violet | **14.9** | >= 14 | 0 of 66 |
| Deuteranopia | tangerine / gold | **6.6** | >= 6 | 7 of 66 |
| Protanopia | periwinkle / cobalt | **6.3** | >= 6 | 10 of 66 |
| Tritanopia (not gated) | lime / mint | 5.6 | - | 4 of 66 |

| Reserved map colour | Hex | Normal (closest) | Deuteranopia | Protanopia | Gate |
|---|---|---|---|---|---|
| me, dark tone | `#22d3ee` | 29.4 (cobalt) | 7.9 (orchid) | 9.4 (pink) | normal >= 15; CVD >= 6 |
| me, light tone | `#0d7377` | 23.3 (cobalt) | 12.4 (plum) | 13.0 (plum) | normal >= 15; CVD >= 6 |
| danger, dark tone | `#f87171` | 20.1 (pink) | 8.4 (grass) | 12.3 (copper) | normal >= 15; CVD >= 3 (floor; the x pattern carries the state) |
| danger, light tone | `#b91c1c` | 20.6 (copper) | 11.7 (copper) | 16.6 (copper) | same |
| saved / ghost, dark tone | `#eef1f5` | 25.1 (mint) | 13.3 (pink) | 21.7 (pink) | normal >= 15 |
| saved / ghost, light tone | `#2f3a4a` | 27.0 (cobalt) | 26.0 (cobalt) | 20.6 (plum) | normal >= 15 |

**Reserved overlay strokes** (all required). "Line vs background" means that the core, the casing or the outline reaches 3:1 against the background. In the light tone, the dark core itself must reach 3:1 against every OSM fill, because a white casing gives no edge on light fills.

| Map tone | Overlay | Core | Core vs its casing | Line vs background |
|---|---|---|---|---|
| dark | Saved area / history ghost | `#eef1f5` | 12.32 | **3.98** |
| dark | Selection, my draft, my edit, handle ring | `#22d3ee` | 7.73 | **3.18** |
| dark | Invalid edge (with its white outline) | `#f87171` | 5.05 | **3.98** |
| light | Saved area / history ghost | `#2f3a4a` | 11.03 | **6.50** (cemetery) |
| light | Selection, my draft, my edit, handle ring | `#0d7377` | 5.39 | **3.18** (cemetery) |
| light | Invalid edge | `#b91c1c` | 6.20 | **3.66** (cemetery) |
| both | Remote-change pulse, lock ring (actor's / editor's `--c` on the dark casing; worst colour) | plum | **3.29** | (see the palette note) |

### 2.7 Values that differ from the concept frames

| Concept value | v2 value | Why |
|---|---|---|
| Casing opacity 0.75 (dark maps), 0.62 for neon on light maps | **0.85** for every casing on the dark tone and for collaborators on both tones | The concept measured against an opaque casing. Composited over a bright pixel, a 0.75 casing left cobalt, plum, violet and copper at about 2.3:1 against their own casing, and at 1.4:1 at 0.62 on OSM (section 2.5). |
| Light-theme accent `#0e7490` (text `#0b6478`) | **`#0d7377`** (text / hover `#0a5f63`, active `#0a585b`) | `#0e7490` was only 14.1 from cobalt (gate 15) and 4.7 from plum under protanopia (gate 6). `#0d7377` scores 23.3 / 12.4 / 13.0, still 3.18:1 on OSM, and white text on it is 5.62:1. |
| Invalid edge: red core on a dark casing | Adds a **white 0.75 px outline** (`--ov-invalid-outline`, at 0.9) on the dark tone | No saturated red reaches 3:1 on dark imagery by itself (2.61 at best). With the outline the edge reaches 3.98. |
| Invalid marker: white x on red | x in `--ov-invalid-glyph` (ink on the dark tone, white on the light tone). Ticks sit on an `--ov-invalid-tick-bg` disc. | White on `#f87171` is 2.8:1 |
| Selected segment ring `#2e343e` (dark) | `--color-segment-selected-border` `#6b7585` | The state indicator must reach 3:1 over any map pixel (3.43) |
| Light Live dot `#059669` | `#047857` | The dot on the pill's tint was 2.9:1; now 4.18 |
| Half-pixel text (11.5 / 12.5 / 13.5 / 17 px) | Rounded to the scale in section 3, except mono meta at 11.5 | Crisper rendering and fewer tokens |
| Inline "Enter to finish" hint in the options bar | The **message strip** inside the bar (section 10.6): one line, the `.short` copy of every message | One element (`hud-message`) for hints, warnings and errors (UX C-05 v2); the full sentence is its `title` and is announced |

### 2.8 Token migration from v1

- **Kept, same meaning, new value:**
  - every `--color-*` listed in section 2.1-section 2.4;
  - `--collab-1…12` (D-6);
  - `--font-sans` and `--font-mono` (now IBM Plex);
  - `--font-size-*` / `--line-height-*` (xl is now 18/24; 2xl 20/28 is used only by the auth title);
  - `--font-size-readout` (21/24, and 22/26 on phones);
  - `--font-size-input` (13);
  - `--radius-*`, with `--radius-xl` now 14;
  - `--shadow-1…4`;
  - `--size-topbar` (44, or 48 below 600);
  - `--size-rail-width` (52), `--size-rail-button` (36), `--size-panel-width` (352, or 340 as an overlay), `--size-bottom-bar` (72), `--size-toast-min-width` (344), `--size-control-sm` / `-md` (30 / 32), `--size-input` (36), `--size-pill` (24, or 28 below 600), `--size-tab` (36), `--size-segment` (28), `--size-chip-disc` (20), `--size-icon-sm` / `-md` (14 / 16), `--size-avatar-md` / `-lg` (26 / 28);
  - `--map-gutter` (12 at every width);
  - the overlay tokens (`--ov-*`), now dark-tone values on `:root`;
  - `--ov-chip-height` (24), `--ov-chip-ring`, `--ov-reticle-size` (56), `--ov-point-*`, `--ov-remote-point-size` (7).
- **New:**
  - `--color-surface-raised`, `-raised-hover`, `-inset`, `-float`, `--color-input-bg`, `--color-elevated`, `-elevated-hover`, `--color-handle`, `--color-accent-faint`, `--color-live`, `--color-danger-bg-hover`;
  - `--color-kbd-*`, `--color-badge-viewing-*`, `--color-switch-*`, `--color-segment-selected-border`;
  - `--brand-mark-*`, `--collab-ink`, `--shadow-collab-dot`, `--avatar-edge`;
  - `--font-hebrew`, `--font-size-2xs`, `-mono-xs`, `-readout-sm`, `-figure`, `-figure-sm`, `--letter-spacing-*` (title, caps, tag, mono, readout, figure);
  - `--space-3-5`, `--radius-chip`, `--radius-row`, `--radius-card`, `--shadow-sheet`, `--shadow-kbd`;
  - `--z-map-well`, `--z-map-focus`, `--duration-theme`;
  - `--size-options-bar`, `-message-strip`, `-status-bar`, `-section-header`, `-menu-width`, `-control-xl`, `-kbd`, `-mode-tag`, `-icon-2xs` / `-xs` / `-lg`, `-person-dot`, `-history-node`;
  - `--map-controls-w`, `--map-backdrop-*`, `--map-filter-*`, `--map-well-shadow`, `--map-attr-*`, `--map-focus-*`;
  - `--ov-area-casing-extra`, `--ov-selected-casing-extra`, `-glow`, `--ov-bracket-*`, `--ov-rubber-width`, `-casing-extra`, `--ov-closing-opacity-touch`, `--ov-remote-casing*`, `--ov-remote-rubber-*`, `--ov-invalid-outline*`, `-glyph`, `-tick-bg`, `--ov-midpoint-fill`, `--ov-chip-radius`, `-bg`, `-text*`, `-border`, `-shadow`, `-selected-*`, `--ov-reticle-line`, `-casing`, `--ov-cursor-stroke`.
- **Deprecated aliases** (they keep v1 components rendering while they are restyled; remove each one when `grep -r "var(--<name>" frontend/src` finds no use):

  | Old token | Replacement |
  |---|---|
  | `--color-inverse-surface` | `--color-elevated` |
  | `--color-inverse-surface-hover` | `--color-elevated-hover` |
  | `--color-inverse-border` | (none, transparent) |
  | `--color-inverse-text` | `--color-text` |
  | `--color-inverse-text-secondary` | `--color-text-secondary` |
  | `--color-inverse-action` | `--color-accent-text` |
  | `--color-focus-ring-inverse` | `--color-focus-ring` |
  | `--collab-on` | `--collab-ink` |
  | `--red-400` | `--color-danger-icon` |
  | `--green-400` | `--color-success-icon` |

  Toasts and tooltips are no longer an inverse surface. They are "elevated", and the standard focus ring works on them.
- **Removed:**
  - every primitive scale (`--neutral-*`, `--indigo-*`, `--red-*`, `--amber-*`, `--green-*`, `--blue-*`), because components never use primitives;
  - `--size-hud-min-width` / `-max-width`, because the HUD is docked (section 10.6);
  - `--map-controls-left-w` / `-right-w` / `-left-top`, because there is no bottom-left control column any more;
  - `--ov-outline` / `--ov-outline-extra`, replaced by the dark casing, plus `--ov-invalid-outline` for invalid edges only;
  - the `@media (prefers-color-scheme: dark)` block (D-5).
- **Runtime properties written by JS:** `--map-inset-right`, `--map-inset-bottom`, `--map-attribution-h`, plus the new `--map-inset-top` (the height of the message strip) and `--map-controls-w` (section 4.4).

---

## 3. Typography

**Faces (IBM Plex, OFL-1.1, self-hosted):**
- The CSP is `font-src 'self'`, so the fonts are bundled from `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono` and `@fontsource/ibm-plex-sans-hebrew`, and imported in `main.tsx` before `tokens.css`.
- Weights: Sans 400/500/600, Mono 400/500/600, Sans Hebrew 400/500/600.
- Subsets, which `unicode-range` downloads only on use: Sans latin + latin-ext, Mono latin, Sans Hebrew hebrew.
- `font-display: swap`. Preload Sans 400 and Mono 500 (woff2, latin). The Hebrew file loads only when Hebrew text appears.

| Stack token | Value | Used for |
|---|---|---|
| `--font-sans` | `"IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Hebrew", "Helvetica Neue", Arial, sans-serif` | All UI text. Hebrew glyphs fall through to Plex Sans Hebrew. |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, Consolas, monospace` | **Every value:** areas, lengths, coordinates, zoom, versions, counts, times, kbd, the rate countdown |
| `--font-hebrew` | `"IBM Plex Sans Hebrew", "IBM Plex Sans", system-ui, "Segoe UI", "Noto Sans Hebrew", Arial, sans-serif` | Hebrew attribution segments; `:lang(he)` / `dir="rtl"` names |

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--font-size-2xs` | 11 / 14 | 600 caps, +0.08em (`--letter-spacing-caps`) | Micro-labels (AREA, POINTS, SELECTION, HISTORY), tags (+0.05em), counts, version tags, kbd, attribution (400) |
| `--font-size-mono-xs` | 11.5 / 16 | 400-500 mono | Status bar, history times, activity meta, chip values |
| `--font-size-xs` | 12 / 16 | 400-600 | Meta, properties, hints, pill label, chips (600), message strip |
| `--font-size-sm` | 13 / 18 | 400-600 | **UI body:** buttons, rows, menu items, toasts, inputs (fine pointer) |
| `--font-size-md` | 14 / 20 | 500-600 | Wordmark (600), phone bar and sheet buttons, figure units |
| `--font-size-lg` | 16 / 24 | 400 | Inputs on coarse pointers (prevents the iOS focus zoom) |
| `--font-size-xl` | 18 / 24 | 600, −0.015em | Titles: inspector area name, phone sheet name, dialog titles |
| `--font-size-2xl` | 20 / 28 | 600 | Auth title |
| `--font-size-readout` | 21 / 24 (22 / 26 below 600) | 500 mono, −0.02em | Options-bar live area |
| `--font-size-readout-sm` | 17 | 500 mono | Options-bar point count |
| `--font-size-readout-name` | 15 | 500 mono | Options-bar AreaSelected km² |
| `--font-size-figure` | 34 / 36 | 500 mono, −0.035em | Inspector area figure |
| `--font-size-figure-sm` | 26 / 28 | 500 mono, −0.03em | Phone sheet area figure |

Rules:
- **No text is smaller than 11 px** (the chip disc's initials included). QA can assert this in the DOM (section 14).
- `font-variant-numeric: tabular-nums` on every value; number and unit in one `white-space: nowrap` span. Units are set in Sans (`km²`, `ha`) beside the mono number.
- Caps micro-labels use CSS `text-transform: uppercase` on sentence-case copy, so the copy keys do not change and Hebrew is unaffected.
- User strings go in `<bdi>` or use `dir="auto"` with `unicode-bidi: isolate` (UX section 9.12); truncation follows UX section 9.14, with the full text in `title`.
- The wordmark "Snapland" is 14/20 600, −0.01em.

---

## 4. Layout: frame, sizes, spacing

### 4.1 The frame per breakpoint

| Width | Frame (top -> bottom, left -> right) |
|---|---|
| **>= 1200** (desktop) | **Title bar 44**, [**rail 52**, stage: **options bar 44** over the **map**, **inspector 352** docked], **status bar 26**. At 1440 x 900 the map is 1036 x 786; at 1280 x 720 (E2E desktop) it is 876 x 606. |
| **900-1199** (small laptop, tablet landscape) | As desktop, but the inspector is an **overlay** of 340 over the right of the map, shown only while it has content (section 10.8.8). |
| **600-899** (tablet portrait) | **Phone frame** (UX `SHEET_MAX_PX` 899): title bar 48, HUD row 58 (Drawing / EditingShape only), map, **bottom bar 72**, **status bar 26**. The sheet (max 560 wide, centred) covers the bottom bar and sits above the status bar. |
| **< 600** (phone; designed at 390, checked at 360, works at 320) | Title bar 48, HUD row 58 (Drawing / EditingShape only), map, bottom bar 72 + `env(safe-area-inset-bottom)`. No rail and no status bar. At 390 x 844 while drawing, the map is 666 px tall, 90.8% of the viewport free of chrome (UX-AC-82 needs 45%). |

- The map is a grid cell and does **not** resize when the inspector, a strip, a notice, a toast or the sheet appears. Those overlay the map. The only resize is the phone HUD row appearing or disappearing; section 10.13 compensates for it so that content does not move on screen.
- Desktop grid: `grid-template-columns: var(--size-rail-width) minmax(0, 1fr) var(--size-panel-width)`, `grid-template-rows: var(--size-topbar) minmax(0, 1fr) var(--size-status-bar)`; the stage is a flex column (options bar, map).

### 4.2 Size tokens

| Token | Value | Notes |
|---|---|---|
| `--size-topbar` | 44 (48 < 600) | Title bar |
| `--size-rail-width` / `--size-rail-button` | 52 / 36 | Tool 36 x 36, hit 44 on coarse pointers |
| `--size-options-bar` | 44 (58 < 900) | Docked HUD; phone HUD row |
| `--size-message-strip` | 28 | Text only; 38 with buttons; 52 with buttons on coarse pointers |
| `--size-status-bar` | 26 | |
| `--size-panel-width` | 352 (340 at 900-1199) | Inspector |
| `--size-section-header` | 36 (32 in the overlay) | |
| `--size-bottom-bar` | 72 + safe area | |
| `--size-control-xs` / `-sm` / `-md` / `-lg` / `-xl` | 24 / 30 / 32 / 44 / 48 | xs, sm and md become 44 on `(pointer: coarse)` |
| `--size-input` | 36 (44 coarse) | |
| `--size-pill` | 24 (28 < 600) | Visual height; the hit box is >= `--size-hit-min` |
| `--size-tab` | 36 (44 coarse) | Details / History tabs |
| `--size-segment` | 28 (44 coarse) | Track = segment + 6 |
| `--size-mode-tag` | 26 (36 x 36 icon-only < 900) | |
| `--size-kbd` | 20 (18 in the status bar) | |
| `--size-hit-min` | 24; **44 under `(any-pointer: coarse)`** | section 10.0 |
| `--size-status-badge` / `-icon` | 16 / 10 | |
| `--size-chip-disc` | 20 | Initials 11 px |
| `--size-avatar-sm` / `-md` / `-lg` | 20 / 26 / 28 | Banners / rows / title bar |
| `--size-person-dot` / `--size-history-node` | 8 / 11 | |
| `--size-icon-2xs` ... `-lg` | 10 / 12 / 14 / 16 / 18 | Badge, chip, small, button, rail and phone bars |
| `--size-toast-min-width` / `-max-width` | 344 / 480 | Phone: full lane width |
| `--size-popover-width` / `--size-menu-width` | 288 / 248 | |
| `--size-dialog-width` / `--size-auth-card-width` | 440 (shortcuts 560) / 400 | |
| `--size-notice-max-width` | 560 | Also capped by the control column (section 10.7) |
| `--size-sheet-peek` / `-expanded` / `-conflict` | `max(176px, 30dvh)` / `min(85dvh, 100dvh − topbar − 160px)` / 50dvh | As UX section 3.2 |

### 4.3 Spacing

4 px grid:

| Token | `--space-0-5` | `-1` | `-1-5` | `-2` | `-2-5` | `-3` | `-3-5` | `-4` | `-5` | `-6` | `-8` | `-10` | `-12` | `-16` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **px** | 2 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |

`--map-gutter` is 12 at every width. It is the distance from the map edges to floating map controls, notices and toasts. Docked bars use 12-16 px side padding (section 10).

### 4.4 Runtime layout properties

The layout component writes these on the app root. Their defaults are in `tokens.css`.

| Property | Value | Consumers |
|---|---|---|
| `--map-inset-top` | Message-strip height while it is shown (28 / 38 / 52), else 0 | Top-left control column, notice slot, `fitBounds` top padding |
| `--map-inset-right` | 340 + 2 x 10 while the overlay inspector is open (900-1199), else 0 | Toast lane, notice centring, `fitBounds` |
| `--map-inset-bottom` | Current sheet height (phone frame) | Control row, attribution, toast lane |
| `--map-attribution-h` | Measured with a ResizeObserver | Toast lane, control row |
| `--map-controls-w` | Measured width of the top-left control column (>= 900) | Notice max-width |

`fitBounds` / `flyToBounds` padding is `paddingTopLeft: [24, insetTop + 24]` and `paddingBottomRight: [insetRight + 24, insetBottom + attribution + 24]`. The options bar and the docked inspector are outside the map, so they need no padding.

---

## 5. Radii

| Token | Value | Used by |
|---|---|---|
| `--radius-3xs` | 2 | 8 px selected-chip swatch |
| `--radius-2xs` | 3 | 12 px name swatch, focus ring of inline links |
| `--radius-xs` | 4 | kbd, count and version tags, Current tag, You tag |
| `--radius-chip` | 5 | Map chips, segment thumbs |
| `--radius-sm` | 6 | Buttons, icon buttons, pill, mode tag, menu items, attribution corner, tooltips |
| `--radius-row` | 7 | Rail tools, list, timeline, People and Activity rows |
| `--radius-md` | 8 | Segmented track, zoom group, presence button, inputs, popovers, menus, notices, banners |
| `--radius-card` | 9 | Readout well, toasts, phone bar buttons, phone layer toggle |
| `--radius-lg` | 12 | Overlay inspector, dialogs |
| `--radius-xl` | 14 | Bottom sheet (top corners), auth card |
| `--radius-full` | 9999 | Avatars, badges, dots, switch |

---

## 6. Elevation

Docked chrome has **no shadow**; 1 px `--color-border-subtle` hairlines separate the bars. Shadows are only for things that float. Each shadow is a 1 px ring plus a soft drop, which separates cleanly on busy imagery.

| Level | Dark | Light | Used by |
|---|---|---|---|
| `--shadow-1` | `0 0 0 1px #2e343e, 0 6px 18px rgb(0 0 0/.45)` | `0 0 0 1px rgb(15 23 42/.12), 0 4px 14px rgb(15 23 42/.12)` | Floating map controls |
| `--shadow-2` | `…#2e343e, 0 8px 22px rgb(0 0 0/.5)` | `…/.12, 0 6px 18px …/.14` | Map notices |
| `--shadow-3` | `0 0 0 1px #2d333d, 0 14px 34px rgb(0 0 0/.55)` | `…/.12, 0 14px 34px …/.18` | Toasts, popovers, menus, tooltips, overlay inspector |
| `--shadow-4` | `…#2d333d, 0 24px 56px rgb(0 0 0/.6)` | `…/.14, 0 24px 56px …/.26` | Dialogs |
| `--shadow-sheet` | `0 -1px 0 #2e343e, 0 -12px 30px rgb(0 0 0/.5)` | `0 -1px 0 #cbd1d9, 0 -12px 30px …/.16` | Bottom sheet |
| `--map-well-shadow` (tone) | `inset 0 10px 14px -12px rgb(0 0 0/.7), inset 0 0 0 1px rgb(0 0 0/.35)` | `inset 0 8px 10px -10px rgb(15 23 42/.35), inset 0 0 0 1px …/.10` | The map "well" under the docked bars: a `::after` on the map frame, `pointer-events: none`, `--z-map-well` |

---

## 7. Z-index layers

The Leaflet container gets `isolation: isolate`, so Leaflet's internal z-indices never compete with chrome.

| Layer | Token | z | Contents |
|---|---|---|---|
| **Inside the map (Leaflet panes)** | | | |
| Base tiles | `--z-pane-tiles` | 200 | The incoming layer fades in above the outgoing one |
| Remote-change pulse / lock rings | `--z-pane-pulse` / `-locks` | 390 / 395 | Under the areas |
| Saved areas | `--z-pane-areas` | 400 | Canvas; the draw order (largest first) never changes |
| Selection + hover copy, CAD brackets | `--z-pane-selection` | 405 | SVG, `interactive: false` |
| History ghost | `--z-pane-history` | 410 | |
| Remote drafts, remote edit previews, conflict "theirs", viewport frames | `--z-pane-remote` | 420 | `pointer-events: none` |
| My draft / edit, rubber-band | `--z-pane-own` | 430 | |
| Point + midpoint handles | `--z-pane-handles` | 610 | |
| Chips, x marker and ticks | `--z-pane-chips` | 640 | `pointer-events: none` |
| Collaborator cursors [N] | `--z-pane-cursors` | 660 | |
| **App (siblings of the Leaflet container, inside the map frame)** | | | |
| Map | `--z-map` | 0 | |
| Map well shadow | `--z-map-well` | 5 | `::after`, no pointer events |
| Keyboard reticle | `--z-map-reticle` | 10 | |
| Map focus frame | `--z-map-focus` | 20 | Drawn by a pseudo-element, because tiles would hide an inset ring on the container |
| Title bar, rail, options bar, status bar, map controls, bottom bar | `--z-chrome` | 100 | |
| Message strip, notices | `--z-hud` | 110 | |
| Overlay inspector, bottom sheet | `--z-panel` | 120 | The sheet covers the bottom bar |
| Popovers, menus, tooltips | `--z-popover` | 200 | |
| Toasts | `--z-toast` | 300 | |
| Scrim / dialogs | `--z-scrim` / `--z-dialog` | 400 / 410 | |
| Skip link | `--z-skip-link` | 500 | |

---

## 8. Motion

Durations and easings are unchanged from v1, because UX constants mirror them. v2 adds `--duration-theme` (0 ms).

| Token | Value | Easing | Where |
|---|---|---|---|
| `--duration-instant` | 80 ms | standard | Hover colour / background |
| `--duration-fast` | 120 ms | standard | Press, handle grow, section chevron rotation, switch thumb, tooltip out |
| `--duration-base` | 160 ms | enter | Popover, menu, tooltip in; dialog in (opacity + scale 0.98 -> 1) |
| `--duration-point-pop` / `-snap-back` | 150 ms | enter / standard | Touch point pop; invalid drag snaps back |
| `--duration-panel` | 200 ms | enter / exit | Overlay inspector: translateX(16) + opacity (UX `PANEL_SLIDE_MS`) |
| `--duration-sheet` | 240 ms | standard | Sheet snaps |
| `--duration-toast-in` / `-out` | 200 / 150 ms | enter / exit | Toast translateY(8) + opacity; then opacity |
| `--duration-remote-fade` | 300 ms | standard | Remote draft appear / pause / leave; presence avatar in and out |
| `--duration-layer-fade` / `-timeout` / `-remove-cap` | **250 / 1500 / 5000 ms** | enter | Base-map cross-fade = SPEC section 8.4; `crossfade.test.ts` asserts parity |
| `--duration-fly` | 700 ms | Leaflet | `flyToBounds` |
| `--duration-pulse` / `-static` | 1500 / 3000 ms | in-out | Remote-change pulse / reduced-motion ring |
| `--duration-skeleton` / `-progress` / `-spinner` | 1400 / 1200 / 800 ms | linear | Loaders |
| `--duration-theme` | 0 ms | - | A theme switch is instant (section 13) |

- **Base-layer cross-fade** (`crossfade.ts`): unchanged from v1 and SPEC section 8.4.
  - The incoming layer starts at opacity 0, above the outgoing one.
  - The fade starts at `load` or at the timeout, whichever comes first.
  - The outgoing layer is removed only after the incoming `load` (cap 5 s).
  - There is never a grey frame.
  - The map-tone tokens swap at the fade midpoint (125 ms) through `data-base-layer`. Because the tile filters are per layer (section 2.5), the outgoing layer keeps its own filter until it is removed.
- **Pulse** (UX C-08):
  - It is a non-interactive copy of the area outline in `--z-pane-pulse`, under the areas, in the **actor's** `--c` on the dark remote casing. It is solid, never dashed, so it cannot read as a lock.
  - Width is the area's own line plus an extra that animates from 3 to 12 px (`--ov-pulse-extra-from` / `-to`).
  - Opacity goes from 0.9 to 0 over 1500 ms, `--ease-in-out`, once.
  - Colour source: the presence store, else `USER_PALETTE[fnv1a32(actor.id) mod 12]`, else the saved neutral. It never uses the accent.
- **Reduced motion.** `prefers-reduced-motion: reduce` sets the tokens to 0 ms, with these substitutes:

  | Motion | Reduced-motion behaviour |
  |---|---|
  | Cross-fade | Instant swap once the incoming layer loads or the timeout passes. The outgoing layer is still removed only after `load`. |
  | Pulse | A static solid ring in the actor's colour (`--ov-ring-extra`) plus a person chip "{user}, updated" (`updated-chip`), both for 3000 ms |
  | Overlay inspector, sheet, toasts, popovers, dialogs, section chevrons, switch thumb | Instant |
  | Snap-back, point pop, fly-to | Instant (`fitBounds` with `animate: false`) |
  | Skeleton, progress bar, **toast Undo countdown bar** | Stop; static base; the countdown bar is hidden |
  | Spinners | Keep rotating at 1600 ms per turn; the label carries the meaning |

  JavaScript motion must read `matchMedia('(prefers-reduced-motion: reduce)')`. Never wait for `transitionend` on 0 ms.
- **Nothing loops forever.** The Live dot's ring is static; the concept's pulsing ring is not used (WCAG 2.2.2).

---

## 9. Map styling

### 9.1 Base layers

See section 2.5 for the per-theme tile filters and backdrops. Tile layers get a `className`: `snap-tiles--osm` or `snap-tiles--imagery`.

```css
.snap-tiles--osm { filter: var(--map-filter-osm); }
.snap-tiles--imagery { filter: var(--map-filter-imagery); }
```

The map frame's background is `--map-backdrop-osm` or `--map-backdrop-imagery`, switched by `[data-base-layer]`.

### 9.2 Rendering recipe

- **Saved areas** use the canvas renderer (SPEC section 8.6).
  - Read the `--ov-area-*` values in JS (`getComputedStyle(mapEl)`, `readOverlayTokens`). Re-read them on **base-layer change and on theme change**, because the map tone depends on both. Pass them as path options in one `setStyle` batch.
  - The casing is a CSS filter on the pane's canvas: `.leaflet-snap-areas-pane canvas { filter: var(--ov-halo-filter) }` (dark drop-shadows on the dark tone, white ones on the light tone).
  - **Never re-order the canvas.** Selection, hover, lock rings and pulses are separate SVG paths in their own panes (section 7).
- **Everything interactive or per-user** uses the SVG renderer. Each line is 2-3 paths:
  - optional outline (invalid edges on the dark tone);
  - casing (`stroke: var(--ov-casing)`, `stroke-opacity: var(--ov-casing-opacity)`, width core + extra);
  - core.
- Remote shapes use `--ov-remote-casing` / `-opacity` / `-extra` instead.
- Use `lineJoin: 'round'` and `lineCap: 'round'`. Dashed cores and ring bands use `lineCap: 'butt'`, so dash gaps stay crisp. A core with no fill gets `fill: none` explicitly.
- Handles, points, chips, ticks, markers and the reticle are `L.divIcon` elements styled with CSS.

### 9.3 Saved areas and area states

Widths are the core (dark / light tone values come from the tokens).

| State | Stroke | Width | Dash | Fill (dark / light tone) | Extra |
|---|---|---|---|---|---|
| Default | `--ov-area-stroke` (`#eef1f5` / `#2f3a4a`) on the casing (+3.5) | 1.75 | solid | `--ov-area-fill` .12 / .10 | |
| Hover (desktop) | Same, as an SVG copy in `--z-pane-selection` | 2.5 | solid | .18 / .16 | Cursor `pointer`. Tooltip `area-tooltip` after 300 ms: elevated, radius 6, `--shadow-3`, padding 4 8, name 13/18 500 + `· 0.84 km²` mono 12 secondary. |
| **Selected** | "Me" (`--ov-selected-stroke`) on the casing (+4.5), glow `--ov-selected-glow`, **CAD corner brackets** (section 9.4) | 2.75 | solid | "me" .13 | Not brought to front (section 9.2); [N] selected chip (section 9.8) |
| Being edited by me | "Me" | 2.5 | solid | "me" .14 | Point and midpoint handles (section 9.6) |
| Locked by other | The area keeps its own core. A **ring** in the holder's `--c` sits under it, on the remote casing, in `--z-pane-locks`. | Ring = core + casing + 6 | ring `10 5` | Default | Lock chip (person chip with a pencil 12 icon) at the label point; a 20 px initials disc below 24 px on screen, never a bare dot |
| Saving (mine) | "Me", core at 60% (`--ov-saving-core-opacity`) | 2.5 / 2.75 | solid, never dashed | "me" | Point dots kept; neutral chip with a 12 px spinner + "Saving..." |
| Just changed by other | Default + pulse (section 8) | | | | Reduced motion: static ring + `updated-chip` for 3 s |
| Simplified (low zoom) | Default | 1.5 | solid | Default | No flag |
| Conflict, mine | "Me" | 2.75 | solid | "me" .12 | |
| Conflict, theirs | Their `--c` on the remote casing | 2.5 | `8 5` | none | Person chip "{user}'s version"; *Show mine* / *Show theirs* toggles |
| History preview ghost | `--ov-ghost-stroke` (the saved neutral) on the casing | 3 | `0.5 5`, round caps = dots | .06 | Over the current shape; the legend sits in the options bar (section 10.6) |
| [N] Recently deleted preview | `--ov-area-stroke` at 50% | 2 | `4 4` | none | Chip "Deleted" (neutral) |
| [N] Collaborator viewport | `--c` on the remote casing | 1.5 | `2 4` | none | Person chip in the top-left corner |

Overlaps: smaller areas render on top. **Combinations stack; nothing is hidden** (bottom -> top):

| Combination | Drawn as |
|---|---|
| Selected + locked | lock ring (sized for 2.75) -> canvas area -> selection copy -> brackets; lock chip kept |
| My edit + another user's lock (*Edit anyway*) | lock ring -> my edit with handles -> lock chip "{user} is editing too" (`lock.chipBoth`) |
| Selected or locked + pulse | pulse -> ring -> area -> selection |
| Saving + locked | lock ring -> Saving style -> Saving chip; the lock chip moves to the other side of the label point |
| Remote edit preview + lock | lock ring -> area -> remote preview (dashed `--c` + point dots) -> chips |
| History preview + lock | ring -> area -> selection copy -> ghost |

### 9.4 Selection: glow and CAD brackets

- **Core:** "me", 2.75 px, casing +4.5 at 0.85. The SVG path gets `filter: var(--ov-selected-glow)`: `drop-shadow(0 0 5px` cyan at 55%`)` on the dark tone, `drop-shadow(0 0 3px` teal at 45%`)` on the light tone.
- **Brackets:** four L-shaped corner marks around the selection's **screen** bounding box, offset `--ov-bracket-offset` (9 px) outward, arms `--ov-bracket-size` (14 px), core `--ov-bracket-width` (1.5 px) in "me", casing +3 at 0.6, `lineCap: square`.
  - They live in `--z-pane-selection` and are recomputed on `moveend` / `zoomend` (hidden during the zoom animation).
  - They are a pattern that says "selected" without colour.
- **Chip** [N]: the selected chip at the label point (section 9.8).

### 9.5 Drafts: mine vs others'

**My shape, from drawing to saved** (the accent never flips to neutral or to a dash):

| Stage | Core | Fill | Points | Chip |
|---|---|---|---|---|
| Drawing (pointer) | "Me" 2.5 on the casing (+4). Rubber-band (last point -> cursor) "me" 2 px, `6 4`, on a +3.5 casing. Closing preview (cursor -> first point) "me" 2 px, `1 5`, round caps, 70%, no casing. | "Me" .14, including the provisional point | **Placed**: 10 px white disc, 2 px "me" ring, 1.5 px casing ring (`--ov-casing` at the casing opacity), drop `0 1px 4px rgb(0 0 0/.5)`. **First**: 14 px ring (2.5 px "me" inset ring, centre `rgb(5 7 10/.55)`, 6 px "me" centre dot, 5 px "me" halo at 18%); grows to 18 when "click to finish". **Last**: 11 px "me" fill, 2 px white ring, casing ring, 10 px "me" glow at 70%. | None; the live area is in the options bar |
| Drawing (touch) | The placed points shown **closed**: no cursor and no rubber-band. The closing edge (last -> first point) is "me" 2 px, `1 5`, 80%, on a +3 casing. | Same | Same (coarse sizes: 12 / 13 / 18) | None |
| Finished, unsaved (Naming) | "Me" 2.5, solid | .14 | 8 px non-interactive point dots stay: they are the "unsaved" marker | Neutral chip "Unsaved" (`own-shape-chip[data-state=unsaved]`) |
| Saving | Core at 60% | Same | Kept | Neutral chip: 12 px spinner + "Saving..." |
| Saved | = Selected (section 9.4) | | | |
| Save failed | Back to Finished, unsaved | | | "Unsaved" |

**Mine vs others':**

| Element | Mine (on my screen) | Others' (their `--c`) |
|---|---|---|
| Placed edges | "Me", 2.5, solid, casing | `--c`, 2.5, dash `8 5`, remote casing (+4 dark tone / +3 light tone, at 0.85) |
| Fill | "Me" .14 | `--c` .13 |
| Points | As above | **Always** 7 px `--c` dots: `0 0 0 1.5px #fff, 0 0 0 2.5px rgb(5 7 10/.7)` (a lock never has dots) |
| Rubber-band | "Me", 2 px, `6 4` | Streamed `cursor`: `--c`, 2 px, `3 4`, 85%, on a +2.5 remote casing at 0.55 (thinner and shorter-dashed than the 2.5 px `8 5` draft outline); hidden in Quiet mode |
| Label | None | Person chip at the latest point, 12 px to the right, vertically centred: "Omer, drawing, 0.46 km²" (>= 600 px); "Omer, drawing" below 600 (km² stays in `data-km2`). Edit drafts: "{user}, editing" with a pencil 12 icon. |
| Paused (`DRAFT_IDLE_MS`) | - | Shape and dots at 40% (300 ms fade). The chip becomes an **outline chip**: `--ov-chip-bg`, inset 1.5 px `--c` ring, a leading 8 px `--c` dot, `--ov-chip-text` "Dana, paused". |
| Interactivity | Interactive | `pointer-events: none` |

**Touch refused tap.**
- The would-be edge and the crossed edge show the invalid style (section 9.7) for 1.5 s, with the x marker and ticks.
- The HUD states the reason on one line.

### 9.6 Editing handles (C-12)

| Handle | Visual | Hover | Selected | Hit area |
|---|---|---|---|---|
| Point | 12 px (16 coarse): `--ov-handle-fill` white, 2 px `--ov-handle-stroke` ("me") ring, `--ov-handle-shadow` (dark tone: 1.5 px casing ring + drop; light tone: 1 px dark hairline + drop) | 16 px, 120 ms | 14 px (18 coarse): "me" fill, 3 px white ring, 1.5 px "me" outer ring | 24 px (44 whenever any pointer is coarse), transparent `div` |
| Midpoint | 8 px (12 coarse): `--ov-midpoint-fill`, 1.5 px "me" ring, 75% | 12 px, 100% | - | 24 / 44, **below** points |
| Dragging | 16 px + `--shadow-3`; cursor `grabbing`; live update | | | |
| Invalid while dragging | Adjacent edges switch to the invalid style live; on release the point snaps back over 150 ms | | | |
| *Move point* armed | A 4 px "me" halo at 22%; cursor `crosshair`; the strip turns accent (section 10.6) | | | |

Midpoints hide on edges shorter than `MIDPOINT_MIN_EDGE_PX` (40) / `MIDPOINT_MIN_EDGE_TOUCH_PX` (88).

### 9.7 Invalid shape

- **Edges:**
  - `--ov-invalid` core, 3 px, dash `2 3`, on the casing (+4).
  - **Dark tone:** a solid white outline at 0.9 outside the casing (`--ov-invalid-outline`, width = casing + 1.5).
  - Colour **and** pattern both change.
- **x ticks** (a pattern used nowhere else, so colour-blind users do not need the hue):
  - One 14 px tick halfway between the crossing and each invalid edge's farther endpoint.
  - The tick is an `--ov-invalid-tick-bg` disc (ink on the dark tone, white on the light tone) with a 1.5 px `--ov-invalid` ring and a 9 px `--ov-invalid` x (stroke 4 in a 24 grid), plus `--ov-glyph-shadow`. Both tones reach 7.08 / 6.47.
  - A closing-edge or doubling-back error has one tick at the edge midpoint.
- **Marker:**
  - A 20 px disc on the crossing: `--ov-invalid` fill, 12 px x in `--ov-invalid-glyph` (stroke 3), 2 px `--ov-invalid-tick-bg` ring, `--ov-glyph-shadow` (dark tone `0 1px 4px rgb(0 0 0/.5)`, light tone `0 1px 3px rgb(15 19 26/.3)`; also the drop of the own-draft point dots).
  - A server-reported location (SG-02) uses the same marker.
- **Cursor:** `not-allowed`.
- **Message strip:** the error state (section 10.6).

### 9.8 Chips on the map

All chips: height `--ov-chip-height` 24, radius 5, padding `0 8`, gap 6, text 12/1 600 Sans. Values are Mono 11.5/1 500. Max width 280 with an ellipsis (full text in `title`), `pointer-events: none`.

| Chip | Background | Text | Ring / shadow | Used for |
|---|---|---|---|---|
| **Neutral** | `--ov-chip-bg` (`rgb(9 11 14/.9)` dark tone / white at .95 light tone) | `--ov-chip-text`; values `--ov-chip-text-secondary` | `0 0 0 1px var(--ov-chip-border)`, `--ov-chip-shadow` | "Unsaved", "Saving...", "Deleted" [N] |
| **Selected** [N] | Same | Name `--ov-chip-text`; value `--ov-chip-selected-text` | `0 0 0 1px var(--ov-chip-selected-border)`, `--ov-chip-selected-glow`, `--ov-chip-shadow`; leading 8 px swatch ("me" at 32% + 1.5 px inset "me") | The selected area's name + km² at its label point, zoom >= 14 |
| **Person** | `--c` | `--collab-ink` (>= 4.62:1); icon 12, stroke 2.6 | `--ov-chip-ring` (1.5 px `rgb(5 7 10/.85)`) + `--ov-chip-shadow` | Remote draft, "- editing", lock, "{user}'s version", "- updated", cursor label [N] |
| **Initials disc** | `--c`, 20 px circle | Ink initials 11/1 600 | `--ov-chip-ring` | The compact form of any person chip; `aria-hidden`, full text in `title` |

The concept frames label an unselected saved area with a name chip. That illustrates the hover tooltip position. **Persistent name labels on every saved area are not part of this redesign.**

**Rules, applied in this order on every render** (unchanged from v1):
1. A lock chip on an area smaller than 24 px on screen is an initials disc.
2. A chip whose box would intersect the message strip, a notice, the top-left control column, the overlay inspector, the sheet, the control row or the toast lane flips to the other side of its anchor. If both sides collide, it becomes a disc on the anchor. A disc (or a chip that cannot collapse) that still meets one of these moves vertically clear of it, 8 px above it (below it when there is no room above), so a collaborator never sits under a toast.
3. When two chips overlap, the newer one stays full and the older one collapses to a disc. A disc never collapses further.
4. Below 600 px, remote draft chips drop the km².

A chip never leaves the visible map: it slides inward to 8 px from the edge.

Implementation notes (fix round 2; `frontend/src/map/chipPlacement.ts`, run by `MapController` after every overlay render, on `moveend` / `zoomend` and when toasts, notices, the overlay inspector or the sheet change):
- "Visible map" is the map container minus the runtime insets (section 4.4). The obstacles are the rendered boxes of the notices, the control column or row, the open overlay inspector, the sheet, each toast and the attribution.
- A side chip (draft chips, 12 px right of the anchor) tries the right, then the left. A chip centred on a label point (lock, "updated", selected) tries the label point, then its right, then its left. Each side is tried as drawn, then slid inward.
- "Newer" is the time of what the chip reports: a draft's last new rev, a lock's expiry, a pulse's end. My own chips (Unsaved, Saving..., selected) are always the newest. Neutral chips have no person to abbreviate, so they never collapse; they keep their side, slid inward.
- A collapsed chip keeps its full text in `title` and in its text content (test ids and `data-*` such as `data-km2` read the whole chip); `data-placement` is `right`, `left`, `centre` or `disc`.
- The selected chip is not drawn on an area that already carries a lock or "updated" chip at its label point (section 9.3 "lock chip kept").

### 9.9 Cursor [N], reticle and pointer

- **Collaborator cursor [N]:**
  - A 16 px arrow filled with `--c`, with a 1.5 px `--ov-cursor-stroke` outline.
  - A person-chip label (20 high, 11/1 600) at (12, 12), hidden while that user's draft chip is visible.
  - The position is interpolated over 200 ms (0 with reduced motion).
- **Keyboard reticle (C-06.9),** 56 px (`--ov-reticle-size`):
  - A circle of radius 15: 1.5 px "me" over a 4 px `--ov-reticle-casing` at 60%.
  - Four 14 px arms: `--ov-reticle-line` 2 px over a 4.5 px casing at 80%, round caps.
  - A centre dot of radius 2.5 in "me" with a 1.2 px casing stroke.
- **Position (normative, unchanged from v1).** The reticle is at the map container's centre, `reticlePx = map.getSize().divideBy(2)`, which equals `map.getCenter()` (UX-AC-21).
  - `Space` adds the point at `containerPointToLatLng(reticlePx)`.
  - `+` / `-` zoom with `setZoomAround(reticlePx, z)`.
  - `]` / `[` pan the selected point out from under the strip, notices, overlay inspector, sheet and toasts.
- **Visibility invariant.**
  - At >= 1200 nothing docked covers the map.
  - At 900-1199 the overlay inset (<= 360) is below half the narrowest stage (848 -> 424).
  - Phones show no sheet in Drawing or EditingShape, and the strip (<= 52) ends above 50% of the map height.
- **Pointer while drawing.** The cursor is `crosshair`. [N] A custom 30 px SVG cursor (white arms on a dark casing, a "me" centre dot) through `cursor: url(data:image/svg+xml,…) 15 15, crosshair`.
- When the map shows the reticle, the status-bar readout shows the **map centre** with the "Map centre" label (C-27, `desktop-map-keyboard.png`).

### 9.10 Map chrome on the map

- **Map focus** (`:focus-visible` on the Leaflet container):

  ```css
  .map-frame:has(> .leaflet-container:focus-visible)::after {
    inset: 0;
    z-index: var(--z-map-focus);
    pointer-events: none;
    box-shadow:
      inset 0 0 0 2px var(--map-focus-ring),
      inset 0 0 0 3.5px var(--map-focus-halo),
      inset 0 0 0 6px var(--map-focus-glow);
  }
  ```

  The ring reaches 11.16 / 5.62 against its halo, and ring or halo reaches 3:1 against any pixel of the tone (section 2.6).
- **Floating controls** (switch, zoom, layer toggle) use a two-tone ring: `box-shadow: 0 0 0 2px var(--color-focus-ring), 0 0 0 3.5px var(--color-focus-ring-halo)`.
- **Attribution:**
  - Plate: bottom-right of the map (phone: bottom = `--map-inset-bottom`). `--map-attr-bg`, radius 6 on the top-left, padding `3 8 3 9` (phone `2 8`).
  - Text: 11/15 `--map-attr-text` (phone 11/14, up to 2 lines, right-aligned). Links in `--map-attr-link` with no underline (underlined on hover or focus).
  - Hebrew segments are in `<bdi dir="rtl">` with `--font-hebrew`.
  - **Link focus** is an inset ring: `outline: none; border-radius: 3px; padding: 0 2px; margin: 0 -2px; box-shadow: inset 0 0 0 2px var(--map-focus-ring)` (7.53 / 4.50).
  - A ResizeObserver writes `--map-attribution-h`.
  - Content follows D-1 / SPEC section 7: Aerial is the GovMap + Esri credit only; Map is OpenStreetMap only.
  - It is never covered: the overlay inspector ends above it (section 10.8.8), and the control row and toasts ride above it.
  - **Targets.** The credit links are inline in the credit text, so WCAG 2.5.8's inline exception applies; on coarse-pointer phones their hit box still grows to 24 px with vertical padding on the inline box (no layout change, clear of the control row). *(Fix round 2; the UX 2.5.8 row should note the exception.)*

---

## 10. Components

### 10.0 States and target sizes

| State | Treatment |
|---|---|
| Hover | `--color-surface-hover` (on surface or frame), `--color-surface-raised-hover` (on raised or rail), `--color-elevated-hover` (on elevated); icons go to `--color-icon-strong`. 80 ms. |
| Focus-visible | 2 px `--color-focus-ring` outline, offset 2 (the same on every surface, including toasts and menus). Two-tone over the map (section 9.10). Inset (`inset 0 0 0 2px`) inside rows that fill their container (timeline, lists, menu items). |
| Active | `--color-surface-pressed` / `--color-accent-active` |
| Disabled | `aria-disabled="true"`, still focusable. Text `--color-text-disabled`, fill `--color-surface-sunken` (transparent for ghost buttons), cursor `not-allowed`, and a tooltip or description with the reason. |
| Loading | A 14-16 px spinner replaces the icon. The label changes ("Saving..."), the width is locked, and `pointer-events: none`. |

**Targets** (UX C-05, WCAG 2.5.8, UX-AC-70) work exactly as in v1:
1. **Hit boxes** grow to 44 under `(any-pointer: coarse)`.
2. **Visuals** grow under `(pointer: coarse)`.
3. Compact filled visuals sit centred in a transparent **hit wrapper** that is the `<button>`: the pill (24/28), Quiet chip (24), phone presence count, count and version tags that are buttons, and toast actions.

| Control | Visual (fine) | Hit (any coarse) |
|---|---|---|
| Rail tool | 36 x 36 | 44 x 44 (the rail is 52 wide) |
| Options-bar buttons | 30 | 44 |
| Inspector buttons, icon buttons, toast actions / dismiss, menu items | 32 | 44 |
| Section header (collapsible) / tabs | 36 / 36 | 44 |
| Base-map segments / zoom | 28 / 34 x 32 | 44 / 44 x 44 |
| Pill / Quiet chip / presence button | 24 / 24 / 38 | 44 high |
| Phone bar, sheet and dialog buttons, layer toggle, zoom pair, presence count, menu button | 44-48 | 44-48 |
| Handles | 12-18 visual | 24 / 44 |
| Attribution links | Inline | Inline (the WCAG 2.5.8 inline exception) |

### 10.1 Primitives

| Primitive | Spec |
|---|---|
| **Button** | sm 30 (options bar) / md 32 (inspector, dialogs, toasts) / lg 44 / xl 48 (phone bottom bar); all 44 on coarse pointers. Padding 0 12 (lg 0 14, xl 0 16). Radius 6 (lg and xl 8-9). Label 13/18 500; primary 600; lg and xl 14/20. Icon 16 (lg and xl 18), gap 7. Optional trailing **kbd hint** in Mono 11/1 500 at 75% opacity (for example `Esc`, `Ctrl Z`, `E`), >= 1200 only, hidden when single-key shortcuts are off (letters only). **Variants:** **primary** (`--color-accent` / `--color-text-on-accent`, hover `-accent-hover`); **secondary** (`--color-surface-raised` + inset 1 px `--color-border`, hover `-raised-hover`); **ghost** (transparent, `--color-text-secondary`, hover surface-hover + text); **danger** (`--color-danger-text` on `--color-danger-bg` + inset 1 px `--color-danger-border`, hover `-danger-bg-hover`); **danger-ghost** (danger text, transparent, hover `--color-danger-bg`). At most one primary per surface. A pressed toggle (`aria-pressed="true"`) uses `--color-accent-subtle` + inset accent-border + accent-text. |
| **Icon button** | 32 x 32 (44 coarse), radius 6, icon 16 in `--color-icon`; hover surface-hover + `--color-icon-strong`. Always has an `aria-label`. Phone bars use 44 x 44 with 18-20 icons. |
| **Mode tag** | 26 high, radius 6, padding `0 10 0 8`, gap 7, 12/16 600 +0.01em, icon 14. **Accent** (Drawing, Editing, Naming): `--color-accent-subtle` + inset `--color-accent-border` + `--color-accent-text`. **Neutral** (Area selected): `--color-surface-pressed` + inset `--color-border` + `--color-text`. Below 900: 36 x 36 icon-only, radius 8, icon 20, with an `aria-label`. |
| **Input** | Height 36 (44 coarse), radius 8, fill `--color-input-bg`, 1 px `--color-border-strong`, padding 0 10, text `--font-size-input`. Placeholder in tertiary. Hover border `--color-text-tertiary`. **Focus:** accent border + 1 px inner accent ring + 3 px `--color-accent-faint` halo. **Invalid:** danger border + inner ring, message row below (14 px `circle-alert` + 12/16 `--color-danger-text`, `aria-describedby`). **Read-only:** `--color-surface-inset`, `--color-border`, text-secondary. Label 12/16 500 text-secondary above, gap 6; hint 12/16 tertiary below. Counter 11 Mono tertiary, right-aligned, only from 80% of the maximum (UX C-09). |
| **Textarea** | As the input; minimum height 76; vertical resize only. |
| **Select** (sort) | 30 high (44 coarse), radius 6, fill input-bg, 1 px `--color-border`, 12 px text, 14 px chevron. |
| **Radio** | 16 px circle, 1.5 px `--color-border-strong`; checked: 5 px accent border. The hit area is the whole label row. |
| **Switch** | Track 28 x 16, radius full, thumb 12 with 2 px inset. Off: `--color-switch-track-off` / `-thumb-off`, thumb left. On: `-track-on` / `-thumb-on`, thumb right. 120 ms slide. The row is the hit area (32 / 44). |
| **Tooltip** | Elevated, radius 6, `--shadow-3`, padding 4 8, 12/16 text (the label + kbd 18 high), max width 240, offset 8. Delay 300 ms in, 120 ms out. Hoverable, closes on `Esc`, appears on focus (1.4.13). The rail and status bar use tooltips for key hints. |
| **kbd** | Min width 20, height 20 (18 in the status bar), padding 0 5, radius 4, `--color-kbd-bg`, `--shadow-kbd`, Mono 11/1 500 `--color-kbd-text`. |
| **Count / version tag** | Count: min width 18 x 17, padding 0 5, radius 4, neutral badge, Mono 11/1 500. Version: padding 3 5, radius 4, neutral badge, Mono 11/1 600. |
| **Menu** | Popover `--size-menu-width` 248, elevated, radius 8, `--shadow-3`, padding 6. Items 32 (44 coarse), padding 0 10, radius 6, gap 10, 16 icon in `--color-icon` + 13/18 label; hover and focus `--color-elevated-hover`; trailing kbd, switch or a 16 accent `check` (radio items). Separators 1 px `--color-border-subtle`, margin 4 0. Help under an item: 12/16 tertiary, indented 36. |
| **Spinner** | 16 px (12 in pills, chips and strips), 2 px `currentColor` ring with the right quarter transparent, 800 ms linear. |
| **Skeleton** | Bars radius 4, height 12 (text) or 10 (meta); gradient `--color-surface-sunken` -> `--color-skeleton-highlight` -> sunken, 1400 ms. Shown after `SPINNER_DELAY_MS`. |
| **Skip link** | First focusable. Hidden until focused, then fixed at (8, 8): 44 high, padding 0 16, radius 8, elevated, 13/18 600 text, `--shadow-3`, `--z-skip-link`. Focuses the map. |
| **Boot** | `--color-bg`. After `SPINNER_DELAY_MS`: the 40 px brand mark, a 16 px gap, a 20 px `--color-icon` spinner, and a hidden "Loading Snapland..." in `role="status"`. |

### 10.2 Title bar (C-02) and user menu

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Snapland  (● Live) [Quiet mode]                               (Mo⊕)(OC⊕)(DL◉)  3 online │ Moshe ⌄        │ 44
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 14 · mark 24 · 9 · wordmark · 12 · pill · 12 · chip             avatars 28, gap 10 · 12 · label   div 1×18 · menu 32 · 10
```

- **Bar:** `--color-bg`, 1 px `--color-border-subtle` bottom border, height 44, padding `0 10 0 14`, gap 12.
- **Brand:** the mark (24) + the wordmark (14/20 600, −0.01em), gap 9. It is not a link on the map page.
  - The mark (24 grid) is a rounded square (inset 0.75, radius 6) filled with `--brand-mark-bg` and stroked 1 px in `--brand-mark-edge`.
  - Inside it is the quadrilateral `M6.5 8.2 15.8 5.9 18 15.4 8.6 18.1Z`: fill `--brand-mark-fill`, 1.5 px `--brand-mark-line` stroke, round joins.
  - It has four 3 x 3 vertex squares (radius 0.6) at (5, 6.7), (14.3, 4.4) and (16.5, 13.9) in `--brand-mark-vertex`, and at (7.1, 16.6) in `--brand-mark-line`.
  - The favicon uses the dark variant.
- **Right side:** the presence button (section 10.4), a 1 x 18 `--color-border` divider, the **user menu button**. The concept's keyboard icon button is not rendered: *Keyboard shortcuts* is the tool rail's `shortcuts-button` (section 10.5) and a user-menu item (UX C-02 v2).
- **User menu button** (`user-menu-button`): 32 high, padding `0 8 0 10`, radius 6, gap 6, 13/18 500 display name + `chevron-down` 14 tertiary. Hover surface-hover; open surface-pressed; `aria-haspopup="menu"`.
  - Keyboard (APG menu button): `Enter`, `Space` or `↓` open the menu with focus on its first item, `↑` on its last; `↑` / `↓` move through the items, `Home` / `End` jump; `Esc` closes it and returns focus to the button. A pointer open leaves focus on the button.
- **User menu** (section 10.1 menu, anchored bottom-end, offset 6):
  - Header (not interactive): display name 13/18 600 + username 12/16 tertiary, padding `6 10 8`, then a separator.
  - Items, in order:
    - *Keyboard shortcuts* (`keyboard`, kbd `?`)
    - separator
    - *Quiet mode* (`bell-off`, switch, `quiet-toggle`), with its help line
    - **Theme** group (`theme-switch`, `role="group"`, visible label "Theme"): *Dark* (`moon`, `theme-option-dark`) and *Light* (`sun`, `theme-option-light`), two `menuitemradio` items with a trailing `check` on the checked one (UX C-30)
    - [N] *Show collaborators' cursors* (`mouse-pointer-2`, switch)
    - *Undo last action* (`undo-2`, `menu-undo-last`; only while valid; a 12/16 tertiary sub-line)
    - separator
    - *Sign out* (`log-out`)
  - Choosing a theme keeps the menu open with focus on the chosen item, like Quiet mode, and applies at once (section 13).
- **Phone (< 600):**
  - Height 48, padding `0 4 0 12`, gap 10.
  - Mark 28. The wordmark shows only from 400 px (UX section 3.2).
  - The pill uses 28 visual height and short labels.
  - Spacer, then the **presence count** button (`presence-button`): 44 high, padding 0 12, gap 7, `users` 18 secondary + count Mono 14/1 600 text; `aria-label` `base.presence.count`.
  - Then the **menu** icon button (44, `menu` 20), which opens the same menu.
  - **Quiet** shows as a 16 px badge at the menu button's top-right (4, 4): neutral badge disc, `bell-off` 10 (stroke 2.5), 2 px `--color-bg` ring, `quiet-chip`; the `aria-label` becomes `base.menu.labelQuiet`.
  - Budget at 360 and 320 px for every pill state with Quiet on (UX-AC-81): `scrollWidth` equals the viewport.

### 10.3 Connection pill (C-16) and Quiet chip

- **Visual:** height `--size-pill` (24; 28 < 600), radius 6, 1 px border, padding `0 10 0 9`, gap 7, label 12/16 500.
- **Hit:** `<button data-testid="connection-status">` is a transparent wrapper >= `--size-hit-min`; the focus ring is drawn on the visible pill.

| State | Background / border / text | Leading | Label >= 600 | < 600 |
|---|---|---|---|---|
| Connecting | surface-pressed / border / text-secondary | 12 spinner | Connecting... | Connecting... |
| **Live** | success bg / border / text | 7 px `--color-live` dot + a static 1.5 px ring at inset −4, 35% | Live | Live |
| Reconnecting | warning bg / border / text | 12 spinner, warning icon colour | Reconnecting... | Retrying... |
| Limited connection | warning | `cloud-off` 14 | Limited connection | Limited |
| Offline | danger bg / border / text | `wifi-off` 14 | Offline | Offline |
| Signed out | surface-pressed / border / text-secondary | `lock` 14 | Signed out | Signed out |

- **Detail popover:** 288 wide, elevated, radius 8, `--shadow-3`, padding 12 14. It holds a 16 icon + 13/18 600 title (always the full label), a 13/18 secondary body and a sm secondary *Reconnect now* (`refresh-cw`).
- **Quiet chip** (>= 600): 24 high, radius 6, neutral badge, `bell-off` 12 + "Quiet mode" 12/16 500, inside a hit wrapper (`quiet-chip`). It opens the user menu focused on the Quiet switch.

### 10.4 Presence (C-25)

- **Avatar** (28 in the title bar, 26 in rows, 24 in toasts, 20 in banners):
  - Disc in `--c`; initials 11/1 600, +0.02em, `--collab-ink`.
  - `box-shadow: 0 0 0 2px <the surface it sits on>, var(--avatar-edge)`.
  - **Me:** add `0 0 0 3.5px var(--color-accent)` outside the gap.
  - Initials are the first grapheme of each of the first two words ("Mo", "OC", "DL" as in the frames).
- **Status badge:**
  - A 16 px disc at (−6, −6) from the avatar's bottom-right, with a 2 px ring in the bar colour.
  - Glyph 10 px, stroke 3: `plus` = drawing a new area, `pencil` = editing, [N] `clock` = idle.
  - Colours: the disc is `--c` with an ink glyph; **for me** the disc is `--color-accent` with an `--color-text-on-accent` glyph.
  - **Viewing** shows a quiet `eye` badge (`--color-badge-viewing-bg` / `-fg`); v1 showed no badge (section 16).
  - **Limited:** no badges. **Offline:** avatars at `grayscale(1)` and 55% opacity.
- **Title-bar presence button** (`presence-button`, >= 600):
  - min-height 38 (>= 44 on coarse), radius 8, padding `0 12 0 6`, gap 12.
  - Up to 4 avatars including me, gap 10 with no overlap (badges stick out 6), then a `+n` disc (28, neutral badge, Mono 11/600).
  - Then "{n} online" (12/16 secondary; >= 1200 only; new copy, section 16).
  - Hover surface-hover; open or focused-section state surface-pressed.
  - **Busy counter** (UX section 6.1): a neutral pill 20 high, padding 0 7, Mono 11/600, `data-changes`. On phones the count button shows a 6 px neutral dot at its top-right instead.
- **Presence list**, where it lives:
  - **>= 1200:** the docked **People** section of the inspector (section 10.8.6). `P`, a click on the avatar stack, and the rail *People* tool all expand that section if it is collapsed, scroll it into view and move focus to its header.
  - **< 1200:** the popover: 288 wide, elevated, radius 8, `--shadow-3`, padding 6, max height `min(420px, 60vh)`, anchored bottom-end with an 8 px offset.
  - Only one of the two is rendered, so `presence-list` is unique.
- **Rows** (both places):
  - Min height 42, padding 0 12, gap 12, radius 7; non-interactive. [N] *Show on map* is a trailing 32 icon button (`scan`).
  - Avatar 26 with its badge.
  - Name: 13/18 500 text, plus a **You** tag (11/1 600, `--color-accent-text` on `--color-accent-faint`, radius 4, padding 2 5).
  - Status line, 12/16, truncated:
    - drawing or editing: secondary text with a 12 px icon (stroke 2.25) in `--c` (dark theme) or `--color-text-secondary` (light theme), or accent-text for me;
    - viewing or idle: tertiary text with an `eye` / `clock` icon.
  - "In view" 11/14 tertiary, right-aligned.
  - `presence-item[data-user-id][data-status]`.
  - Header of the popover or section: the micro-label + count.
  - **Only you:** my row + `base.presence.onlyYou` 13/18 tertiary. **Limited:** names only + the note 12/16 tertiary under the header.
- **Joins and leaves:** 300 ms opacity + scale 0.9 -> 1 (instant with reduced motion).

### 10.5 Tool rail (C-03, >= 900)

- **Container:** width 52, `--color-surface`, 1 px `--color-border-subtle` right border, padding 8 0, gap 4, centred column.
- **Tools:** 36 x 36, radius 7, icon 18 (stroke 1.75) in `--color-text-secondary`. The tooltip sits on the right with an 8 px offset: "{label}  {kbd}" (no letter when single-key shortcuts are off).

| State | Treatment |
|---|---|
| Hover | `--color-surface-raised-hover` + text |
| Pressed | `--color-accent-subtle` + inset 1 px `--color-accent-border` + `--color-accent-text`, plus a 2 x 20 accent **indicator bar** flush with the rail's left edge (radius 0 2 2 0) |
| Disabled | `aria-disabled`, `--color-text-disabled`, no hover, tooltip with the reason |
| Focus | 2 px ring, offset 2 |

| Order | Tool | Icon | Key | Test id | Pressed / enabled |
|---|---|---|---|---|---|
| 1 | Draw area | `snap-polygon-plus` (section 12) | D | `draw-button` | Pressed in Drawing. Disabled while busy (`base.draw.busy`). |
| 2 | Edit shape | `vector-square` | E | new (section 16) | Enabled exactly when `edit-shape-button` is. Pressed in EditingShape. Same action as `E`. |
| - | separator 24 x 1 `--color-border`, margin 6 0 | | | | |
| 3 | Areas in view | `list` | A | `areas-button` | Pressed while the list is open |
| 4 | People | `users` | P | new (section 16) | >= 1200 focuses the People section; < 1200 opens the popover (`aria-expanded`) |
| - | flexible spacer | | | | |
| 5 | Keyboard shortcuts | `circle-help` | ? | new (section 16) | Opens C-23 |

Below 900 the rail is replaced by the bottom bar (section 10.13).

### 10.6 Options bar (C-05, docked HUD) and message strip

**Bar** (>= 600):
- Height 44 (52 on coarse pointers), `--color-surface`, 1 px `--color-border-subtle` bottom border, padding `0 10 0 12`, gap 14.
- It spans the stage (the map column) and is **always present**, so the map never resizes on a mode change. Its content changes with the mode.
- Separators: 1 x 22 `--color-border`.

**Elements:**
- **Mode tag** (`optbar-mode-tag`): 26 high, radius 6, `snap-polygon` / `vector-square` / `square-mouse-pointer` / `history` 14 + 12/16 600. Accent for my work, neutral for a selection. It never ellipsizes, except the editing **kicker** `Editing “{name}”`, which gives way down to its icon and a few letters.
- **Readout** (`area-readout`; focusable, tooltip `{ha} · {m²}` + `Perimeter {km}`, UX C-06.4):
  - label "AREA" (micro-label, tertiary);
  - value 21/24 Mono 500, −0.02em, text;
  - unit 13/18 500 secondary;
  - hectares 12 Mono tertiary.
  - **Too large:** the value turns `--color-warning-text`.
- **Points** (`point-count`): label "POINTS" + value 17 Mono 500.
- **Message strip** (`hud-message`, Drawing and EditingShape): inline in the row, between the points and the buttons (below).
- **Buttons:** sm, right-aligned.

| Mode | Content (left -> right) |
|---|---|
| Browse | Key hints (12/16 secondary; kbd 20): `D` Draw area, `A` Areas in view, `L` Map / Aerial. With single-key shortcuts off, the bar is empty. |
| AreaSelected | **Neutral** mode tag (`square-mouse-pointer`, "Area selected"), separator, name 13/18 600 (bdi, <= 32 graphemes) + Mono 15/500 km², separator, hints `E` Edit shape, `F2` Rename, `H` History, `Z` Zoom to area, spacer, `Esc` Deselect. On narrow bars (below) only `E`, `F2` and `Esc` show. Letter hints hide when single-key shortcuts are off. |
| Drawing (`draw-hud`) | **Accent** mode tag (`snap-polygon`, "Draw area"), sep, readout, sep, points, message strip, *Undo point* (ghost, `undo-2`, kbd `Ctrl Z` / `⌘Z`, `undo-point-button`), *Cancel* (secondary, kbd `Esc`, `cancel-draw-button`), *Finish* (primary, `check`, `finish-button`) |
| Naming (desktop, compact `draw-hud`) | Accent mode tag, readout, points. No buttons and no strip; the form is in the inspector. |
| EditingShape (`draw-hud`) | Accent kicker (`vector-square`, `Editing “{name}”`, <= 32 graphemes), readout + delta "was 0.598" (12 Mono tertiary), points, message strip, *Undo* (ghost, `Ctrl Z`, `undo-edit-button`), *Cancel* (secondary, `Esc`, `cancel-edit-button`), *Save changes* (primary, `save-edit-button`) |
| PreviewingVersion | The **legend** `history-preview-legend` (`aria-hidden`): `history` 16 accent-text, a 22 x 8 dotted ghost swatch + "v3, 20 Sep", a 22 x 8 solid "me" swatch + "Current v5" (12/16 secondary). The actions stay in the inspector banner. |

**Narrow bars.** The steps follow the **bar's own width**, not the viewport's: the docked inspector makes the bar narrowest (796 px) exactly at a 1,200 px window, while at 1,199 px the overlay layout gives it 1,147 px. The bar is a size container (`container: optbar / inline-size`), and the thresholds below are its **content width** (the bar's width minus its 22 px padding; UX C-05 order). They were checked with the widest readout and the longest `.short` copy at 1,200, 1,280, 1,366 and 1,440 docked and at 600, 768, 1,024 and 1,199 overlay.

| Content width | What gives way |
|---|---|
| <= 1,300 | A selected point's *Move point* / *Delete point* become 30 px icon buttons (`move`, `trash-2`; the text stays their accessible name, plus the rail-style hover and focus tooltip "{label}", or "{label}, `Ctrl Z`" for the Undo buttons; `Esc` dismisses it; a native `title` is not used because it never shows on focus). |
| <= 1,100 | The hectares and the key chips inside buttons hide (at 1,440 x 900 the full Drawing hint then fits). |
| <= 980 | AreaSelected drops the `H` and `Z` hints. |
| <= 940 | The mode tag shrinks to its icon (its text stays the accessible name); *Undo point* / *Undo* become icon buttons; gap 10. |
| <= 720 | The "AREA" / "POINTS" labels and the edit delta hide; gap 8. |

Only after these does the strip text ellipsize. The strip keeps at least 176 px (112 px at <= 720) for its `.short` copy; with a selected point's actions, the actions never shrink and only the text gives way. The readout values, the point count and the action buttons never hide, and no two controls in the bar ever overlap. Independently of the bar's width, the key chips inside buttons are shown only at >= 1,200 px with a fine pointer (section 10.1).

**Message strip** (Drawing and EditingShape), UX C-05 v2:
- Where: **inside the options bar**, one line, taking the room left between the points and the buttons. It never overlays the map and never changes the bar's height.
- Size: height 28, radius 6, padding 0 10, gap 8, 12/16 text, leading icon 12. The copy ellipsizes when it must; the full sentence is the strip's `title` and goes to `live-status` on discrete events.
- It shows the `.short` variant of every message (the same strings as the phone strip), and the `*Touch` hints for touch input (C-06.10). `{Key}` tokens render as inline kbd chips.
- `hud-message[data-code]` is the strip. It is **not** a live region (UX C-05).
- It shows exactly one message (error > warning > rate chip > hint). When the map has keyboard focus, the hint uses the keyboard variant. A selected point keeps its actions next to whichever message wins, so a warning (for example *newer version*) never hides *Move point* / *Delete point*.

| Strip state | Background / border / text | Icon |
|---|---|---|
| Hint | `--color-surface-inset` / none / secondary; kbd chips inline | `info` tertiary |
| Error (crossing, spike, closing edge, zero area, extent, 180°, out of range, max points, refused finish, server invalid) | `--color-danger-bg` / inset 1 px `--color-danger-border` / `--color-danger-text` | `circle-alert` danger icon |
| Warning (too large, newer version, other editing, lock both / race / unknown) | Warning tokens | `triangle-alert` warning icon |
| Rate limited | The strip becomes the **rate chip** (`rate-limit-notice`): 20 high, radius 6, warning tokens, `clock` 12 + "Live sharing paused, 23 s" 11/16 600, Mono digits | `clock` |
| Point selected (edit) | Hint colours; "Point 3 of 8 selected." + sm *Move point* (secondary, `move`, `move-point-button`) + sm *Delete point* (danger-ghost, `trash-2`, `delete-point-button`) inside the strip, right-aligned | `info` |
| *Move point* armed | `--color-accent-faint` / inset `--color-accent-border` / accent-text; `base.edit.movePointArmedTouch` + sm secondary *Stop* (`stop-move-button`) | `info` |

A pointer resting on the point just placed (every click, tap and `Space`), or on the first point where a click finishes, is not a provisional point: the strip and the map judge the shape the placed points make (C-06.3). Touch has no hover, so on touch the strip never reports a rubber-band.

### 10.7 Map notices (C-17, C-24)

- **Slot:** top-centre of the map, top = `--map-inset-top` + 12. `max-width: min(560px, 100% − 2 × (var(--map-controls-w) + 2 × gutter))`, so a notice never overlaps the top-left control column. One notice at a time, in UX C-17 order.
- **Box:** min-height 36 (44 coarse), elevated, radius 8, `--shadow-2`, padding `4 4 4 12`, gap 8. It holds a 16 icon, 13/18 text, a sm action (30; 44 coarse) and a dismiss icon button (30; 44 coarse).
- **Restore unsaved drawing** (C-24, highest priority): `--color-accent-faint` over elevated + inset `--color-accent-border`; `rotate-ccw` accent-text; *Discard* (ghost) + *Restore* / *Resume editing* (primary).
- **Notice set** (unchanged from v1):
  - Truncated / culled: `zoom-in`, warning icon, *Zoom in*.
  - Load error: `circle-alert`, *Retry*.
  - Rate-limited read / storage: `clock`, countdown.
  - Empty view: `snap-polygon`, *Draw area*.
  - GovMap fallback, coverage, tiles failing: `info`, info icon.
- **Phone frame:** one line, text ellipsized, the action always visible, tap to expand. Hidden while the HUD shows an error.
- **Loading bar:** 2 px at the top edge of the map (under the strip when shown), full stage width. Track "me" at 18%; indicator 30% "me", looping every 1200 ms, after `PROGRESS_DELAY_MS`.

### 10.8 Inspector (C-10 - C-14, C-19)

#### 10.8.1 Frame

- **>= 1200 (docked):** a 352 column, `--color-surface`, 1 px `--color-border-subtle` left border, `overflow-y: auto` (`scrollbar-width: thin; scrollbar-color: var(--color-border-strong) transparent`).
  - It is always present, so the map never resizes.
  - It is an `<aside>` landmark labelled "Inspector".
  - **Sections**, separated by 1 px `--color-border-subtle`:
    1. the **context section** (Selection / Areas in view / Save area / Conflict, or the empty state);
    2. **People**;
    3. **Activity** [N].
- **Section header:**
  - `--size-section-header` 36 (32 in the overlay), padding `0 8 0 10`, gap 6. Sticky at the top of the scroll container on `--color-surface`.
  - The micro-label is 11/14 600 caps, +0.08em, tertiary, followed by a count tag.
  - Collapsible sections (People, Activity): the left part is a `<button aria-expanded aria-controls>` with a `chevron-down` 14 in tertiary (rotated −90° when collapsed, 120 ms).
  - Trailing: 32 icon buttons or a note.
  - The **context section is not collapsible**: its micro-label is an `aria-hidden` kicker, and the area name stays the `h2` heading and focus target, exactly as in v1.
  - People and Activity labels are `h2`.
- **Section body:** padding `0 16 14`.

#### 10.8.2 Selection (C-11): `area-panel`

- **Header:** "SELECTION" kicker. Trailing: *Zoom to area* (`scan` 16, `zoom-to-area-button`, tooltip "Zoom to area  Z") and *Close* (`x`, "Close area details", `Esc`). *Zoom to area* moved here from v1's action row.
- **Name row:** a 12 x 12 swatch (radius 3, `--color-accent-border` fill + inset 2 px accent), `h2` 18/24 600, −0.015em (`area-panel-name`, bdi, wraps, `tabindex="-1"`), *Rename* icon button (`pencil`, `rename-button`, tooltip "Rename  F2"). Margin-bottom 10.
  - **Rename mode** swaps the `h2` for a 32-high input at the same 18 px (counter from 80%).
  - **Rename pending:** a 12 spinner + "Saving..." 12/16 tertiary after the name.
  - **Previewing a version (F-07 step 3):** the name, the readout well (km², ha, perimeter, points, version) and the description are the previewed version's, and a `tag-current`-styled tag `base.history.previewTag` ("Preview", `area-panel-preview-tag`) follows the name; the well's *Version* cell reads the previewed version. *Created* / *Last edit* stay the area's.
- **Readout well:** radius 9, `--color-surface-inset`, inset 1 px `--color-border-subtle`.
  - Top row, padding `12 14`, space-between:
    - **left:** "AREA" micro-label, then (margin-top 8) the figure 34/36 Mono 500, −0.035em (`area-panel-km2`) + unit 14/20 500 secondary;
    - **right:** hectares 13 Mono secondary (`area-panel-ha`), bottom-aligned.
  - Cells: grid `1.25fr .8fr .8fr` with a top border. Each cell has padding `10 14 11` and a left border between cells, then a micro-label and a value (margin-top 6) in 14/1 Mono 500 with a unit 12 Sans secondary.
    - *Perimeter* (`area-panel-perimeter`)
    - *Points* (`area-panel-vertices`)
    - *Version* "v3" (`area-panel-version`)
- **Properties** (`dl`): margin 12 0, grid `78px 1fr`, row-gap 6, 12/16.
  - `dt` tertiary.
  - `dd` text: an 8 px person dot (`--c`, or accent for me; `--shadow-collab-dot`) + name, `·` tertiary, time in Mono 12 secondary (absolute in `title`).
  - Rows: *Created*, *Last edit*.
- **Actions**, flex gap 8:
  - *Edit shape* (secondary md, grows; `vector-square` + trailing kbd `E`; `edit-shape-button`). It reads *Edit anyway* when locked, is `aria-disabled` with `base.edit.holesDisabled` for areas with holes, and shows the loading state with the status line "Loading full detail..." (12 spinner + 12/16 tertiary, `role="status"`).
  - *Delete* (danger md, `trash-2`, `delete-area-button`), rendered only for the creator or an admin (UX C-11). There is no confirmation; Undo comes in a toast.
- **Banners** (section 10.8.7) sit between the properties and the actions. The history-preview banner is pinned at the top of the body.

#### 10.8.3 Details | History tabs (C-13)

The Studio concept shows History as its own section. v2 keeps UX's **tablist**, which is an accessibility rule and `history-tab`. The tab row is styled as a section header, so with *History* selected the result looks like the concept.
- **Tab row:** 36 high (44 coarse), top border `--color-border-subtle`, padding 0 16, gap 16, `role="tablist"`.
- **Tabs:** caps micro-labels (11/14 600, +0.08em). Unselected: tertiary, hover secondary. Selected: text colour + a 2 px accent bar at the bottom (radius 2). *History* carries its count tag (`history-tab`). The default tab is unchanged (UX).
- **Details panel:** padding `8 16 14`.
  - A "Description" label 12/16 500 secondary with a trailing ghost sm *Edit* (`pencil`).
  - The text is 13/18, `pre-wrap`, `dir="auto"`.
  - Empty: one row with no "Description" label: `base.panel.noDescription` 13/18 tertiary on the left and a secondary sm *Add description* on the right. In the overlay inspector the block's top margin and padding are 10 (fix round 3: keeps the People and Activity headers in view at 1024 x 768). In the phone peek the block's top border is transparent; the expanded sheet keeps it.
  - The editor is a textarea + *Save* / *Cancel* + "`Ctrl` `Enter` saves" (12 tertiary).
- **History timeline** (`history-item[data-version]`):
  - The list has padding `2 4 8`. Each item is a **button**: grid `22px 1fr auto`, column-gap 10, padding `7 12`, radius 7. Hover `--color-surface-hover`. Previewing (`aria-current="true"`) uses `--color-accent-faint` + inset `--color-accent-border`. Focus is an inset 2 px ring.
  - **Rail:** a 1 px `--color-border` line centred in column 1, from the first node to the last.
  - **Node:** 11 px, surface fill + inset 2 px ring in `--node`, where `--node` is the actor's `--c` or the accent for me; plus `--shadow-collab-dot`. The **current** node is filled with `--node` + `0 0 0 3px surface, 0 0 0 4px var(--node)`.
  - **Top row** (22 high):
    - version tag "v3";
    - change title 13/18 500 text ("Renamed", "Reshaped", "Created");
    - **Current** tag (11/1 600 caps, +0.05em, accent-text on accent-faint + inset accent-border, radius 4, padding 3 6).
  - **Sub row:** 12/16 secondary: person dot, name, `·`, detail. Numbers are in Mono 11.5 ("0.79 -> 0.84 km²", `from “Yarkon Plot”`).
  - **Time:** column 3, Mono 11.5/22 tertiary (absolute in `title`). On hover or focus it is replaced by a visual **Preview** affordance: an `aria-hidden` span, 26 high, padding 0 10, radius 6, 12/16 600 accent-text on accent-faint + inset accent-border. The row itself is the control; there is no nested button.
  - **Loading:** 2 skeleton rows (an 11 px circle + bars at 40% / 70%). **Error:** a danger banner with *Retry*.

#### 10.8.4 Areas in view (C-10) and save form (C-09)

- **Areas in view** (`areas-list`):
  - Header "AREAS IN VIEW" + count tag + *Close*.
  - A toolbar row (gap 8, margin-bottom 8): *Filter by name* (`areas-list-filter`, input 36, `search` 16 leading) + sort select.
  - **Rows** (`areas-list-item`) are buttons: min-height 44, padding `8 12`, radius 7, grid `1fr auto`.
    - Name 13/18 500 (bdi, ellipsis) + area Mono 12 secondary.
    - Meta 12/16 tertiary below across the full row. Lock meta: `lock` 12 + "Omer is editing" in secondary.
    - Hover surface-hover. Selected: accent-faint + inset accent-border. Focus: inset ring.
  - Capped, culled or truncated: a compact 12/16 notice line with the notice icon (`areas-list-capped`).
  - Empty: 13/18 secondary + a ghost *Draw area*.
  - **Phone frame:** the first lines are the C-26 summary, the C-27 map-centre coordinate (Mono 11.5 secondary, with `base.coord.centreLabel`) and `base.summary.help` (12/16 tertiary).
- **Save form** (desktop Naming, `save-area-form`):
  - Header "SAVE AREA" + *Close* (= *Back to drawing*).
  - *Name* (autofocus, counter from 80%) and *Description (optional)* ("(optional)" tertiary 400).
  - A compact well: "AREA" + figure 26/28 Mono + hectares and perimeter in 12 Mono secondary.
  - Actions: *Save area* (primary md, `save-area-submit`), *Back to drawing* (secondary, `back-to-drawing`), *Discard* (danger-ghost, pushed right, `discard-draft`).
  - Saving / offline / rate-limited states as in UX (a spinner + "Saving..."; `aria-disabled` + description; "Saving in 23 s...").

#### 10.8.5 Conflict (C-19)

- **Header:** "CONFLICT" kicker. No close; *Decide later* is in the body.
- **Title row:** `git-merge` 18 in the warning icon colour + heading 14/20 600 (bdi name). **Body:** 13/18 secondary, indented 26.
- **Legend well** (shape conflicts only): inset, radius 9, padding 4. Two rows of 40 (48 coarse), each with:
  - a 28 x 10 SVG swatch drawn exactly as on the map: mine is a "me" 2.5 core on a `#05070a` casing at 0.85; theirs is `--c` 2.5, `8 5`, on the same casing;
  - a label (13/18);
  - the km² (Mono 12 secondary);
  - an eye toggle (32; 44 coarse; `aria-pressed`; tertiary when off).
- **Actions:** stacked, full-width md, each with a 12/16 tertiary help line (4 px gap), rows 10 apart: *Keep mine* (primary), *Take theirs*, *Review differences* (secondary), *Decide later* (ghost sm).
- **Review table:** a real `<table>` with `th scope`. Headers 11/14 caps tertiary on `--color-surface-inset`, cells padding 8, 1 px row borders, radio groups per field. Auto-merged fields: `check` 14 success icon + 12/16 tertiary.

#### 10.8.6 People and Activity sections (>= 1200)

- **People** (`presence-list` on the `<ul>`):
  - The header is collapsible: "PEOPLE" + count. [N] trailing note: a 6 px live dot + "online" 12/16 success-text.
  - The rows are those of section 10.4. It is expanded by default.
- **Activity** [N] (the UX section 6.5 activity feed):
  - Header "ACTIVITY" + unread count.
  - Rows: min-height 48, padding `6 6 6 12`, gap 12, radius 7, avatar 26.
    - Line 1: 13/18 secondary with the names in text 500 ("Dana saved **Yarkon Park Plot**"), ellipsis.
    - Line 2: Mono 11.5 tertiary ("0.84 km², 11:20").
    - Trailing *Show*: a text button 28 high (44 hit on coarse), padding 0 10, radius 6, 12/16 600 accent-text, hover accent-faint.
- **Held note** (UX section 6.5):
  - In Drawing, Naming and EditingShape, the Activity header shows `bell-off` 12 tertiary + "Toasts held while you draw" (12/16 secondary), with `title` = the explanation (new copy, section 16).
  - Until Activity is built, the note sits in the People header.

#### 10.8.7 Banners (in the context section)

Radius 8, 1 px border, padding `10 12`, gap 10. Title 13/18 600 text; body 13/18 secondary; sm actions 8 px below.

| Banner | Background / border | Leading |
|---|---|---|
| Locked by other (`lock-banner`) | `color-mix(in srgb, var(--c) 8%, var(--color-surface))` / `color-mix(in srgb, var(--c) 40%, transparent)` | 20 avatar |
| Newer version / other editing / rate limited | Warning | `triangle-alert` |
| History preview (`history-preview-banner`, pinned) | Accent-faint / accent-border | `history` accent-text; *Restore this version* (primary, `restore-version-button`), *Exit preview* (secondary, `exit-preview-button`) |
| Deleted by other, creator / admin (`deleted-state`) | Inset / `--color-border` | `trash-2`; *Restore area* (primary, `restore-area-button`), *Close* |
| Deleted by other, anyone else (`ask-to-restore`) | Inset / border | `trash-2`; body `base.panel.askToRestore`; *Save a copy as a new area* (secondary, `save-copy-button`), *Close* |
| Errors | Danger | `circle-alert` |
| `base.lock.unknown` | Inset / border | `info` |

#### 10.8.8 Overlay inspector (900 - 1199) and the empty state

- **Overlay:**
  - Shown only while the context section has content.
  - Position: absolute in the stage. Top = options-bar bottom + `--map-inset-top` + 10; right 10; width 340; bottom = `max(34px, var(--map-attribution-h) + 12px)`, which keeps the attribution visible.
  - Radius 12, `--color-surface`, `--shadow-3`, no border. Section header 32.
  - People and Activity are **present and collapsed** (UX C-28 section table: "Overlay: collapsed"), as in the concept's `desktop-light-1024.png`. `presence-list` is still rendered once only: in the collapsed People body when expanded, never also in a popover at >= 600 px. *(Corrected in fix round 2: an earlier revision of this line said "omitted", which contradicted UX.md and the build.)*
  - Motion: translateX(16) + opacity, 200 ms. It sets `--map-inset-right` to 360.
- **Empty state (>= 1200, nothing open):**
  - The "SELECTION" kicker.
  - One sentence, `base.inspector.selectionEmpty` "No area selected. Select one on the map or in Areas in view." (13/18 secondary; `selection-empty`). UX owns the copy (section 16); the two-line text and the ghost *Areas in view* button of earlier drafts are not specified by UX and are not built. If the button is still wanted, it is a request to append to UX.md (section 16).
  - This is not `area-panel`.

### 10.9 Status bar (C-26, C-27)

- **Bar:** height 26, `--color-bg`, 1 px `--color-border-subtle` top border, Mono 11.5/1 `--color-text-secondary`, `white-space: nowrap`, overflow hidden.
- **Cells:** padding 0 12, 1 px right border `--color-border-subtle`, gap 7; icons 14 tertiary; labels in Sans tertiary.
- It is **not** a live region and never takes focus.

| Cell | Content | Shown |
|---|---|---|
| 1 | `locate` 14 (`aria-hidden`), cell width = rail width, centred | >= 900 |
| 2 | **Coordinate readout** `coord-readout` (C-27): "32.077350, 34.783880, ITM E 179749.0 N 664973.0". "-", "ITM E" and "N" are tertiary. `dir="ltr"`, selectable, `title` = `base.coord.help`. Prefix "Map centre" (`base.coord.centreLabel`, Sans tertiary) when it shows the centre (pointer off the map, touch, keyboard reticle). | >= 600 |
| 3 | Zoom "z 15" ("z" tertiary) | >= 900 |
| 4 | Scale: a bar <= 124 x 6 with a 1.5 px secondary border on the left, right and bottom, plus a label (100 / 200 / 250 / 500 m / 1 / 2 km ...) | >= 900 |
| 5 | **Viewport summary** `analysis-summary` (C-26): "2 areas, 0.96 km² in view", `title` = `base.summary.help` | >= 600 |
| right | Key hints: kbd 18 + Sans 11.5 tertiary label, gap 14. They depend on context: Drawing with a pointer shows `Backspace` Undo point; keyboard drawing shows `⇧ Arrows` Fine pan; AreaSelected shows `Del` Delete (creator or admin only). Always shown: `L` Map / Aerial, then `?` Shortcuts. Letter hints hide when single-key shortcuts are off. | Hints >= 1200; `?` Shortcuts >= 900 |

At 600-899 the bar sits under the bottom bar and shows cells 2 and 5 only. It fits at 600 px: about 350 + 210 px.

### 10.10 Base-map switcher and zoom (C-15)

- **>= 900, top-left column** at (12, 12 + `--map-inset-top`), gap 8. Its measured width is written to `--map-controls-w`.
  - **Segmented radiogroup** (`base.layer.groupLabel`):
    - Track: `--color-surface-float`, radius 8, padding 3, gap 2, `--shadow-1`.
    - Segments (`layer-switch-map`, `layer-switch-aerial`; `aria-checked`): 28 high (44 coarse), padding 0 10, radius 5, gap 6, icon 14 (`map` / `satellite`) + 12/16 500 label.
    - Unselected: secondary text, hover `--color-surface-hover` + text.
    - Selected: `--color-segment-selected` + inset 1 px `--color-segment-selected-border` + `--color-on-segment-selected` text + icon in accent-text.
  - **Zoom:** a vertical group, float, radius 8, `--shadow-1`, buttons 34 x 32 (44 x 44 coarse), `plus` / `minus` 16 secondary, hover `--color-surface-raised-hover` + text, 1 px `--color-border` separator.
- **600-899:** a control row above the attribution: the same segmented control on the left (44 segments on coarse pointers) and the zoom pair on the right.
- **< 600:** the control row is at left 12, right 12, bottom = `--map-inset-bottom` + `--map-attribution-h` + 8.
  - The **layer toggle** (`layer-toggle`): 44 high, padding `0 14 0 12`, radius 9, float, `--shadow-1`, icon 18 accent-text + 14/20 500 label of the layer you switch **to**.
  - The zoom pair is horizontal, 44 x 44 each, float, radius 8, with a 1 px separator.
- `L` switches Map <-> Aerial (UX section 7). The control reflects the result immediately.

### 10.11 Toasts (C-18)

- **Lane** (`role="region"` `aria-label="Notifications"`), inside the map frame, `--z-toast`:
  - >= 900: left 0, right `--map-inset-right`, bottom `max(36px, var(--map-attribution-h) + 12px)`, centred. The **own** lane is nearest the bottom and the **collaboration** lane sits above it, gap 8. `pointer-events: none` on the lane and `auto` on toasts.
  - Phone frame (< 900): left and right 12, bottom = `--map-inset-bottom` + `--map-attribution-h` + 8 + 44 + 12, which is above the control row.
  - Counts per lane and holding rules are as in UX C-18 / section 6.5: while drawing or editing, the collaboration lane is empty.
- **Toast** (`toast[data-kind][data-code]`):
  - Width 344 (grows up to 480 before wrapping; phone: the full lane), min-height 48, padding `6 6 6 12`, gap 10, radius 9, `--color-elevated`, `--shadow-3`, `overflow: hidden`.
  - Message 13/18 500 text, clamped at 3 lines (phone collaboration toasts: 1 line); ", {area}" in secondary.
  - Action: text button 32 (44 coarse), padding 0 12, radius 6, 13/18 600 accent-text, hover accent-faint (`toast-undo`, `toast-retry`, `toast-show`).
  - Dismiss: 32 icon button, `x` 14 tertiary, hover elevated-hover + text (`toast-dismiss`).
  - Focus: the standard 2 px ring (9.25 / 5.62 on elevated).
- **Undo countdown:** a 2 px bar at the bottom edge. Track `--color-border-subtle`; fill `--color-accent` scaling from 1 to 0 on X over `TOAST_UNDO_MS` (transform-origin left). It pauses on hover, on focus and while the tab is hidden, and is hidden with reduced motion.

| Kind | Leading |
|---|---|
| Success | `circle-check` 16 in the success icon colour |
| Undo-able (deleted, discarded, took theirs, restored) | The action's icon (`trash-2`, `rotate-ccw`, `snap-polygon`) in secondary, plus **Undo** and the countdown |
| Countdown (rate-limited delete) | `clock` in the warning icon colour + a Mono countdown |
| Error (persistent) | `circle-alert` in the danger icon colour + **Retry** |
| Info / auto-merged | `git-merge` / `info` in the info icon colour |
| Collaboration | The actor's 24 avatar |

Motion: in over 200 ms (translateY 8 -> 0 + opacity); out over 150 ms.

### 10.12 Dialogs (C-20 - C-23)

- **Box:**
  - Scrim `--color-scrim`.
  - Width 440 (shortcuts 560), max `100vw − 32`; `--color-elevated`, radius 12, `--shadow-4`, padding `20 24`.
  - Title 18/24 600; body 13/18 secondary, 16 below it; footer right-aligned, gap 8, 20 above, md buttons (44 coarse).
  - **Phone:** width `100vw − 32`, footer buttons stacked full-width at lg, primary first.
  - Focus is trapped. Motion: 160 ms opacity + scale 0.98 -> 1.

| Dialog | Content |
|---|---|
| Session expired (C-21) | Username read-only (inset fill, border, secondary). Password focused, with a *Show* text button inside the field (full field height, >= 44 wide, 12/16 600 accent-text, right radius 8). *Sign in and continue* (primary lg, full width). Then a links row (12/16 accent-text, underlined): *Sign in as someone else*, *Sign out instead*. No close x. |
| Sign out with unsaved work (C-22) | *Discard and sign out* (danger-ghost), *Keep working* (primary, initial focus) |
| Deleted while editing (C-20) | Stacked full-width md buttons in the UX variants (creator / admin; anyone else) |
| Delete area | **No dialog**: Undo toast (UX F-06) |
| Keyboard shortcuts (C-23) | Width 560, max-height 80vh, scrolls. A *Single-key shortcuts* switch row at the top (13/18 600 + 12/16 tertiary help, `single-key-toggle`). Groups per mode under caps micro-labels. Rows: 13/18 secondary description + right-aligned kbd chips (gap 4). *Close* (secondary, initial focus). |

### 10.13 Phone frame (< 900; UX section 3.2)

- **Title bar:** section 10.2.
- **HUD row** (Drawing, EditingShape; hidden in Naming):
  - 58 high, `--color-surface`, 1 px bottom border, padding 0 16, gap 12.
  - **Mode tag:** 36 x 36 icon-only, radius 8, accent-subtle + inset accent-border, icon 20 accent-text. Its `aria-label` is the mode ("Draw area" or the Editing kicker).
  - **Readout column:**
    - **Row 1:** value 22/26 Mono 500 + unit 13 secondary + "- 5 points" in Mono 12 tertiary. In Editing, the delta "- was 0.274" follows, and the kicker `Editing “{name}”` is right-aligned in 12/16 tertiary, ellipsized, and hidden when less than 60 px remains.
    - **Row 2:** `hud-message`, one line of `.short` copy, 12/16 secondary with an ellipsis. Error or warning turns it into the state text colour with a 12 px icon, plus a 2 px bottom border in the state border colour.
  - **Point selected** (EditingShape): *Move point* (secondary) and *Delete point* (danger-ghost) sit at the right of the HUD row as 44 x 44 icon buttons (`move`, `trash-2`; their text stays the accessible name), and the kicker gives way to them. Row 2 reads "Point 3 of 8 selected." (or the higher-priority warning or error). When *Move point* is armed, *Stop* (text) takes their place. Nothing hangs over the map, and the readout row is never clipped. *(Earlier drafts put these in an action row under the HUD; as built they fit the 58 px row.)*
  - **Resize compensation.** Adding or removing the 58 px row resizes the map. The layout calls `map.invalidateSize({ pan: false })` and then `map.panBy([0, ±58], { animate: false })`, so the map content does not move on screen.
- **Bottom bar:**
  - 72 + `env(safe-area-inset-bottom)`, `--color-bg`, 1 px top border, padding 0 16, gap 8.
  - Buttons: xl 48, radius 9, 14/20 500 (primary 600), icons 18.

  | Mode | Layout |
  |---|---|
  | Browse / AreaSelected | *Draw area* (secondary, `snap-polygon`), *Areas* (secondary, `list`), 50/50 |
  | Drawing | *Cancel* (secondary), spacer, *Undo* (secondary, `undo-2`, "Undo last point"), *Finish* (primary, `check`, min-width 132) |
  | EditingShape | *Cancel*, spacer, *Undo*, *Save* (primary, "Save changes"). The sheet is hidden. |
- **Sheet:**
  - `--color-surface`, radius 14 on top, `--shadow-sheet`, padding `0 16 16`. It covers the bottom bar (except in EditingShape). Its height sets `--map-inset-bottom`. 600-899: max width 560, centred, above the status bar.
  - Grab handle 36 x 4 `--color-handle`, margin-top 8 (drag is optional; the buttons are the accessible path).
  - Header 44: "SELECTED AREA" kicker (`aria-hidden`) + *Expand* (`chevron-up`) and *Close* (`x`) icon buttons at 44.
  - Name row: an 11 px swatch + name 18/24 600.
  - Metrics row (margin-top 10): figure 26/28 Mono 500 + unit 13 secondary + Mono 12 secondary meta ("84.0 ha, 3.91 km, 6 points").
  - Properties: `dl` with a 72 px `dt` column, 12/16.
  - **Actions pinned to the sheet bottom:** *Edit shape* (secondary lg, grows), *History* (secondary lg, `history`), *Delete* (danger lg, **labelled**; creator or admin).
  - At **peek** the order is header, name, metrics, actions; the details scroll above the pinned actions.
  - Heights, snaps, naming, preview and conflict are as in UX section 3.2: peek `max(176px, 30dvh)`, expanded `min(85dvh, 100dvh − 48 − 160px)`, conflict 50dvh, naming sized to content.
- **Naming sheet:**
  - Header "Save area, 0.139 km²" (14/20 600 + the area in Mono secondary) + a ghost *Discard* in danger text.
  - *Name* (lg 44), then **`+ Add description`** (ghost, `add-description-button`).
  - *Back to drawing* (secondary lg), *Save area* (primary lg), 50/50.
  - The keyboard behaviour is unchanged (UX section 3.2).
- **Preview sheet:** at peek, with the history banner pinned at the top.

### 10.14 Auth screens (C-01)

- **Page:** `--color-bg` + a decorative contour-line pattern (inline SVG, 1 px `--color-border-subtle`, tiled every 240 px). It follows the stored theme; there is no toggle on this page.
- **Card:**
  - max 400, `--color-surface`, 1 px `--color-border-subtle`, radius 14, `--shadow-3`, padding `28 28 24`.
  - Phone: full-bleed, no border and no shadow, padding `24 16`.
- **Content, in order:**
  - brand mark 40;
  - title 20/28 600 ("Sign in to Snapland");
  - tagline 13/18 secondary, 20 below;
  - error summary: danger banner, `role="alert"`, 16 below;
  - fields at 44 high (label 12/16 500 secondary), 14 gap;
  - a primary full-width button, 44 high, 20 above;
  - footer 13/18 secondary + an accent-text link.
- **States:** field error, submitting (spinner + "Signing in...", read-only), wrong credentials, disabled, rate limited (Mono countdown) and network error, all as in v1.

---

## 11. Responsive layouts

**Desktop >= 1200** (1440 x 900; see `desktop.png`):
```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Snapland  (● Live)                                    (Mo⊕)(OC⊕)(DL◉) 3 online │ ⌨ │ Moshe ⌄      │ 44
├────┬───────────────────────────────────────────────────────────────────────┬───────────────────────────┤
│ ✎  │ [▣ Draw area] │ AREA 1.27 km² │ POINTS 5 │  ↶ Undo point [Cancel] [✓ Finish] │ SELECTION          ⛶  ✕  │ 44
│ ▢  ├───────────────────────────────────────────────────────────────────────┤ ■ Yarkon Park Plot      ✎ │
│ ── │ ⓘ Double-click, click the first point, or press [Enter] to finish.    │ ┌ AREA ─────────────────┐ │
│ ☰  │ [Map|Aerial]          (message strip 28, overlays the map)            │ │ 0.84 km²      84.0 ha │ │
│ ⚇  │ [+][−]                                                                │ ├ Perim. ─┬ Points ┬ Ver ┤ │
│    │                              M A P                                    │ Created  ● Dana · 10:42   │
│    │                                                                       │ [▢ Edit shape  E]  [🗑]   │
│    │                                                                       │ DETAILS   HISTORY 3       │
│    │                                                                       │ ⌄ PEOPLE 3                │
│    │               ┌ toast lane (bottom-centre) ┐                          │ ⌄ ACTIVITY 1   🔕 held    │
│ ?  │                                                © GovMap · Esri …      │                           │
├────┴───────────────────────────────────────────────────────────────────────┴───────────────────────────┤
│ ◎ │ 32.077350, 34.783880 · ITM E 179749.0 N 664973.0 │ z 15 │ ▁▁▁ 500 m │ 2 areas · 0.96 km² │ … ? │ 26
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  rail 52          stage 1036 (options bar 44 over the map, 1036 × 786)                 inspector 352
```

**900 - 1199** (1024 x 768; see `desktop-light-1024.png`):
```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▣ Snapland (● Live)                   (Mo)(OC)(DL) │ ⌨ │ Moshe ⌄           │ 44
├────┬───────────────────────────────────────────────────────────────────────┤
│ ✎  │ [▢ Area selected] │ Yarkon Park Plot 0.84 km² │ E Edit · F2 Rename  Esc│ 44
│ ▢  ├───────────────────────────────────────────────────────────────────────┤
│ ☰  │ [Map|Aerial]                                ┌ overlay 340 ──────────┐ │
│ ⚇  │ [+][−]                                      │ SELECTION        ⛶  ✕ │ │
│    │                 M A P                       │ ■ Yarkon Park Plot  ✎ │ │
│    │                                             │ well · props · actions│ │
│    │                                             │ DETAILS  HISTORY 3    │ │
│    │          ┌ Undo toast ┐                     └───────────────────────┘ │
│ ?  │                                               © OpenStreetMap contrib. │
├────┴───────────────────────────────────────────────────────────────────────┤
│ ◎ │ Map centre 32.078308, 34.802367 · ITM … │ z 14.5 │ ▁▁ 500 m │ 2 areas … │ ? │ 26
└────────────────────────────────────────────────────────────────────────────┘
```

**Tablet portrait 600 - 899:**
```
┌───────────────────────────────────────────────┐
│ ▣ Snapland (● Live) [Quiet]      (⚇ 3)   ≡    │ 48
├───────────────────────────────────────────────┤
│ [▣] 1.27 km² · 5 points                        │ 58 (Drawing / EditingShape only)
│     Tap the first point or Finish.            │
├───────────────────────────────────────────────┤
│                  M A P                        │
│        ┌ toast (≤ 480, centred) ┐             │
│ [Map|Aerial]                       [+][−]     │
│                         © GovMap · Esri …     │
├───────────────────────────────────────────────┤
│ [Cancel]                 [↶ Undo] [✓ Finish]  │ 72
├───────────────────────────────────────────────┤
│ 32.080000, 34.780000 · ITM … │ 24 areas · …   │ 26
└───────────────────────────────────────────────┘
```

**Phone < 600** (390 x 844 and 360 x 640; see `mobile.png`, `mobile-selected.png`):
```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│ ▣ (● Live)          ⚇ 3     ≡    │ 48   │ ▣ (● Live)          ⚇ 3     ≡    │ 48
├──────────────────────────────────┤      ├──────────────────────────────────┤
│ [▣] 1.27 km² · 5 points          │ 58   │             M A P                │
│     Tap the first point or Finish│      │     ⌜ Yarkon Park Plot 0.84 ⌝    │
├──────────────────────────────────┤      │ ┌ Drawing discarded  Undo  ✕ ┐   │
│            M A P                 │      │ [▥ Map]              [+][−]     │
│   my draft (closed, cyan)        │      │         2-line attribution       │
│   Omer's draft + chip            │      ├──────────────────────────────────┤ peek
│ [▥ Map]              [+][−]      │      │ SELECTED AREA            ⌃   ✕   │
│         2-line attribution       │      │ ■ Yarkon Park Plot               │
├──────────────────────────────────┤      │ 0.84 km²  84.0 ha · 3.91 km      │
│ [Cancel]      [↶ Undo] [✓ Finish]│ 72   │ [▢ Edit shape] [History] [Delete]│
└──────────────────────────────────┘      └──────────────────────────────────┘
  Drawing (touch)                            AreaSelected: peek sheet covers the bar
```

Breakpoints are literal in media queries: 599.98, 899.98 and 1199.98. At 320 px there is no horizontal scroll in any state (UX-AC-81).

---

## 12. Iconography

**Set:** [Lucide](https://lucide.dev), ISC licence, used through `lucide-react` named imports. Sizes and strokes:
- 18 px (stroke 1.75): rail, phone bars;
- 16 px (1.75): buttons, menus, toasts;
- 14 px (2): small controls, status bar, mode tags;
- 12 px (2.25-2.6): chips, strips, status lines;
- 10 px (3): presence badges;
- 9 px (4): invalid ticks.

Always `currentColor`, with round caps and joins. Decorative icons are `aria-hidden`; icon-only buttons have an `aria-label`.

**Custom glyph `snap-polygon`** (Draw area, the empty-view notice, the discarded toast), 24 grid: `<path d="M5 8.5 12 4l7 5.5-2.5 9h-9z"/>` plus five filled dots of radius 1.6 at the vertices. The brand mark is separate (section 10.2).

| Icon | Where |
|---|---|
| `snap-polygon-plus` (custom) | The Draw area **action** (rail, bottom bar): the polygon with a + inside, "add a new area" |
| `snap-polygon` (custom) | Drawing mode tag, empty-view notice, discarded toast |
| `vector-square` | Edit shape (rail, mode tag, *Edit shape* buttons) |
| `square-mouse-pointer` | "Area selected" mode tag |
| `list` | Areas in view |
| `users` | People (rail), phone presence count |
| `circle-help` / `keyboard` | Shortcuts (rail) / Shortcuts (title bar, menu) |
| `plus` / `pencil` / `eye` / `clock` | Presence badges and status lines (drawing / editing / viewing / idle) |
| `undo-2` | Undo point, Undo, menu *Undo last action* |
| `check` | Finish, merged-automatically mark, checked radio menu item |
| `x` | Close, dismiss, the x marker and ticks |
| `pencil` / `pencil-line` | Rename, Details *Edit*, lock and "- editing" chips / point-selected strip |
| `scan` | Zoom to area, [N] Show on map |
| `trash-2` | Delete, Delete point, Discard, deleted toast and banner |
| `history` | History (sheet), preview banner and legend |
| `rotate-ccw` | Restore this version, Restore area, restore-drawing notice |
| `move` | Move point, armed strip |
| `map` / `satellite` | Base-map segments, phone toggle and menu |
| `plus` / `minus` | Zoom |
| `locate` | Status bar, first cell |
| `sun` | *Light theme* menu item |
| `bell-off` | Quiet chip and badge, Quiet menu item, the held-toasts note |
| `zoom-in` / `info` / `circle-alert` / `triangle-alert` / `circle-check` / `git-merge` | Notices, strip, toasts, conflict |
| `cloud-off` / `wifi-off` / `refresh-cw` / `lock` | Pill states, Reconnect now / Retry, Signed out and list lock meta |
| `search` / `chevron-down` / `chevron-up` / `menu` / `log-out` / `mouse-pointer-2` | Filter / menus, sections, sheet / phone menu / Sign out / [N] cursors item |

---

## 13. Themes (D-5)

- **Default:** dark, the `:root` values. **Light:** `<html data-theme="light">`. The OS `prefers-color-scheme` is **not** followed, and `tokens.css` has no media query for it.
- **Persistence:** `localStorage` key `snapland.theme`, value `"dark"` or `"light"`.
  - Every read and write is wrapped in `try/catch`. A failure, or any other value, means dark with no error surfaced.
  - The choice is per browser; it is not an account setting and never goes to the server.
- **Before the first paint:** a tiny classic script `frontend/public/theme-boot.js`, loaded with `<script src="/theme-boot.js"></script>` in `<head>` **before** the stylesheet. The CSP allows it (`script-src 'self'`); inline scripts are not allowed.

  ```js
  try { if (localStorage.getItem('snapland.theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch {}
  ```

  - Remove `<meta name="color-scheme" content="light dark">` from `index.html`. That meta lets the browser pick the OS scheme for the pre-CSS canvas. `color-scheme` comes from `tokens.css` instead.
  - Give `html` and `body` `background: var(--color-bg)`.
- **Switching** (user menu *Light theme*, section 10.2):
  - Set or remove `data-theme` on `<html>`, then write the key.
  - Add a `theme-switching` class to `<html>` for one frame (`* { transition: none !important }`), so hover transitions do not animate every colour at once (`--duration-theme` 0).
  - Then re-read the canvas overlay tokens (`readOverlayTokens`), because the OSM map tone depends on the theme.
  - Focus stays on the menu item.
- **What changes with the theme:** all chrome tokens, shadows, the brand-mark colours, the OSM tile filter and backdrop, and the light map tone when the base is Map.
- **What does not change:** the collaborator palette, the overlay tokens on imagery (always dark tone), geometry, hit areas and behaviour.

---

## 14. Implementation notes (frontend)

1. **Imports** in `main.tsx`, in order:
   1. the `@fontsource` CSS (subset imports, weights 400/500/600);
   2. `../../docs/design/tokens.css`;
   3. `app.css`.

   Preload the two main woff2 files.
2. **Theme:** `theme-boot.js` plus the menu switch (section 13). Suggested unit tests:
   - the storage read falls back to dark when `localStorage` throws;
   - `prefers-color-scheme: light` has no effect;
   - the menu item toggles `data-theme` and writes the key.
3. **Map frame:**
   - Put `data-base-layer` on the element that contains the Leaflet container **and** the map chrome that uses tone tokens (attribution, strip, notices): keep it on `[data-testid="map"]`, as UX section 12 requires, and mirror it onto the frame.
   - The frame hosts the `::after` well shadow and the focus pseudo-element (section 9.10).
   - Give tile layers `className: 'snap-tiles--osm' | 'snap-tiles--imagery'`.
4. **Overlay token read-out** (`overlayUtil.ts`): subscribe to base layer **and** theme. Update the hard-coded fallbacks to the v2 dark-tone values:

   | Fallback | v2 dark-tone value |
   |---|---|
   | area stroke | `#eef1f5` |
   | area stroke width | 1.75 |
   | selected / own stroke | `#22d3ee` |
   | invalid | `#f87171` |
   | ghost | `#eef1f5` |

   Read the casing extras and opacities too (`--ov-casing-opacity`, `--ov-remote-casing-*`).
5. **SVG classes:**
   - `ov-casing`: `stroke: var(--ov-casing); stroke-opacity: var(--ov-casing-opacity)`;
   - `ov-remote-casing`;
   - `ov-core`;
   - `ov-invalid-outline`: `stroke: var(--ov-invalid-outline); stroke-opacity: var(--ov-invalid-outline-opacity)`;
   - `ov-selected`: `filter: var(--ov-selected-glow)`.

   Brackets are recomputed on `moveend` / `zoomend`.
6. **Runtime properties** (section 4.4): `--map-inset-top` (strip), `--map-inset-right` (overlay), `--map-inset-bottom` (sheet), plus measured `--map-attribution-h` and `--map-controls-w`. Pass the insets into `fitBounds` padding.
7. **Layout:** a CSS grid per section 4.1; media queries at 600 / 900 / 1200. The phone HUD row uses the `invalidateSize` + `panBy` compensation (section 10.13).
8. **Focus:**
   - `:focus-visible` only; one ring everywhere on chrome.
   - Two-tone for floating map controls; an inset ring for attribution links and full-width rows; the map focus uses the pseudo-element.
   - The `scroll-margin` of inspector children equals the strip plus toast heights (UX section 8.3).
9. **Targets:** implement the hit wrapper once (section 10.0).
10. **DOM order** follows UX section 8.2 (the tab order does not change): skip link -> title bar -> rail -> map -> options bar and strip -> notice -> inspector -> map controls -> attribution -> toasts. CSS grid places the regions visually. The new rail tools sit inside the rail group (section 16).
11. **Test ids:** all unchanged. New elements get ids only after UX appends them (section 16); until then they must **not** reuse an existing id. For example, the rail *Edit shape* is not `edit-shape-button`.
12. **Deprecated aliases** (section 2.8): remove each one when it is no longer used.
13. **QA checks worth automating:**
    - no computed `font-size` below 11 px on any visible text node;
    - `node docs/design/contrast-check.mjs` in CI;
    - every interactive box >= 44 x 44 on the phone project (as v1 section 15);
    - `USER_PALETTE` equals `tokens.css` (the existing test).

---

## 15. What changed from v1

- **Layout:** the floating cards became a **docked frame**: title bar 44, rail 52, options bar 44 (the docked HUD) with a message strip, inspector 352 (an overlay at 900-1199), and status bar 26.
  - The C-26 summary and the C-27 coordinate readout moved into the status bar, with zoom and a scale bar.
  - The base-map switch and zoom moved top-left.
  - Toasts use one bottom-centre lane.
- **Themes:** dark became the **default**, with a light "paper" theme in the user menu. The OS setting is no longer followed (v1 followed it).
- **Colour:**
  - The accent went from indigo to **cyan** (dark) / **teal `#0d7377`** (light).
  - Saved areas went from slate to **white / neutral**.
  - Toasts and tooltips are no longer an inverse surface.
  - The collaborator palette changed to the D-6 neon set with **dark ink**.
- **Map:**
  - Aerial is dimmed about 26%, and OSM is tinted in the dark theme.
  - Overlays became a bright core on a dark casing (the light OSM map keeps dark cores on white).
  - The selection gained a glow and CAD brackets.
  - The invalid edge keeps its x ticks and gains a white outline on dark maps.
- **Type:** IBM Plex Sans / Mono / Sans Hebrew (self-hosted) replaced the system fonts. Every value is set in Mono. Body text went from 14 to 13 px and the floor from 12 to 11 px.
- **Inspector:** the side panel became sections: Selection with Details | History tabs, People (docked at >= 1200), and Activity [N]. *Zoom to area* moved to the section header.
- **Presence:** "viewing" gains a quiet eye badge, and my avatar gains an accent ring.
- **Unchanged:** behaviour, flows, contracts, test ids, the keyboard map, the accessibility rules, the motion durations and the cross-fade.

---

## 16. Deviations, requests and open items

**Deviations from the Studio concept** (kept on purpose):

| # | Concept | v2 | Why |
|---|---|---|---|
| V1 | Casing 0.75 / 0.62, light accent `#0e7490`, invalid without an outline, segment ring `#2e343e`, light Live dot `#059669` | See section 2.7 | Gated contrast and CVD failures |
| V2 | Inline hint in the options bar ("Enter to finish") | The message strip, inline in the bar, showing the `.short` copy of every message (section 10.6) | `hud-message` stays one element for hints, warnings and errors; the full sentence is its `title` and is announced. *(Earlier drafts of this file hung the strip under the bar; UX C-05 v2 put it inline, and that shipped.)* |
| V3 | History as its own collapsible section | The Details \| History **tablist** in the context section, styled as a section header | UX keeps a tablist (1.3.1) and `history-tab` |
| V4 | Selection section collapsible | The context section is not collapsible | `area-panel` content must stay visible while it is open |
| V5 | Overlay inspector from 600 px | Overlay at 900-1199; the phone frame (bottom bar + sheet) below 900 | UX `SHEET_MAX_PX` 899 is unchanged |
| V6 | People and Activity collapsed inside the 1024 overlay | *(Withdrawn in fix round 2.)* Kept as in the concept: collapsed in the overlay (UX C-28) | One rendered `presence-list` at a time still holds: the popover is phone-only |
| V7 | Pulsing Live ring | Static ring | Nothing loops forever (2.2.2) |
| V8 | Name chip on an unselected saved area | Not shown; hover tooltip only | Persistent labels would be new behaviour |

**Requested of `UX.md`** (append-only; the UX owner edits UX.md). Requests 1-3 were settled by UX v2, which is what shipped; they are kept here as a record:

1. **Copy keys:** UX v2 added `presence.online` "{n} online", `inspector.selectionEmpty`, the Activity held note, `rail.editShapeUnavailable`, the key-hint labels, and the theme keys `menu.theme` "Theme", `menu.themeDark` "Dark", `menu.themeLight` "Light", `theme.switchedDark` / `theme.switchedLight`. The requested `menu.lightTheme` switch was replaced by the Dark / Light pair.
2. **Test ids:** `theme-switch`, `theme-option-dark`, `theme-option-light` (instead of `theme-toggle`), and the rail's `rail-edit-button`, `people-button`, `shortcuts-button` (instead of `rail-people-button`, `rail-shortcuts-button`).
3. **Acceptance criteria:** UX-AC-111 ... UX-AC-114 (theme default, switch and persistence, robustness, work untouched). The theme control is a group of two `menuitemradio` items, not a `menuitemcheckbox`.
4. **Layout text to update** (layout only; no behaviour change):
   - section 3.2 wireframes: the docked frame; the overlay inspector at 900-1199; the phone frame below 900 with a status bar at 600-899.
   - C-26 / C-27 placement: the status bar at >= 600 (unchanged below 600).
   - section 7: control position (top-left at >= 900, control row below).
   - C-05: position (docked options bar + message strip).
   - C-11: *Zoom to area* in the section header.
   - section 6.1: the "viewing" eye badge.
5. **section 8.2 tab order:** the rail group becomes *Draw area* -> *Edit shape* -> *Areas in view* -> *People* -> *Shortcuts*. These are extra entry points to existing commands (`E`, `P`, `?`).
6. **`P` at >= 1200:** it expands and focuses the docked People section instead of opening a popover (UX-AC-50 / -98 still hold: `presence-list` is visible).

**Items for the team lead / SPEC:**
- **D-6 roll-out:**
  - Update SPEC section 6.2 (the palette list).
  - Mirror `USER_PALETTE` in `packages/shared/src/constants.ts` to `tokens.css` in the D-6 order.
  - Ship the index-preserving `users.color` migration.
  - `constants.test.ts` fails until `USER_PALETTE` matches, by design; it compares the palette with `tokens.css`.
- **Dependencies:** `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, `@fontsource/ibm-plex-sans-hebrew` (OFL-1.1) become frontend dependencies. The CSP stays `font-src 'self'`.
- **Files:** `frontend/public/theme-boot.js` and the `index.html` changes (section 13).
- **Other v1 SPEC items** (S3, S6, S9, S10) are not affected by this redesign.

**Open items:**
- **Performance:** measure pan fps with 2,000 areas on tinted OSM and on dimmed Aerial (per-layer CSS filters + the canvas halo filter). Record it in `docs/benchmarks/`. If a filter costs more than 5 fps, apply the tint only at zoom >= 12.
- **Remote drafts on dark imagery:** the line-vs-background figure is 2.1-3.9 (informational, section 2.6). If QA finds drafts hard to see there, add the invalid-edge outline to remote drafts at 50%.
- **Reference frames:** after implementation, capture new frames of the running app on the isolated review stack (both themes, both base layers, phone 390 and 360) and replace the concept frames as the reference.
