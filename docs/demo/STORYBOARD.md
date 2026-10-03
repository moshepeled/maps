# Snapland - demo video storyboard

| | |
|---|---|
| **Owner** | ux-design-expert |
| **Status** | v1.0, 2026-09-30. Scenes 2-11 were dry-run against an isolated stack (section 9). |
| **For** | Whoever scripts and records the demo (Playwright + ffmpeg), and the reviewer who watches it |
| **Length** | 2:43, 12 scenes |
| **Output** | `snapland-demo.mp4`: 1920 x 1200 (two 960 x 1080 panes over a 120 px caption band), 30 fps, H.264, no audio |
| **Sources** | `instractions.md` (what is graded), `docs/SPEC.md` (behaviour and limits), `docs/design/UX.md` (flows F-xx, test ids section 12), `frontend/src/base/en.ts` (the exact on-screen strings quoted below) |

Two people, Dana (left) and Omer (right), use Snapland at the same time, each in their own browser context. The
viewer watches both screens at once, so every collaboration moment shows cause and effect side by side. Captions are
plain English and never use internal words (no "WebSocket", "409", "EPSG" in captions; the end card names the stack).

---

## 1. What the video proves

| Scene | Graded requirement (`instractions.md`) | Proof on screen |
|---|---|---|
| 2 | User authentication and session management | Sign-up with an email username (D-8) and with a handle; the live pill and presence appear |
| 3 | Show other users' drawing actions in real time; display area while drawing | Dana's readout changes with every mouse move; Omer sees her dashed draft and its km² chip |
| 4 | Area in km² for drawn polygons; accurate area (Earth's curvature) | The same km² in Dana's panel, Omer's toast, tooltip and status bar |
| 5 | Two base layers, smooth transition, drawings stay in place, projections | Map -> Aerial (GovMap 2022, Israeli grid) mid-drawing; points stay on the same corners; ITM coordinates |
| 3, 5, 6 | Show active users viewing/drawing | Avatars with status badges, People list "Drawing a new area", lock chip "Dana is editing" |
| 6 | Drawing capabilities (edit) | Point drag with sliding midpoints, a new point from a midpoint, delta readout |
| 7 | Concurrent drawing; conflict resolution | Lock banner, *Edit anyway*, early warning, conflict panel with both shapes, *Keep mine* |
| 8 | Area versioning and edit history | History list, dotted preview of v3, restore as v5 |
| 9 | Soft deletes | Delete with *Undo*; Omer's panel explains who deleted it |
| 11 | Graceful degradation when WebSocket fails | Reconnecting -> Limited connection -> polling brings Dana's new area -> Omer saves -> back online |

---

## 2. Frame

```
1920 x 1200
+---------------------------------------------+---------------------------------------------+
|                                             |                                             |
|   DANA  (browser context 1)                 |   OMER  (browser context 2)                 |
|   viewport 960 x 1080, dark theme           |   viewport 960 x 1080, dark theme           |
|   base map: Map (OpenStreetMap)             |   base map: Map, then Aerial from scene 5   |
|                                             |                                             |
+---------------------------------------------+---------------------------------------------+
| (o) Dana          caption, centred, one line, <= 90 characters                  Omer (o)  |  120 px band
+-------------------------------------------------------------------------------------------+
```

- **Why 1200, not 1080.** Two 960 x 1080 panes fill a 1920 x 1080 frame, so a caption band there would cover the
  bottom of each pane, which is where the status bar (coordinates, "N areas, X km² in view") and the toast lane
  ("Saved...", *Undo*, "You're back online...") live. The 120 px band therefore sits under the panes, and the frame is
  16:10: a 16:9 player shows it with narrow bars at the sides.
- **What 960 px means for the layout** (UX section 3.2, C-28): the *overlay* layout. The inspector is a 340 px card floating
  over the right of the map, shown only when it has content (a selection, the save form, the conflict panel, People
  when opened) and hidden while drawing or editing. People and Activity start collapsed. When the card opens over a
  shape, the map pans the shape into the free area on the left. The storyboard places the work on the left half of
  the map for this reason.
- **Band.** 1920 x 120, background `#0e1116`. Left: a dot in Dana's colour + "Dana". Right: "Omer" + a dot in Omer's
  colour. Centre: the scene caption in Segoe UI 34 px, `#f2f4f7`. All four share one baseline, 72 px below the panes.
  The colours come from each user's `user.color` in the register response (section 6.2).
- **No OS cursor in Playwright videos.** Each page gets a drawn pointer with a press effect (section 6.3), so the viewer
  always sees what is being clicked or dragged.

---

## 3. Cast, places and data

**Users** (fresh database per take, so names and version numbers repeat exactly):

| Pane | Username | Display name | Password | Starts on |
|---|---|---|---|---|
| Left | `dana@example.com` (email username, D-8) | `Dana` | `SEED_USER_PASSWORD` from `.env.example`, read at run time (the field masks it) | Map |
| Right | `omer.levi` | `Omer` | same | Map |

Colours are assigned by the server from the user id (`USER_PALETTE[fnv1a32(id) mod 12]`), so they differ per take. If
both users get the same colour (1 in 12), throw the take away.

**Start view** (both users, seeded before the workspace opens, section 6.2): centre **32.0729, 34.7885**, zoom **17**, base map
**Map**. This frames Sarona Park on the left half and the Azrieli Center on the right.

**Shapes.** All vertices are `lat, lng`. Draw them in the order listed: it is counter-clockwise, which is the order the
server stores (`ST_ForcePolygonCCW`, SPEC section 5), so a handle's `data-index` in edit mode equals the index below.
Expected readouts are geodesic values of these exact vertices; a click lands on a screen pixel (about 1 m at zoom
17), so the last digit can differ by one between takes. What must hold in every take is that both panes show the same number.

| Shape | # | Vertex | lat, lng | Expected readout |
|---|---|---|---|---|
| **Sarona Park** v1 (Dana, scene 3) | 0 | NW corner | 32.07328, 34.78488 | 6 points ~ **0.048 km²**, 4.82 ha, perimeter 1.06 km |
| | 1 | West | 32.07284, 34.78488 | |
| | 2 | Inner corner | 32.07281, 34.78609 | |
| | 3 | South notch | 32.07152, 34.78609 | |
| | 4 | SE corner | 32.07152, 34.78843 | |
| | 5 | NE corner | 32.07322, 34.78848 | |
| Scene 6 edit (Dana) -> **v2** | 4 -> | SE corner dragged to | 32.07098, 34.78843 | ~ 0.055 km² (was 0.048 km²) |
| | mid 3 -> | midpoint of edge 3 dragged to (becomes point 4) | 32.07100, 34.78640 | 7 points ~ **0.060 km²** |
| Scene 7 Dana -> **v3** | 6 -> | NE corner dragged to | 32.07322, 34.78935 | ~ **0.071 km²** |
| Scene 7 Omer -> **v4** (on v2) | 2 -> | inner corner dragged to | 32.07215, 34.78530 | ~ **0.070 km²** |
| **Azrieli Center** (Omer, scene 5) | 0-2 on *Map* | NW, W, SW | 32.07556, 34.79168, 32.07446, 34.79116, 32.07382, 34.79132 | 3 points ~ 2,660 m² |
| | 3-5 on *Aerial* | S, SE, NE | 32.07393, 34.79239, 32.07429, 34.79262, 32.07556, 34.79224 | 6 points ~ **0.019 km²** |
| **Pop-up Market** (Dana, scene 11) | 0-3 | NW, SW, SE, NE | 32.0702, 34.7852, 32.0696, 34.7852, 32.0696, 34.7866, 32.0702, 34.7866 | ~ **8,800 m²** |

---

## 4. Timeline

| # | Scene | Time | Caption (<= 90 characters) |
|---|---|---|---|
| 1 | Title card | 0:00-0:05 | (on the card) Draw and measure areas on the map, together, in real time. |
| 2 | Sign up, Studio, presence | 0:05-0:20 | Dana signs up with her email, Omer with a username. Both land on the same live map. |
| 3 | Dana draws, Omer watches | 0:20-0:33 | Dana outlines Sarona Park. The area updates as she draws; Omer sees her draft live. |
| 4 | Save, same km² | 0:33-0:44 | Dana saves it. Omer sees the same area, measured on the curved Earth, not a flat map. |
| 5 | Map -> Aerial mid-drawing | 0:44-1:05 | Omer switches to the GovMap aerial photo mid-drawing. His points stay on the same spot. |
| 6 | Edit shape | 1:05-1:17 | Dana reshapes the park. Midpoint handles slide with the drag; Omer watches it live. |
| 7 | Simultaneous edit, conflict | 1:17-1:41 | Both edit at once. Dana saves first, so Omer gets a clear choice and nothing is lost. |
| 8 | History and restore | 1:41-1:54 | Every save is a version. Dana previews v3 and restores it as a new version, v5. |
| 9 | Delete with Undo | 1:54-2:05 | Delete is soft and undoable. Omer sees the area go and come back. |
| 10 | Light theme | 2:05-2:11 | Dark or light: the theme is a choice per browser. Omer stays dark. |
| 11 | Connection drop and recovery | 2:11-2:37 | Omer's live link drops. The app falls back to polling, keeps saving, then catches up. |
| 12 | End card | 2:37-2:43 | (on the card) Built with React, Leaflet, Fastify, PostGIS and Redis. Code: github.com/&lt;owner&gt;/snapland |

**Pacing rules** (all scenes): type at 70 ms per character; glide the pointer between targets over 600-900 ms (never
teleport: Omer sees Dana's rubber-band follow her pointer); pause 300 ms on a target before clicking; hold every new
on-screen result at least 1.5 s, and 3 s for text-heavy moments (conflict panel, history, toasts), but never leave
both panes still for more than about 2.5 s (no dead time over 3 s). Collaboration toasts arrive about 3 s after the
change (batching window, UX section 6.5): the step tables already wait for them.

---

## 5. Scenes

Step tables: **+s** = seconds from the start of the scene; **Action** names the control by its test id (UX section 12) or
role; **On screen** quotes the real copy. `at(lat, lng)` is the screen point of a coordinate (section 6.4).

### Scene 1 - Title card (0:00-0:05, 5 s)

A full-frame 1920 x 1200 still, no panes, no band: the brand mark (`frontend/public/favicon.svg`) and **Snapland**,
the tagline "Draw and measure areas on the map, together, in real time.", and under it "Two users, two browsers, one
live map". Dark background matching the app. Fade to scene 2 over 0.5 s.

**Viewer must notice:** what the product is, before any UI.

### Scene 2 - Sign up, Studio UI, presence (0:05-0:20, 15.5 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | both | Pages already on `/signin` | "Sign in to Snapland" card with the tagline, dark theme |
| 0.8 | Dana | Click the link *New to Snapland? Create an account* (role `link`) | "Create your account" |
| 1.6 | Dana | Type `dana@example.com` in `username-input` | Label "Username or email", hint "Your email, or 3-32 letters, numbers, dots, dashes or underscores." |
| 3.0 | Dana | Type `Dana` in `display-name-input` | Hint "Shown to others on the map. Any language, up to 64 characters. Leave empty to use your username." |
| 3.6 | Dana | Type the password in `password-input` (40 ms/char) | Masked |
| 3.8 | Omer | Click *Create an account* | |
| 4.4 | Dana | Click `signup-submit` | "Creating account...", then the workspace over Tel Aviv, pill **Live**, notice "No areas here yet. Draw one with Draw area (D)." |
| 4.6 | Omer | Type `omer.levi`, `Omer`, password | |
| 7.6 | Omer | Click `signup-submit` | Omer's workspace. Both title bars: two avatars and "2 online" |
| 9.5 | Dana | Glide down the tool rail and rest on *Draw area* | Tooltip "Draw area, D" |
| 11.0 | Omer | Click the rail's *People* (`people-button`) | Overlay card, People: "Omer, You, Viewing", "Dana, Viewing" |
| 15.5 | | end | |

**Viewer must notice**

- Dana's username is an email address; nobody else sees it. Omer's People list and her avatar say "Dana" (D-8).
- The Studio chrome: title bar (brand, **Live** pill, avatars, "2 online", user menu), tool rail on the left, options
  bar with key hints (`D` Draw area, `A` Areas in view, `L` Map / Aerial), status bar with the map centre in
  latitude/longitude **and** ITM metres, zoom "z 17", scale bar, "0 areas in view".
- Dana's title bar gains Omer's avatar the moment he signs in: presence is live.

### Scene 3 - Dana draws; Omer sees the live draft (0:20-0:33, 12.5 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.5 | Dana | Click `draw-button` | Options bar: "AREA -, POINTS 0, Click the map to place the first point.", *Undo*, *Cancel*, *Finish* (disabled); crosshair |
| 1.5 | Dana | Click `at(Sarona 0)` | "Place at least 3 points." |
| 2.8 | Dana | Click `at(Sarona 1)` | |
| 4.1 | Dana | Click `at(Sarona 2)` | Readout in m² (~ 2,800 m²; while the pointer moves it counts as the next point) |
| 5.4 | Dana | Click `at(Sarona 3)` | ~ 5,400 m² |
| 6.7 | Dana | Click `at(Sarona 4)` | Readout switches to km² (~ 0.016 km²) |
| 8.0 | Dana | Click `at(Sarona 5)` | "AREA 0.048 km², POINTS 6, Double-click or Enter to finish." |
| 9.5 | Dana | Glide onto point 0 and rest (do not click yet) | The first point highlights: this is where the shape closes |
| 0.0-12.5 | Omer | No input | From Dana's first point: a dashed outline in **Dana's colour** with small dots, a dotted rubber-band to Dana's pointer, chip "Dana, drawing, 0.0xx km²"; People row "Dana, Drawing a new area"; Dana's avatar badge turns to a plus |

**Viewer must notice**

- The readout moves with Dana's pointer (the pointer counts as the next point) and switches from m² to km².
- Omer's chip shows Dana's area too, computed on his side from the points she streams. Because both panes share one
  view, the draft appears in the same place in both halves of the frame.
- Omer's map shows Dana's pointer path (rubber-band), not just her clicks.

### Scene 4 - Save; Omer sees the same km² (0:33-0:44, 11 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Click `at(Sarona 0)` (finish on the first point) | Overlay "Save area", *Name* focused; map chip "Unsaved"; options bar "AREA 0.048 km², POINTS 6" |
| 0.6 | Dana | Type `Sarona Park` in `area-name-input` | |
| 2.2 | Dana | Click `save-area-submit` | Chip "Saving...", then the Selection card: **Sarona Park**, 0.048 km², 4.82 ha, Perimeter 1.06 km, 6 points, v1, "Created, Dana, {today}"; History "v1 Created CURRENT"; toast "Saved "Sarona Park", 0.048 km²" |
| 2.5 | Omer | - | The dashed draft becomes a saved outline; the empty notice goes; status bar "1 area, 0.048 km² in view" |
| 5.5 | Omer | - | Toast "Dana created "Sarona Park", 0.048 km²" |
| 6.5 | Omer | Glide over the middle of Sarona Park | Tooltip "Sarona Park, 0.048 km²" |
| 9.5 | Dana | Click `close-panel-button` | Selection closes (frees the right of her map for scene 5) |
| 9.5 | Omer | Click `inspector-close` | People card closes (the tooltip has shown for about 2 s) |

**Viewer must notice:** one number everywhere - Dana's readout, her panel, Omer's toast, tooltip and status bar. The
browser previews with the same geodesic function the server stores (PostGIS `ST_Area(geography)`), so they cannot
disagree.

### Scene 5 - Omer switches Map -> Aerial mid-drawing (0:44-1:05, 21 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Omer | Click `draw-button` | Drawing options bar |
| 1.0 | Omer | Click `at(Azrieli 0)`, `at(Azrieli 1)`, `at(Azrieli 2)` at 1.2 s intervals | Readout ~ "2,660 m²", "POINTS 3" |
| 1.0-4 | Dana | No input | Omer's draft in **Omer's colour** with chip "Omer, drawing, 2,6xx m²"; his avatar badge turns to a plus |
| 4.5 | Omer | Glide up to the options bar, leaving the map north-east of the three points, then to the base-map control (top-left of the map) and rest on *Aerial* | The segmented control *Map*, *Aerial*. The route matters: a provisional point just west of the points would make the draft's edges cross, and the bar would flash "Closing edge would cross." |
| 6.0 | Omer | Click `layer-switch-aerial`; wait for `map[data-base-layer=govmap-itm]` and one `.leaflet-container` | 250 ms cross-fade to the 2022 photo; the view steps to the photo's nearest level (everything shrinks about 23 % around the centre); the three points sit on the same corners of the mall; readout still "2,6xx m²"; attribution "תצלום אוויר © GovMap / המרכז למיפוי ישראל" |
| 6.0-9 | Omer | Hold, then glide the pointer over the photo | Status bar: "lat, lng, ITM E ... N ..." updates under the pointer |
| 9.0 | Omer | Click `at(Azrieli 3)`, `at(Azrieli 4)`, `at(Azrieli 5)` at 1.2 s intervals | "AREA 0.019 km², POINTS 6" |
| 12.6 | Omer | Click `at(Azrieli 0)` | Save form in the overlay; the map pans left so the shape clears the card |
| 13.4 | Omer | Type `Azrieli Center`; click `save-area-submit` at 15.0 | Toast "Saved "Azrieli Center", 0.019 km²" |
| 17.0 | Omer | Click `close-panel-button` | |
| 17.8 | Omer | Drag the map 1 s so that `at(32.0729, 34.7885)` returns to the map's centre | Sarona Park back in full view |
| 18.0 | Dana | - (still on *Map*) | Toast "Omer created "Azrieli Center", 0.019 km²" |

**Viewer must notice**

- The switch happens mid-drawing and nothing is lost: same points, same readout, same undo stack, still drawing.
- It is a real projection change (Web Mercator -> Israeli TM grid): the scale steps, yet every point stays on its
  corner of the building. Dana stays on *Map* and sees Omer's draft in the right place on hers.
- The Hebrew attribution of the GovMap photo, and ITM metres in the status bar.

### Scene 6 - Dana edits the shape; midpoints follow the drag (1:05-1:17, 12.5 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Click `at(32.0725, 34.7870)` (inside Sarona Park) | Selection card for Sarona Park (v1) |
| 1.2 | Dana | Click `edit-shape-button` | Card hides; 6 point handles and a midpoint handle on every edge; options bar "AREA 0.048 km², POINTS 6, Drag points. Click a midpoint to add.", *Undo*, *Cancel*, *Save changes* |
| 2.4 | Dana | Drag `point-handle[data-index=4]` (SE) to `at(v2 SE)` in 35 moves over 1.5 s | The two midpoints of the SE corner's edges slide along with it; the fill follows; "AREA 0.055 km² (was 0.048 km²)" |
| 4.8 | Dana | Drag `midpoint-handle[data-index=3]` (the new slanted south edge) to `at(v2 new point)` over 1 s | A new point; "POINTS 7"; "AREA 0.060 km² (was 0.048 km²)"; strip "Point 5 of 7 selected." |
| 8.0 | Dana | Click `save-edit-button` | Toast "Saved changes to "Sarona Park", v2" |
| 1.2-8 | Omer | No input | A dashed ring in Dana's colour with chip "Dana is editing"; Dana's live edit preview with chip "Dana, editing" follows her drag on the aerial photo; her avatar badge turns to a pencil |
| 8.3 | Omer | - | The outline takes the new shape with one pulse in Dana's colour (no toast: the area is not selected on his side) |

**Viewer must notice:** the midpoint handles move with the dragged point, a new point comes from a midpoint, the
readout shows the change against the saved area, and Omer sees the edit live on a different base map.

### Scene 7 - Simultaneous edit -> conflict resolution (1:17-1:41, 24 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Click `edit-shape-button` (Sarona Park is still selected) | Handles again; Omer's map shows her lock ring and "Dana is editing" |
| 1.5 | Omer | Click `at(32.0725, 34.7870)` | Card with `lock-banner`: "Dana is editing this area. You can still edit. If you both save, the second save may need a quick review." The main button reads **Edit anyway** |
| 4.0 | Omer | Click `edit-shape-button` (*Edit anyway*) | Omer's strip: "Dana is editing this too."; chip "Dana is editing too". Dana's strip: "Omer is also editing this."; Omer's preview with chip "Omer, editing" appears on her map |
| 6.0 | Dana | Drag `point-handle[data-index=6]` (NE) to `at(v3 NE)` over 1.2 s | "AREA 0.071 km² (was 0.060 km²)" |
| 6.5 | Omer | At the same time, drag `point-handle[data-index=2]` (inner corner) to `at(v4 inner)` over 1.2 s | "AREA 0.070 km² (was 0.060 km²)" |
| 8.2 | Omer | Click an empty spot of his map (deselects the point, frees the strip, section 8 F3) | |
| 9.0 | Dana | Click `save-edit-button` | Toast "Saved changes to "Sarona Park", v3" |
| 9.5 | Omer | - (hold 2 s) | Warning strip "Dana saved a newer version." |
| 12.0 | Omer | Click `save-edit-button` | `conflict-panel`: "Dana saved "Sarona Park" while you were editing", "Some of your changes overlap with theirs. Choose what to keep - nothing is lost, every version stays in history."; legend "Your shape 0.070 km²" (solid) and "Dana's shape 0.071 km²" (dashed, Dana's colour); *Keep mine*, *Take theirs*, *Review differences*, *Decide later* |
| 14.0 | Omer | Click the eye toggle *Show theirs* (role `button`) off, then on at 16.5 | Dana's dashed shape hides for about 2 s and returns |
| 17.5 | Omer | Click `conflict-keep-mine` | Toast "Saved changes to "Sarona Park", v4" |
| 18.0 | Dana | - | Outline becomes Omer's shape with a pulse in Omer's colour; card "Version v4", "Last edit, Omer"; History "v4 Reshaped CURRENT, Omer" |
| 20.5 | Dana | - | Toast "Omer reshaped "Sarona Park", 0.070 km²" |

**Viewer must notice**

- Awareness before anyone saves: the lock ring and banner, *Edit anyway*, and both options bars naming the other
  person.
- The second save is never silently lost or overwritten: Omer gets an early warning, then a panel with both shapes
  and their areas, and chooses. Dana's v3 stays in history (scene 8 uses it).

### Scene 8 - Version history and restore (1:41-1:54, 13 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Glide over the History section | "v4 Reshaped CURRENT, Omer, 0.071 km² -> 0.070 km²", "v3 Reshaped, Dana, 0.060 km² -> 0.071 km²", "v2 Reshaped, Dana", "v1 Created, Dana, 0.048 km²" |
| 1.5 | Dana | Click `history-item[data-version=3]` | Dotted ghost of v3 over the current shape, the map fits both; options bar legend "v3, {day} {month}" (dotted) and "Current v4" (solid); card tag "PREVIEW" with v3's area; banner "Previewing v3 from just now." with *Restore this version* and *Exit preview* |
| 5.0 | Dana | Click `restore-version-button` | Toast "Restored v3 of "Sarona Park" as v5" with *Undo* and a countdown bar; History gains "v5 Restored, Dana, from v3" |
| 5.3 | Omer | - (his card still shows Sarona Park after *Keep mine*) | The shape changes with a pulse in Dana's colour; his History gains v5 |
| 8.5 | Omer | - | Toast "Dana reshaped "Sarona Park", 0.071 km²" |

**Viewer must notice:** history is append-only - restoring v3 creates v5, it does not rewrite v4 - and the preview
tells old from current by line pattern, not colour alone.

### Scene 9 - Delete with Undo (1:54-2:05, 11 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Click `delete-area-button` (shown only to the creator or an admin) | The area disappears, the card closes, toast "Deleted "Sarona Park"" with *Undo* and a 10 s countdown bar |
| 0.5 | Omer | - | The area disappears; his card turns into `deleted-state`: "Dana deleted this area just now.", "Ask Dana or an admin to restore it.", *Save a copy as a new area*, *Close* |
| 3.5 | Omer | - | Toast "Dana deleted "Sarona Park"" |
| 4.5 | Dana | Click `toast-undo` | The area returns, selected; toast ""Sarona Park" is back" |
| 5.5 | Omer | - | The area returns with a pulse; his card shows the details again, History "v7 Restored after delete", "v6 Deleted"; the "Dana deleted" toast goes (a newer event about an area replaces the unread one, UX section 6.5) |
| 9.5 | Omer | - | Toast "Dana restored "Sarona Park"" (at most one collaboration toast every 5 s) |

**Viewer must notice:** delete is optimistic and reversible (no "Are you sure?"), it is a soft delete kept in history,
and Omer - not the creator - is told who deleted it and what he can do instead.

### Scene 10 - Light theme (2:05-2:11, 6 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Dana | Click `user-menu-button` | Menu: "Dana", "dana@example.com", *Keyboard shortcuts*, *Quiet mode*, THEME *Dark* (checked) / *Light*, *Sign out* |
| 1.2 | Dana | Click `theme-option-light` | The whole pane turns light at once, map tiles included; the check moves to *Light*; the menu stays open |
| 3.5 | Dana | Click `user-menu-button`, then `close-panel-button` | Menu closes; Sarona Park deselected (ready for scene 11) |
| 3.5 | Omer | Click `close-panel-button` | His card closes; he stays dark |

**Viewer must notice:** a per-browser preference, applied instantly without a reload or a lost state. Dana's email
appears only in her own menu.

### Scene 11 - The live connection drops; limited mode; reconnect and resync (2:11-2:37, 26 s)

| +s | Pane | Action | On screen |
|---|---|---|---|
| 0.0 | Omer | Script drops Omer's live socket and refuses new ones (section 6.5) | Nothing for 3 s (short blips are not reported) |
| 0.2 | Dana | - | Omer's avatar leaves her title bar: "1 online" |
| 0.5 | Dana | Click `draw-button`; click `at(Pop-up 0…2)` at 1.2 s intervals; double-click `at(Pop-up 3)`, which places it and finishes | Her draft and readout; **Omer's map shows nothing** |
| 3.0 | Omer | - | Pill "Reconnecting..." with a spinner |
| 5.0 | Dana | Type `Pop-up Market`; click `save-area-submit` (saved by about 8 s, so Omer's first poll at 10 s brings it) | Toast "Saved "Pop-up Market", 8,8xx m²" |
| 10.0 | Omer | - | Pill "Limited connection" (cloud icon); his own avatar stays: "2 online". The first poll brings **Pop-up Market** onto his aerial map with a pulse in Dana's colour (no toast: polled changes only pulse) |
| 12.0 | Omer | Click `at(32.0699, 34.7859)` | Card: Pop-up Market, 8,8xx m², v1, and "We can't check right now whether someone else is editing this area." |
| 13.5 | Omer | Click `rename-button`; in `rename-input` press Ctrl+A, type `Friday Market`, press Enter | Toast "Renamed to "Friday Market"" - saved over plain HTTP |
| 14.5 | Dana | - | Her card's name becomes "Friday Market" at once |
| 18.0 | Dana | - | Toast "Omer renamed "Pop-up Market" to "Friday Market"" |
| 18.0 | Omer | Click `connection-status` | Popover "Limited connection - Live updates are paused. We check for changes every 5 seconds and saving still works." with *Reconnect now* |
| 19.5 | Omer | Script allows the socket again; click *Reconnect now* (role `button`) at 20.0 | Pill "Live"; toast "You're back online. 1 area in view changed while you were away." (see section 8 F1) |
| 20.5 | Dana | - | Omer's avatar returns: "2 online" |

**Viewer must notice**

- The app says exactly what state it is in - Reconnecting, then Limited connection, then Live - in words, not only
  colour.
- While limited, Omer loses live drafts (he never saw Dana drawing) but still receives saved changes by polling and can
  still save; Dana, who is live, sees his rename instantly.
- On reconnect, Snapland catches up from the change feed and tells Omer what changed while he was away.

### Scene 12 - End card (2:37-2:43, 6 s)

A full-frame still in the title card's style, headed "Built with React, Leaflet, Fastify, PostGIS and Redis.", then:

- **Snapland** - collaborative GIS take-home
- React 19 + TypeScript + Leaflet 1.9: custom drawing and realtime, no collaboration plugins
- OpenStreetMap + GovMap 2022 aerial photos in the Israeli grid (EPSG:2039)
- Node 22 + Fastify 5 + WebSocket (`ws`): two stateless replicas behind nginx, Redis pub/sub fan-out
- PostgreSQL 17 + PostGIS 3.5: GiST index, versions, soft deletes; Redis 7: rate limits (50/min), locks, cache
- Geodesic km² on the WGS84 ellipsoid, identical in browser and database
- OpenAPI docs, health checks, metrics, unit + integration + Playwright + k6 tests
- **github.com/&lt;owner&gt;/snapland** (placeholder - replace before export)

---

## 6. Recording recipe

One Playwright script drives both panes. It is not a test: keep it out of `e2e/tests/` (for example
`e2e/demo/record.ts`, run with the e2e workspace's Playwright), so `npm run test:e2e` never runs it.

### 6.1 Isolated stack

Never record against the everyday stack on :5173. Use a separate compose project with its own ports, built with the
E2E overlay (it compiles in the read-only `window.__snapland` hook and the ITM *Aerial* layer, and raises the per-IP
auth limit so re-takes are not rate-limited). Keep the override in a scratch folder, never in the repo:

```yaml
# <scratch>/demo.override.yml - allows the demo origin; nothing else changes
services:
  backend-1: { environment: { CORS_ORIGINS: 'http://localhost:5190' } }
  backend-2: { environment: { CORS_ORIGINS: 'http://localhost:5190' } }
```

```bash
export HTTP_HOST_PORT=5190 PG_HOST_PORT=55452 REDIS_HOST_PORT=56399 REDIS_CACHE_HOST_PORT=56400
F="-p snapland-demo -f docker-compose.yml -f docker-compose.e2e.yml -f <scratch>/demo.override.yml"
docker compose $F build nginx          # builds only snapland-nginx:e2e; the shared backend image is not rebuilt
docker compose $F up -d --no-build --wait
# ... record ...
docker compose $F down -v              # one fresh database per take
```

The machine needs internet access for the tiles (`tile.openstreetmap.org`, `cdn.govmap.gov.il`).

### 6.2 Browser contexts

- One headless Chromium; two contexts, each `viewport: { width: 960, height: 1080 }`,
  `recordVideo: { dir, size: { width: 960, height: 1080 } }`, `reducedMotion: 'no-preference'` (pulses animate).
- **Start view.** The stored view is keyed by user id (`snapland:view:<id>`), which does not exist before sign-up. The
  script intercepts the register call and stores the view before the app reads it, so both users land on the same
  Tel Aviv view (checked in the dry run):

  ```ts
  await page.route('**/api/v1/auth/register', async (route) => {
    const response = await route.fetch();
    const { user } = await response.json();
    colors[name] = user.color;                      // for the caption band
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [
      `snapland:view:${user.id}`,
      JSON.stringify({ center: { lat: 32.0729, lng: 34.7885 }, zoom: 17, choice: 'map' }),
    ]);
    await route.fulfill({ response });
  });
  ```

### 6.3 Visible pointer

Playwright videos do not show the OS cursor. Add this with `context.addInitScript` (styles are set through the CSSOM,
which the app's Content Security Policy allows):

```js
addEventListener('DOMContentLoaded', () => {
  const dot = document.createElement('div');
  Object.assign(dot.style, {
    position: 'fixed', left: '-40px', top: '-40px', width: '18px', height: '18px', margin: '-9px 0 0 -9px',
    borderRadius: '50%', border: '2px solid #fff', background: 'rgb(0 0 0 / 0.35)',
    boxShadow: '0 0 0 1px rgb(0 0 0 / 0.6)', pointerEvents: 'none', zIndex: '2147483647', transition: 'transform 120ms',
  });
  document.body.append(dot);
  addEventListener('pointermove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
  addEventListener('pointerdown', () => { dot.style.transform = 'scale(0.6)'; }, true);
  addEventListener('pointerup', () => { dot.style.transform = ''; }, true);
});
```

### 6.4 Where to click

- **Coordinates:** `at(page, lat, lng)` = the map's box (`getByTestId('map')`) plus
  `window.__snapland.project(lat, lng)`, which is CRS-aware (it works on *Aerial* too). Call it right before every
  click: the map moves on its own (the overlay card pans shapes clear, a history preview fits both shapes), so pixels
  computed earlier go stale. After a base-map switch, wait for one `.leaflet-container` first (the outgoing map stays
  underneath until the new tiles load, SPEC section 8.4).
- **Handles:** `[data-testid="point-handle"][data-index="i"]` and `[data-testid="midpoint-handle"][data-index="i"]`
  (edge *i* runs from point *i* to point *i + 1*). Use the centre of the element's box.
- **Drags:** `mouse.move` to the handle, `mouse.down`, then 30-35 `mouse.move` calls with 40 ms between them, then
  `mouse.up`. Playwright's `steps` option alone moves instantly, which the viewer cannot follow.
- **Waits:** wait on state, not time, before the next beat (`connection-status[data-state]`, `map[data-base-layer]`,
  `point-count[data-count]`, `toast` text); use fixed pauses only for rhythm.
- **Prefer the pointer to Escape** on the map: a keyboard Escape leaves the map's keyboard focus ring around the whole
  pane. Close cards with `close-panel-button` / `inspector-close`.
- Controls without a test id: *Create an account* (role `link`), *Show theirs* (role `button`), *Reconnect now* (role
  `button`).

### 6.5 Dropping Omer's live connection

Route Omer's socket through Playwright from the start, so the script can cut it on cue. `unrouteAll()` does not remove
a WebSocket route, so the handler reads a flag (as in `e2e/playwright.config.ts`):

```ts
let blocked = false;
let live: { page: WebSocketRoute; server: WebSocketRoute } | null = null;
await omerContext.routeWebSocket(/\/ws/u, (ws) => {
  if (blocked) return ws.close({ code: 1001, reason: 'demo: network drop' });
  live = { page: ws, server: ws.connectToServer() };      // pass-through
});
// scene 11, +0.0
blocked = true;
await live?.page.close({ code: 1001, reason: 'demo: network drop' });
await live?.server.close();
// scene 11, +19.5
blocked = false;                                           // then click *Reconnect now*
```

Timings seen in the dry run: *Reconnecting...* after 3 s, *Limited connection* after 10 s (`WS_GRACE_MS`,
`WS_DEGRADE_AFTER_MS`), the first poll at the moment Limited starts. If an automatic retry reconnects before the click
on *Reconnect now*, the beat still works: the pill goes Live and the same toast appears.

### 6.6 Timeline log

Log `Date.now()` right after each `newPage()` and at the start of every scene into `timeline.json`. The start of scene
2 is `t0`. Each pane's video is trimmed by `t0 − pageCreatedAt`; the captions run from each scene's start to the next
scene's start.

---

## 7. Compositing

`e2e/demo/compose-demo.ts` does all of this; the steps are here so the result can be checked.

1. **Cards.** Render the title and end cards as 1920 x 1200 PNGs by screenshotting a small HTML page with
   `page.setContent`. The cards carry their own text (scene 1 and 12 content), so they get no band.
2. **Panes.** Trim each pane's video by its offset from `t0`, drop its VP8 keyframes (Playwright writes one every
   5.12 s, visibly softer than the frames around it, so the pane would flicker), resample to 30 fps (which repeats the
   frame before each dropped one) and stack the two side by side.
3. **Band.** Pad the stack to 1920 x 1200 in `#0e1116` and draw the names, dots and captions with `drawtext` on one
   baseline (section 2). Each caption runs from its scene's start in `timeline.json` to the next scene's start.
4. **Cards and fades.** Concatenate title card (5 s), main segment and end card (6 s), with 0.5 s fades through the
   band colour; H.264 `-crf 21 -preset slow`, yuv420p, `+faststart`, no audio, at most 60 MB.

---

## 8. Pre-flight checklist and known issues

Before a take:

- [ ] Isolated stack healthy (:5192, `docs/demo/README.md`), fresh database (`down -v` after the previous take).
- [ ] Both register responses have different `user.color` values; otherwise re-take.
- [ ] The *Aerial* photo loads at the Azrieli Center (internet access to `cdn.govmap.gov.il`).

Findings from the dry run, for the team lead:

| ID | Severity | Where | What the viewer would see | Expected (UX.md) | Suggested fix |
|---|---|---|---|---|---|
| F1 | Major for the demo | Scene 11, `toast.backOnline` (`frontend/src/base/en.ts`, `Workspace.backOnlineToast`) | "You're back online. **1 areas** in view changed while you were away." The count is also of changes, not areas: two edits to one area read "2 areas". | Correct plural; UX section 9.7 has no singular form either | **Fixed:** the toast counts distinct area ids and reads "1 area … changed" for one (UX section 9.7) |
| F2 | Minor | Scene 11, Omer's title bar in Limited | Omer's own avatar disappears and the count reads "1 online" (the polled presence lists live connections only) | UX section 6.1: my avatar is always first | **Fixed:** my own row and avatar come from my session, so I stay first and counted while Limited |
| F3 | Minor | Scene 7 at 960 px, options-bar strip | With a point still selected, the *Move point* / *Delete point* buttons squeeze the early warning to "Dana saved a newer versi..." | UX F-09 step 1: the warning is readable | Let the warning replace the point controls while it shows. The storyboard deselects the point first (scene 7, +8.2) |
| F4 | Note | *Reconnect now*, conflict *Show mine* / *Show theirs* | - | Not in the UX section 12 registry | Optional: register `reconnect-now-button`; role locators work today |
| F5 | Minor | Scene 3, hovering the first point with >= 3 points | The point highlights but no "Click to finish" tooltip appears: `base.draw.finishHere` is defined and never rendered | UX C-06.1: enlarged ring **and** tooltip | Render the tooltip on the first point while closing is valid. The storyboard does not rely on it |
| F6 | Note | Scene 5, *Aerial* hover | The "GovMap aerial photo (2022)" hint is a native `title`, which never appears in a recording | - | None needed; the attribution line names GovMap |

---

## 9. Dry-run record

On 2026-09-30 scenes 2-11 were driven by a Playwright script at 960 x 1008 against an isolated production build (not
the E2E build, so positions were computed from Web Mercator maths and, on *Aerial*, from the placed points; the
recording should use `__snapland.project`; the vertices then differed from section 3 by a few metres, and section 3's were tuned
afterwards so the readouts sit away from a rounding edge). Confirmed: the register interception lands both users on the start view;
Sarona Park and the Azrieli Center fall where section 3 says and Sarona stays clear of the overlay card; the People list shows
"Drawing a new area"; the km² matches across panes, toast, tooltip and status bar; the Map -> Aerial switch keeps the
points on the same corners; the save form's auto-pan (so Omer's pan-back beat is needed); stored rings are
counter-clockwise; midpoints slide during a drag; the lock banner, *Edit anyway*, both options-bar messages, the early
warning, the conflict panel and *Keep mine*; history preview and restore as v5; the deleted state on Omer's side and
Undo; the light theme; Reconnecting at 3 s, Limited at 10 s, the polled area, the rename over HTTP reaching Dana live,
the pill popover, and the back-online toast (with F1). Every string quoted in section 5 was read from the running app or
from `frontend/src/base/en.ts`.
