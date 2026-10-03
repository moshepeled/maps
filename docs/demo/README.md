# Snapland demo video

`snapland-demo.mp4` shows two people, Dana (left) and Omer (right), using Snapland at the same time in two browsers.
It follows [STORYBOARD.md](STORYBOARD.md), with the changes listed under [Differences from the storyboard](#differences-from-the-storyboard).

| | |
|---|---|
| **Video** | `snapland-demo.mp4`: 2:43, 1920 x 1200 (two 960 x 1080 panes and a 120 px caption band), 30 fps, H.264 yuv420p, `+faststart`, no audio, about 34 MB |
| **Stills** | `frames/scene-NN.png`: the middle frame of scenes 3, 4, 5, 7, 8 and 11 |
| **Recorder** | `e2e/demo/record-demo.ts` (Playwright), with its own config `e2e/demo/playwright.config.ts` |
| **Composer** | `e2e/demo/compose-demo.ts` (Chromium for the cards, ffmpeg for the rest) |

## Scenes

| # | Scene | Time | Caption |
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
| 12 | End card | 2:37-2:43 | (on the card) Built with React, Leaflet, Fastify, PostGIS and Redis. |

The recorder writes each scene's real start to `e2e/demo/recording/timeline.json`, and the captions follow those times,
so a take that runs a little long stays in sync.

## Re-recording

You need Docker, Node 22, the e2e workspace's Chromium (`npx playwright install chromium` in `e2e/`), ffmpeg with
libx264 and libfreetype on `PATH`, Windows' Segoe UI font (`C:/Windows/Fonts/segoeui.ttf`), and internet access for the
map tiles (`tile.openstreetmap.org`, `cdn.govmap.gov.il`).

Record against an isolated production stack on port 5192, never the everyday stack on :5173. The recorder signs up
fixed users (`dana@example.com`, `omer.levi`, password `SEED_USER_PASSWORD` from `.env.example`), so every take needs a
fresh database.

1. Write a compose override in a scratch folder outside the repository. It gives the demo its own image tags, so the
   everyday `snapland-*:local` images are never re-tagged, and allows the demo origin:

   ```yaml
   # <scratch>/demo.override.yml
   services:
     migrate: { image: 'snapland-backend:demo' }
     seed: { image: 'snapland-backend:demo' }
     backend-1:
       image: 'snapland-backend:demo'
       environment: { CORS_ORIGINS: 'http://localhost:5192' }
     backend-2:
       image: 'snapland-backend:demo'
       environment: { CORS_ORIGINS: 'http://localhost:5192' }
     nginx: { image: 'snapland-nginx:demo' }
   ```

2. Build and start the stack (Git Bash, from the repository root):

   ```bash
   export HTTP_HOST_PORT=5192 PG_HOST_PORT=55492 REDIS_HOST_PORT=56492 REDIS_CACHE_HOST_PORT=56493
   F="-p snapland-demo -f docker-compose.yml -f <scratch>/demo.override.yml"
   docker compose $F build backend-1
   docker compose $F build nginx
   docker compose $F up -d --no-build --wait
   ```

3. Record (about 3 minutes), then compose (about 1 minute):

   ```bash
   npm run demo:record -w @snapland/e2e    # e2e/demo/recording/: dana.webm, omer.webm, timeline.json
   npm run demo:compose -w @snapland/e2e   # docs/demo/snapland-demo.mp4 and docs/demo/frames/
   ```

   `DEMO_BASE_URL` changes the stack URL (default `http://localhost:5192`). `DEMO_REPO_URL` adds the repository link
   to the end card. The composer can be re-run on the same take, for example after changing a caption.

4. Tear the stack down, which also deletes its database:

   ```bash
   docker compose $F down -v
   docker image rm snapland-backend:demo snapland-nginx:demo
   ```

For another take, run `docker compose $F down -v` and `docker compose $F up -d --no-build --wait` first.

**Throw the take away** when the recorder stops with "Both users got the colour ..." (the server picks colours from
the user id, so one take in twelve gives both users the same colour), or when the two colours are hard to tell apart in
the stills.

## How the recorder works

- **Two browser contexts**, each 960 x 1080 with its own video, dark theme, and motion on. The register response is
  intercepted to store the start view (32.0729, 34.7885, zoom 17, *Map*) before the app reads it, and to read each
  user's colour for the caption band.
- **A drawn pointer** replaces the missing OS cursor. Every move is timed (650 ms glides, 300 ms rest before a click,
  timed drags), so Omer sees Dana's rubber band follow her pointer. A click measures its target again after the glide,
  because a card that was still sliding in has moved since.
- **Screen points come from Leaflet.** The production build has no E2E hook, so an init script registers every Leaflet
  map as it is created (the bundle assigns `window.L`) and projects coordinates with the live map. This works on
  *Aerial* (EPSG:2039) too. It is read right before each click, because the map pans on its own.
- **State, not sleeps.** Each beat waits for the UI state it depends on: test ids, `data-state`, `data-count`, toast
  text, with a 20 s limit on every wait and action. Fixed pauses (`until(start, seconds)`) only keep the storyboard's
  rhythm, and each scene ends at most about 2.5 s after its last visible change.
- **No soft keyframes.** Playwright's VP8 writes a keyframe every 5.12 s that is visibly softer than the frames around
  it; the composer drops them and repeats the frame before, so the panes do not flicker.
- **Omer's WebSocket runs through Playwright** (`routeWebSocket`, set up before the first page loads), so scene 11
  can cut it and let it back in on cue.

## Differences from the storyboard

- **Build.** The stack is the production build on :5192, not the E2E overlay on :5190, so the video shows the real
  product. The recorder uses Leaflet itself instead of `window.__snapland.project`.
- **Sarona Park drawing order.** Dana starts at the SE corner (the same counter-clockwise ring as section 3). Starting at the
  NW corner makes every partial outline cross itself, so the readout showed "Closing edge would cross" instead of an
  area for most of scene 3. The edit handles follow the new order: SE is point 0, NE is point 1, the inner corner is
  point 4, and the new point comes from midpoint 5. The areas are unchanged (0.048, 0.060, 0.071 and 0.070 km²).
- **End card.** The repository link is left out unless `DEMO_REPO_URL` is set, because the repository has no public
  remote yet.

## Product behaviour visible in the video

These come from the app, not the recording, and are accepted as they are (F1 and F2 of STORYBOARD section 8 are
fixed):

- Scene 5: Dana's chip for Omer's draft can differ from his own readout by a few m² (for example 2,678 against
  2,679 m²). Live drafts stream at 6 decimals (about 11 cm) to keep the messages small; saved areas use 7, so every
  saved figure matches exactly (scene 4).
- Map tiles load progressively: each workspace shows an empty map for under a second after sign-up, and the aerial
  photo is soft for about a second after the switch.
- Scene 6: Dana's avatar keeps its pencil badge for a few seconds after she saves.
