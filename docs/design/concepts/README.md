# Snapland design concepts

Four directions for the Snapland web app. They all show the same scenario: I am drawing a new area (1.27 km², 5 points), Omer is drawing, Dana is viewing, and Yarkon Park Plot is selected.

- Desktop comparison: [`concepts-desktop-2x2.png`](concepts-desktop-2x2.png)
- Phone comparison: [`concepts-mobile-row.png`](concepts-mobile-row.png)
- Each folder has `mockup.html`, `desktop.png`, `mobile.png`, extra state frames and `notes.md`.

| # | Concept | UX fit |
|---|---------|--------|
| 4 | Multiplayer canvas | **8/10** |
| 1 | Studio | 7/10 |
| 3 | Field | 7/10 |
| 2 | Atlas | 6/10 |

## Recommendation

Build on **4-multiplayer's** structure and use **3-field's** phone ergonomics. Keep two ideas from **1-studio**: keyboard hints on the controls and tabular numbers. Borrow one idea from **2-atlas**: saved areas get a hatched fill and drafts a flat one, so saved and in-progress areas look different without relying on colour.

### Problems all four share (fix these first)

- **Toast during drawing.** Every concept shows the "Dana saved Yarkon Park Plot" toast while I am drawing. UX §6.5 holds collaboration toasts while drawing, and on phones whenever the drawing bar (HUD) is visible.
- **Mouse cursor on phone.** Studio, Atlas and Field show a crosshair and rubber-band line on the phone frame. Touch has no hover, so the phone should show only the placed points, closed (C-06.3). Multiplayer gets this right.
- **Crowded phone frames.** The phone frames show drawing and a selected-area card together, which the app never does (§3.4). This squeezes the free map strip to about the 45% minimum (UX-AC-82).
- **Missing grid coordinates.** Only Field and Multiplayer show the Israeli grid (ITM) numbers in the coordinate readout (C-27 requires them). Studio and Atlas show latitude and longitude only.

---

## 1 · Studio — UX fit 7/10

**Idea:** Snapland as a precision instrument: dark docked chrome and a keyboard-first workflow, with every value in tabular mono. Folder: [`1-studio/`](1-studio/).

**Pros**
- Dark chrome reads well next to aerial imagery.
- Drafts are clearly separated: mine is solid cyan, others are dashed in their colour, and saved areas are white.
- The status bar and the inspector (selection, history, people) are dense but calm, and every control shows its keyboard hint.

**Cons**
- It is dark-only, so the OSM "Map" layer is untested. It also adds a Measure tool (M) that the spec explicitly dropped.
- It has 9–10 px text and a 22 px-tall button, and its phone frame is the most crowded of the four.

## 2 · Atlas — UX fit 6/10

**Idea:** A printed atlas you can draw in: warm paper cards over a sepia map, engraved hatched plates for saved areas and serif cartouche labels. Folder: [`2-atlas/`](2-atlas/).

**Pros**
- It is the most distinctive and calm of the four.
- The hatched fill for saved areas versus a flat tint for drafts separates saved and in-progress work without relying on colour.
- The low-saturation paper leaves plenty of contrast for the collaborator inks.

**Cons**
- The thin terracotta draft line gets lost in the busy sepia street map. On phone, Cancel and Undo are icon-only in a one-line bar that cannot fit error messages, and the avatars overlap.
- Moving the drawing bar to the bottom and listing drafts under "Drawing now" in the Areas list both go against UX.md (C-05, C-07), so choosing Atlas would mean rewriting those sections.

## 3 · Field — UX fit 7/10

**Idea:** A sunlight-readable, mobile-first tool for field crews: ink-on-paper chrome, one safety-yellow "me / go" signal, huge numerals and targets of 48 px or more. Folder: [`3-field/`](3-field/).

**Pros**
- Best phone layout: the readout, Cancel, Undo and Finish sit in the thumb zone, and targets are 48 px or more.
- Ink outlines on every overlay keep them legible on any base map.
- The coordinate readout includes the grid (ITM) numbers.

**Cons**
- My draft and the selected area are both yellow and ink, and the hazard-hatch fill hides the streets I am tracing.
- On desktop, presence lives only in the bottom panel, and the phone has no way to open the Areas list. It is loud for planners at a desk.

## 4 · Multiplayer canvas — UX fit 8/10

**Idea:** "Figma for maps": the map is a shared canvas and people carry the colour, with a People/Areas/Activity sidebar, a properties inspector and edge pills for off-screen teammates. Folder: [`4-multiplayer/`](4-multiplayer/).

**Pros**
- You see who is doing what at a glance: presence with status badges, a "Live now" card, other people's drafts in their colour, and off-screen teammates as pills at the screen edge.
- The drawing bar sits top-centre as C-05 requires, and the inspector is complete.
- The phone sheet has an Areas tab, so the text alternative to the map is reachable. Its scenario data is the most consistent of the four.

**Cons**
- It turns nice-to-have features (activity feed, Follow, live cursors) into core ones, and Dana's cursor while she is only viewing needs a message the spec does not have.
- The selected area and my draft are both blue with a fill, the chrome takes about 620 px of map width, and several phone targets are below 44 px.
