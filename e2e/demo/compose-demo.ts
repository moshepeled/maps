/**
 * Composes docs/demo/snapland-demo.mp4 from a take of record-demo.ts (docs/demo/README.md): renders the title and end
 * cards with Chromium, stacks the two pane videos side by side from the start of scene 2, adds the 1920 x 120 caption
 * band (drawtext, timed by timeline.json), and exports six still frames to docs/demo/frames/.
 *
 * Run from e2e/: `node --experimental-strip-types demo/compose-demo.ts` (ffmpeg with libx264 and libfreetype on PATH).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const RECORDING = fileURLToPath(new URL('./recording/', import.meta.url));
const DOCS = fileURLToPath(new URL('../../docs/demo/', import.meta.url));
const FAVICON = fileURLToPath(new URL('../../frontend/public/favicon.svg', import.meta.url));
const OUTPUT = `${DOCS}snapland-demo.mp4`;
const MAX_BYTES = 60 * 1024 * 1024;

const WIDTH = 1920;
const PANE_HEIGHT = 1080;
const HEIGHT = PANE_HEIGHT + 120;
const TITLE_S = 5;
const END_S = 6;
const FADE_S = 0.5;
const BAND = '0x0e1116';
const TEXT = '0xf2f4f7';
const FONT = 'C:/Windows/Fonts/segoeui.ttf';
/** The scenes whose midpoints become the still frames. */
const FRAME_SCENES = [3, 4, 5, 7, 8, 11];

interface Timeline {
  panes: { name: string; video: string; color: string; offsetMs: number }[];
  scenes: { n: number; caption: string; startMs: number }[];
  endMs: number;
}

const timeline = JSON.parse(readFileSync(`${RECORDING}timeline.json`, 'utf8')) as Timeline;
const [left, right] = timeline.panes;
if (left === undefined || right === undefined || timeline.scenes.length === 0 || timeline.endMs <= 0) {
  throw new Error('recording/timeline.json is incomplete: record a full take first');
}
const mainS = timeline.endMs / 1000;

// -- Cards (scenes 1 and 12) -----------------------------------------------------------------------------------------

const mark = readFileSync(FAVICON, 'utf8').replace('width="24" height="24"', 'width="112" height="112"');
const repoUrl = process.env['DEMO_REPO_URL'];

const card = (content: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; display: grid; place-items: center;
    background: #0e1116; color: #f2f4f7; font-family: 'Segoe UI', sans-serif; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 36px; }
  h1 { margin: 0; font-size: 120px; font-weight: 600; letter-spacing: -2px; }
  .small { justify-content: flex-start; gap: 20px; margin-bottom: 48px; }
  .small svg { width: 56px; height: 56px; }
  .small h1 { font-size: 56px; letter-spacing: 0; }
  h2 { margin: 0 0 56px; font-size: 56px; font-weight: 600; }
  .tagline { margin: 56px 0 0; font-size: 48px; text-align: center; }
  .sub { margin: 28px 0 0; font-size: 32px; color: #8b95a5; text-align: center; }
  ul { margin: 0; padding: 0; list-style: none; font-size: 34px; line-height: 1.45; }
  li { position: relative; padding-left: 44px; margin: 14px 0; }
  li::before { content: ''; position: absolute; left: 0; top: 20px; width: 14px; height: 14px; border-radius: 3px;
    background: #22d3ee; }
  b { font-weight: 600; }
</style></head><body><main>${content}</main></body></html>`;

const titleCard = card(`
  <div class="brand">${mark}<h1>Snapland</h1></div>
  <p class="tagline">Draw and measure areas on the map, together, in real time.</p>
  <p class="sub">Two users, two browsers, one live map</p>`);

const endCard = card(`
  <div class="brand small">${mark}<h1>Snapland</h1></div>
  <h2>Built with React, Leaflet, Fastify, PostGIS and Redis.</h2>
  <ul>
    <li><b>Snapland</b> - collaborative GIS take-home</li>
    <li>React 19 + TypeScript + Leaflet 1.9: custom drawing and realtime, no collaboration plugins</li>
    <li>OpenStreetMap + GovMap 2022 aerial photos in the Israeli grid (EPSG:2039)</li>
    <li>Node 22 + Fastify 5 + WebSocket (ws): two stateless replicas behind nginx, Redis pub/sub fan-out</li>
    <li>PostgreSQL 17 + PostGIS 3.5: GiST index, versions, soft deletes; Redis 7: rate limits, locks, cache</li>
    <li>Geodesic km² on the WGS84 ellipsoid, identical in browser and database</li>
    <li>OpenAPI docs, health checks, metrics; unit, integration, Playwright and k6 tests</li>
    ${repoUrl === undefined ? '' : `<li><b>${repoUrl}</b></li>`}
  </ul>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
for (const [name, html] of [
  ['title', titleCard],
  ['end', endCard],
] as const) {
  await page.setContent(html);
  await page.screenshot({ path: `${RECORDING}${name}.png` });
}
await browser.close();

// -- Caption band and composition ------------------------------------------------------------------------------------

/** A path inside a quoted filter option: forward slashes, and the drive colon escaped for the option parser. */
function filterPath(path: string): string {
  return path.replaceAll('\\', '/').replace(':', '\\:');
}

const font = `fontfile='${filterPath(FONT)}'`;
/** Every text in the band shares one baseline, so the dots, names and captions line up. */
const baseline = `y_align=baseline:y=${PANE_HEIGHT + 72}`;
const band = [
  `drawtext=${font}:text='●':fontsize=34:fontcolor=${left.color.replace('#', '0x')}:x=28:${baseline}`,
  `drawtext=${font}:text='${left.name}':fontsize=30:fontcolor=${TEXT}:x=68:${baseline}`,
  `drawtext=${font}:text='${right.name}':fontsize=30:fontcolor=${TEXT}:x=w-68-tw:${baseline}`,
  `drawtext=${font}:text='●':fontsize=34:fontcolor=${right.color.replace('#', '0x')}:x=w-28-tw:${baseline}`,
];
timeline.scenes.forEach((scene, index) => {
  const from = scene.startMs / 1000;
  const to = (timeline.scenes[index + 1]?.startMs ?? timeline.endMs) / 1000;
  const file = `${RECORDING}caption-${scene.n}.txt`;
  writeFileSync(file, scene.caption);
  band.push(
    `drawtext=${font}:textfile='${filterPath(file)}':expansion=none:fontsize=34:fontcolor=${TEXT}` +
      `:x=(w-tw)/2:${baseline}:enable='gte(t,${from.toFixed(3)})*lt(t,${to.toFixed(3)})'`,
  );
});

// Playwright's VP8 keyframes (one every 5.12 s) are much softer than the frames around them, so each pane would flicker:
// drop them (but never the first frame) and let fps=30 repeat the frame before.
const withoutKeyframes = String.raw`select='eq(n\,0)+not(eq(pict_type\,PICT_TYPE_I))'`;
const graph = [
  `[0:v]${withoutKeyframes},fps=30,setpts=PTS-STARTPTS[left]`,
  `[1:v]${withoutKeyframes},fps=30,setpts=PTS-STARTPTS[right]`,
  `[left][right]hstack=inputs=2,trim=duration=${mainS.toFixed(3)},setpts=PTS-STARTPTS,` +
    `pad=${WIDTH}:${HEIGHT}:0:0:color=${BAND},${band.join(',')},` +
    `fade=t=in:d=${FADE_S}:color=${BAND},` +
    `fade=t=out:st=${(mainS - FADE_S).toFixed(3)}:d=${FADE_S}:color=${BAND},setsar=1,format=yuv420p[main]`,
  `[2:v]fade=t=out:st=${TITLE_S - FADE_S}:d=${FADE_S}:color=${BAND},setsar=1,format=yuv420p[title]`,
  `[3:v]fade=t=in:d=${FADE_S}:color=${BAND},setsar=1,format=yuv420p[end]`,
  '[title][main][end]concat=n=3:v=1:a=0[video]',
].join(';');

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`ffmpeg exited with ${String(result.status)}`);
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);
ffmpeg([
  ...['-ss', seconds(left.offsetMs), '-i', `${RECORDING}${left.video}`],
  ...['-ss', seconds(right.offsetMs), '-i', `${RECORDING}${right.video}`],
  ...['-loop', '1', '-framerate', '30', '-t', String(TITLE_S), '-i', `${RECORDING}title.png`],
  ...['-loop', '1', '-framerate', '30', '-t', String(END_S), '-i', `${RECORDING}end.png`],
  ...['-filter_complex', graph, '-map', '[video]', '-an'],
  ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30'],
  ...['-movflags', '+faststart', OUTPUT],
]);
const bytes = statSync(OUTPUT).size;
if (bytes > MAX_BYTES) throw new Error(`${OUTPUT} is ${bytes} bytes, over the 60 MB budget`);

// -- Still frames at scene midpoints ---------------------------------------------------------------------------------

const framesDir = `${DOCS}frames/`;
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });
for (const n of FRAME_SCENES) {
  const index = timeline.scenes.findIndex((scene) => scene.n === n);
  const scene = timeline.scenes[index];
  if (scene === undefined) continue;
  const end = timeline.scenes[index + 1]?.startMs ?? timeline.endMs;
  const at = TITLE_S + (scene.startMs + end) / 2000;
  const frame = `${framesDir}scene-${String(n).padStart(2, '0')}.png`;
  ffmpeg(['-ss', at.toFixed(3), '-i', OUTPUT, '-frames:v', '1', frame]);
}
console.log(`${OUTPUT}: ${(bytes / 1024 / 1024).toFixed(1)} MB, ${(TITLE_S + mainS + END_S).toFixed(1)} s`);
