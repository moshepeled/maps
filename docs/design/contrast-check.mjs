// Snapland - WCAG 2.2 + colour-blind check for docs/design/tokens.css v2 "Studio" (no dependencies).
// Usage: node docs/design/contrast-check.mjs   -> prints the tables used in UI.md section 2.6; exits 1 on any failure.
//
// Gates (all REQUIRED unless marked "info"):
//   Chrome     WCAG text (4.5:1) and UI (3:1) pairs in the dark theme (default) and the light "paper" theme.
//   Map chrome floating controls, attribution, map chips and the two-tone map focus ring, per MAP TONE
//              (dark tone = imagery in any theme and the tinted OSM of the dark theme; light tone = OSM in light).
//   Palette    the 12 collaborator colours: ink on colour >= 4.5, core vs its dark casing >= 3 on every tone,
//              casing vs OSM >= 3 on the light tone, CIEDE2000 >= 14 (normal) and >= 6 (Machado 2009
//              deuteranopia / protanopia, severity 1), reserved colours (me / danger / saved) >= 15 away,
//              "me" >= 6 under CVD, danger >= 3 under CVD (floor; the x pattern carries the invalid state).
//   Overlays   every required stroke (saved, me, invalid, ghost, handle ring, pulse / lock ring) per tone.
import fs from 'node:fs';

// ------------------------------------------------------------------ colour math
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const rgbToHex = (rgb) =>
  '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const lum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [la, lb] = [lum(a), lum(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};
// alpha-composite fg over an opaque bg (browsers blend in sRGB space)
const over = (fg, alpha, bg) => {
  const f = hexToRgb(fg), b = hexToRgb(bg);
  return rgbToHex(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
};
const rgbToLab = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const deltaE2000 = (h1, h2) => {
  const [L1, a1, b1] = rgbToLab(h1), [L2, a2, b2] = rgbToLab(h2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a, b) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0; else if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (hbp + 360) / 2 : (hbp - 360) / 2;
    else hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
};
// Machado et al. 2009, severity 1.0, applied in linear RGB
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (hex, type) => {
  const lin = hexToRgb(hex).map(toLin);
  return rgbToHex(CVD[type].map((row) => toGam(Math.min(1, Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])))));
};
const dE = (a, b, type) => (type ? deltaE2000(simulate(a, type), simulate(b, type)) : deltaE2000(a, b));

// ------------------------------------------------------------------ tokens.css parsing
const css = fs.readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const block = (startRe) => {
  const i = css.search(startRe);
  if (i < 0) throw new Error('block not found ' + startRe);
  const open = css.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (!depth) break; } }
  const vars = {};
  for (const m of css.slice(open + 1, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
};
const dark = block(/^:root \{/m);                                           // default theme + dark map tone
const light = { ...dark, ...block(/^:root\[data-theme="light"\] \{/m) };  // light chrome
const lightTone = { ...light, ...block(/^:root\[data-theme="light"\] \[data-base-layer="map"\],/m) };
const themes = [['dark', dark], ['light', light]];
const tones = [['dark tone (imagery; OSM in dark theme)', dark], ['light tone (OSM in light theme)', lightTone]];

const parseColor = (v) => {
  let m;
  if ((m = v.match(/^#([0-9a-f]{6})$/i))) return { hex: '#' + m[1].toLowerCase(), a: 1 };
  if ((m = v.match(/^rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)$/)))
    return { hex: '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join(''), a: +m[4] };
  if (v === 'transparent') return { hex: '#000000', a: 0 };
  throw new Error('cannot parse colour ' + v);
};
const resolve = (vars, name) => {
  const v = vars[name];
  if (v === undefined) throw new Error('missing token ' + name);
  const m = v.match(/^var\((--[\w-]+)\)$/);
  return m ? resolve(vars, m[1]) : v;
};
const raw = (vars, name) => parseColor(resolve(vars, name));
// opaque colour of a token; a translucent token is composited over `under` (a token name or a hex)
const col = (vars, name, under) => {
  const c = raw(vars, name);
  if (c.a >= 1) return c.hex;
  const base = under === undefined ? '#ffffff' : under.startsWith('#') ? under : col(vars, under);
  return over(c.hex, c.a, base);
};
const num = (vars, name) => parseFloat(resolve(vars, name));

// backgrounds: a grey sweep over every luminance (imagery, tinted OSM) and the OpenStreetMap Carto area fills
const GREYS = Array.from({ length: 1001 }, (_, i) => {
  const g = Math.round(255 * toGam(i / 1000));
  return '#' + g.toString(16).padStart(2, '0').repeat(3);
});
const OSM = {
  land: '#f2efe9', water: '#aad3df', forest: '#add19e', park: '#c8facc', grass: '#cdebb0', farmland: '#eef0d5',
  orchard: '#aedfa3', scrub: '#c8d7ab', heath: '#d6d99f', allotments: '#c9e1bf', cemetery: '#aacbaf', pitch: '#aae0cb',
  residential: '#e0dfdf', commercial: '#f2dad9', retail: '#ffd6d1', industrial: '#ebdbe8', building: '#d9d0c9',
  parking: '#eeeeee', sand: '#f5e9c6', beach: '#fff1ba', bare_rock: '#eee5dc', glacier: '#ddecec', road: '#ffffff',
  secondary_road: '#f7fabf', primary_road: '#fcd6a4',
};
const OSM_BG = Object.values(OSM);
const osmName = (hex) => Object.entries(OSM).find(([, v]) => v === hex)?.[0] ?? hex;
const worst = (bgs, f) => bgs.reduce((m, bg) => { const r = f(bg); return r < m.r ? { r, bg } : m; }, { r: Infinity, bg: '' });

// ------------------------------------------------------------------ 1. chrome pairs
// [label, fg, bg, kind, under]  (under = what a translucent bg sits on)
const PAIRS = [
  ['Body text on surface (rail, options bar, inspector)', '--color-text', '--color-surface', 'text'],
  ['Body text on frame (title bar, status bar)', '--color-text', '--color-bg', 'text'],
  ['Body text on raised (secondary button)', '--color-text', '--color-surface-raised', 'text'],
  ['Body text on elevated (toast, menu, dialog)', '--color-text', '--color-elevated', 'text'],
  ['Secondary text on surface', '--color-text-secondary', '--color-surface', 'text'],
  ['Secondary text on frame (status bar values)', '--color-text-secondary', '--color-bg', 'text'],
  ['Secondary text on hover row', '--color-text-secondary', '--color-surface-hover', 'text'],
  ['Secondary text on elevated', '--color-text-secondary', '--color-elevated', 'text'],
  ['Tertiary text on surface (labels, meta)', '--color-text-tertiary', '--color-surface', 'text'],
  ['Tertiary text on frame (status bar labels)', '--color-text-tertiary', '--color-bg', 'text'],
  ['Tertiary text on hover row', '--color-text-tertiary', '--color-surface-hover', 'text'],
  ['Tertiary text on inset well / message strip', '--color-text-tertiary', '--color-surface-inset', 'text'],
  ['Tertiary text on elevated (toast dismiss, menu help)', '--color-text-tertiary', '--color-elevated', 'text'],
  ['Link / accent text on surface', '--color-text-link', '--color-surface', 'text'],
  ['Accent text on elevated (toast action)', '--color-accent-text', '--color-elevated', 'text'],
  ['Accent text on accent-faint (Current, You, Preview)', '--color-accent-text', '--color-accent-faint', 'text', '--color-surface'],
  ['Accent text on accent-subtle (mode tag, pressed tool)', '--color-accent-text', '--color-accent-subtle', 'text', '--color-surface'],
  ['Accent text on accent-subtle-hover', '--color-accent-text', '--color-accent-subtle-hover', 'text', '--color-surface'],
  ['Primary button label', '--color-text-on-accent', '--color-accent', 'text'],
  ['Primary button label (hover)', '--color-text-on-accent', '--color-accent-hover', 'text'],
  ['Primary button label (active)', '--color-text-on-accent', '--color-accent-active', 'text'],
  ['Danger text on danger bg (Delete)', '--color-danger-text', '--color-danger-bg', 'text', '--color-surface'],
  ['Danger text on danger bg (hover)', '--color-danger-text', '--color-danger-bg-hover', 'text', '--color-surface'],
  ['Danger text on surface', '--color-danger-text', '--color-surface', 'text'],
  ['Danger text on elevated (error toast, dialog)', '--color-danger-text', '--color-elevated', 'text'],
  ['Danger button label (solid)', '--color-text-on-danger', '--color-danger', 'text'],
  ['Warning text on warning bg (strip, notice)', '--color-warning-text', '--color-warning-bg', 'text', '--color-surface'],
  ['Warning text on warning bg (pill, title bar)', '--color-warning-text', '--color-warning-bg', 'text', '--color-bg'],
  ['Success text on success bg (Live pill, title bar)', '--color-success-text', '--color-success-bg', 'text', '--color-bg'],
  ['Info text on info bg', '--color-info-text', '--color-info-bg', 'text', '--color-surface'],
  ['Neutral badge (count, version tag)', '--color-neutral-badge-text', '--color-neutral-badge-bg', 'text'],
  ['kbd label', '--color-kbd-text', '--color-kbd-bg', 'text'],
  ['Selected segment label', '--color-on-segment-selected', '--color-segment-selected', 'text'],
  ['Input boundary on input fill', '--color-border-strong', '--color-input-bg', 'ui'],
  ['Input boundary on surface', '--color-border-strong', '--color-surface', 'ui'],
  ['Icons on surface', '--color-icon', '--color-surface', 'ui'],
  ['Icons on frame', '--color-icon', '--color-bg', 'ui'],
  ['Focus ring on surface', '--color-focus-ring', '--color-surface', 'ui'],
  ['Focus ring on frame', '--color-focus-ring', '--color-bg', 'ui'],
  ['Focus ring on raised', '--color-focus-ring', '--color-surface-raised', 'ui'],
  ['Focus ring on elevated (toast, menu)', '--color-focus-ring', '--color-elevated', 'ui'],
  ['Focus ring on accent-subtle', '--color-focus-ring', '--color-accent-subtle', 'ui', '--color-surface'],
  ['Accent indicator on surface (rail bar, tab bar)', '--color-accent', '--color-surface', 'ui'],
  ['Danger icon on surface', '--color-danger-icon', '--color-surface', 'ui'],
  ['Warning icon on warning bg', '--color-warning-icon', '--color-warning-bg', 'ui', '--color-surface'],
  ['Info icon on info bg', '--color-info-icon', '--color-info-bg', 'ui', '--color-surface'],
  ['Live dot on success bg (title bar)', '--color-live', '--color-success-bg', 'ui', '--color-bg'],
  ['Switch track (off) on elevated menu', '--color-switch-track-off', '--color-elevated', 'ui'],
  ['Switch thumb on its track (off)', '--color-switch-thumb-off', '--color-switch-track-off', 'ui'],
  ['Switch track (on) on elevated menu', '--color-switch-track-on', '--color-elevated', 'ui'],
  ['Switch thumb on its track (on)', '--color-switch-thumb-on', '--color-switch-track-on', 'ui'],
  ['Viewing badge glyph', '--color-badge-viewing-fg', '--color-badge-viewing-bg', 'ui'],
  ['Me badge glyph on accent', '--color-text-on-accent', '--color-accent', 'ui'],
];
const chrome = PAIRS.map(([label, fg, bg, kind, under]) => {
  const need = kind === 'text' ? 4.5 : 3;
  const res = themes.map(([, v]) => {
    const b = col(v, bg, under);
    const f = col(v, fg, b);
    return { f, b, r: contrast(f, b) };
  });
  return { label, need, res };
});
const disabled = themes.map(([, v]) => contrast(col(v, '--color-text-disabled'), col(v, '--color-surface')));

// floating map controls: --color-surface-float over the worst map pixel (black or white)
const floatRows = themes.map(([theme, v]) => {
  const bgs = ['#000000', '#ffffff'].map((u) => col(v, '--color-surface-float', u));
  const w = (fg) => Math.min(...bgs.map((b) => contrast(col(v, fg), b)));
  return {
    theme,
    label: w('--color-text-secondary'),
    selectedRing: w('--color-segment-selected-border'),
    focus: w('--color-focus-ring'),
  };
});

// ------------------------------------------------------------------ 2. map chrome per tone
const toneRows = tones.map(([tone, v]) => {
  const mapBgs = v === lightTone ? OSM_BG : GREYS;
  const attrBg = ['#000000', '#ffffff'].map((u) => col(v, '--map-attr-bg', u));
  const chipBg = ['#000000', '#ffffff'].map((u) => col(v, '--ov-chip-bg', u));
  const w = (fg, bgs) => Math.min(...bgs.map((b) => contrast(col(v, fg), b)));
  const ring = col(v, '--map-focus-ring'), halo = col(v, '--map-focus-halo');
  return {
    tone,
    attrText: w('--map-attr-text', attrBg),
    attrLink: w('--map-attr-link', attrBg),
    attrRing: w('--map-focus-ring', attrBg),
    chipText: w('--ov-chip-text', chipBg),
    chipSecondary: w('--ov-chip-text-secondary', chipBg),
    chipSelected: w('--ov-chip-selected-text', chipBg),
    ringVsHalo: contrast(ring, halo),
    // two-tone map focus: over any pixel of that tone, the ring or its halo reaches 3:1
    ringOnMap: worst(mapBgs, (bg) => Math.max(contrast(ring, bg), contrast(halo, bg))).r,
    // invalid marker glyph on its red disc, and the red x / ring on the tick disc
    invalidGlyph: contrast(col(v, '--ov-invalid-glyph'), col(v, '--ov-invalid')),
    invalidTick: contrast(col(v, '--ov-invalid'), col(v, '--ov-invalid-tick-bg')),
  };
});

// ------------------------------------------------------------------ 3. overlay lines
// A line = core over a casing (casing colour at an opacity, composited over the background), optionally with an
// outer outline (the dark-tone invalid edge).
// coreVsCasing: the core always stands out from its own casing (required).
// lineVsBg: the core, the casing or the outline stands out from the background (required for reserved overlays).
const line = (core, casing, alpha, bgs, outline) => ({
  coreVsCasing: worst(bgs, (bg) => contrast(core, over(casing, alpha, bg))),
  lineVsBg: worst(bgs, (bg) => Math.max(contrast(core, bg), contrast(over(casing, alpha, bg), bg),
    outline && outline.a > 0 ? contrast(over(outline.hex, outline.a, bg), bg) : 0)),
  coreVsBg: worst(bgs, (bg) => contrast(core, bg)),
  casingVsBg: worst(bgs, (bg) => contrast(over(casing, alpha, bg), bg)),
});
const ovTokens = [
  ['Saved area', '--ov-area-stroke'],
  ['Selected / my draft / my edit (me)', '--ov-own-stroke'],
  ['Handle ring (me)', '--ov-handle-stroke'],
  ['Invalid edge', '--ov-invalid'],
  ['History ghost (saved neutral, dotted)', '--ov-ghost-stroke'],
];
const ovRows = [];
for (const [tone, v] of tones) {
  const isLight = v === lightTone;
  const bgs = isLight ? OSM_BG : GREYS;
  const casing = col(v, '--ov-casing'), alpha = num(v, '--ov-casing-opacity');
  const invalidOutline = { hex: col(v, '--ov-invalid-outline'), a: num(v, '--ov-invalid-outline-opacity') };
  for (const [label, t] of ovTokens) {
    const core = col(v, t);
    const l = line(core, casing, alpha, bgs, t === '--ov-invalid' ? invalidOutline : undefined);
    // light tone: a white casing gives no edge on light OSM fills, so the dark core itself must reach 3:1
    ovRows.push({ tone, label, core, isLight, ...l, gate: isLight ? l.coreVsBg.r : l.lineVsBg.r });
  }
}

// ------------------------------------------------------------------ 4. collaborator palette
const NAMES = ['lime', 'orchid', 'tangerine', 'copper', 'mint', 'violet', 'periwinkle', 'pink', 'gold', 'cobalt', 'plum', 'grass'];
const collab = NAMES.map((_, i) => resolve(dark, `--collab-${i + 1}`));
const ink = col(dark, '--collab-ink');
const remote = tones.map(([tone, v]) => ({
  tone, v, isLight: v === lightTone,
  casing: col(v, '--ov-remote-casing'), alpha: num(v, '--ov-remote-casing-opacity'),
}));
const collabRows = collab.map((hex, i) => {
  const [dt, lt] = remote;
  const d = line(hex, dt.casing, dt.alpha, GREYS);
  const l = line(hex, lt.casing, lt.alpha, OSM_BG);
  return {
    n: i + 1, name: NAMES[i], hex,
    ink: contrast(ink, hex),
    darkCoreVsCasing: d.coreVsCasing.r, darkLineVsBg: d.lineVsBg.r, darkCoreVsBgAtWorst: d.lineVsBg,
    lightCoreVsCasing: l.coreVsCasing.r, lightCasingVsOsm: l.casingVsBg,
    onDarkSurface: contrast(hex, col(dark, '--color-surface')),
    onLightSurface: contrast(hex, col(light, '--color-surface')),
  };
});
const CVD_MIN = 6;          // any two collaborator colours under deuteranopia and protanopia
const NORMAL_MIN = 14;      // any two collaborator colours, normal vision
const RESERVED_MIN = 15;    // collaborator colour vs me / danger / saved, normal vision
const ACCENT_CVD_MIN = 6;   // me vs any collaborator colour under deuteranopia / protanopia
const DANGER_CVD_FLOOR = 3; // informational floor; the invalid state is carried by x ticks + marker + text
const pairRows = [];
for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
  const [a, b] = [collab[i], collab[j]];
  pairRows.push({ pair: `${NAMES[i]}/${NAMES[j]}`, normal: dE(a, b), deutan: dE(a, b, 'deutan'), protan: dE(a, b, 'protan'), tritan: dE(a, b, 'tritan') });
}
const minOf = (k) => pairRows.reduce((m, r) => (r[k] < m[k] ? r : m));
const minN = minOf('normal'), minD = minOf('deutan'), minP = minOf('protan'), minT = minOf('tritan');
const reserved = [
  ['me, dark tone', 'accent', col(dark, '--ov-own-stroke')],
  ['me, light tone', 'accent', col(lightTone, '--ov-own-stroke')],
  ['danger, dark tone', 'danger', col(dark, '--ov-invalid')],
  ['danger, light tone', 'danger', col(lightTone, '--ov-invalid')],
  ['saved / ghost, dark tone', 'saved', col(dark, '--ov-area-stroke')],
  ['saved / ghost, light tone', 'saved', col(lightTone, '--ov-area-stroke')],
];
const resRows = reserved.map(([label, kind, hex]) => {
  const best = (type) => collab.reduce((m, c, i) => { const d = dE(c, hex, type); return d < m.d ? { d, w: NAMES[i] } : m; }, { d: Infinity, w: '' });
  return { label, kind, hex, n: best(), d: best('deutan'), p: best('protan') };
});

// ------------------------------------------------------------------ report (Markdown, UI.md section 2.6)
const f2 = (x) => x.toFixed(2);
const f1 = (x) => x.toFixed(1);
const mark = (r, need) => `**${f2(r)}**${r >= need ? '' : ' x'}`;
const md = [];
md.push('### Chrome: text and UI pairs (dark default / light)\n');
md.push('| # | Pair | Dark fg / bg | Dark | Light fg / bg | Light | Needs |');
md.push('|---|---|---|---|---|---|---|');
chrome.forEach((c, i) => {
  const [d, l] = c.res;
  md.push(`| ${i + 1} | ${c.label} | \`${d.f}\` / \`${d.b}\` | ${mark(d.r, c.need)} | \`${l.f}\` / \`${l.b}\` | ${mark(l.r, c.need)} | ${c.need}:1 |`);
});
md.push(`\nDisabled text on surface (exempt, WCAG 1.4.3): dark ${f2(disabled[0])}, light ${f2(disabled[1])}.\n`);
md.push('Floating map controls (`--color-surface-float` over a black or white map pixel, worst of the two):\n');
md.push('| Theme | Segment / button label | Selected-segment ring | Focus ring |');
md.push('|---|---|---|---|');
for (const r of floatRows) md.push(`| ${r.theme} | ${mark(r.label, 4.5)} | ${mark(r.selectedRing, 3)} | ${mark(r.focus, 3)} |`);
md.push('\n### Map chrome per map tone (over a black or white map pixel, worst of the two)\n');
md.push('| Map tone | Attribution text | Attribution link | Inset link focus ring | Chip text | Chip value | Selected-chip value | Map focus ring vs halo | Ring or halo vs any pixel | Invalid marker x | Invalid tick x |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of toneRows)
  md.push(`| ${r.tone} | ${mark(r.attrText, 4.5)} | ${mark(r.attrLink, 4.5)} | ${mark(r.attrRing, 3)} | ${mark(r.chipText, 4.5)} | ${mark(r.chipSecondary, 4.5)} | ${mark(r.chipSelected, 4.5)} | ${mark(r.ringVsHalo, 3)} | ${mark(r.ringOnMap, 3)} | ${mark(r.invalidGlyph, 3)} | ${mark(r.invalidTick, 3)} |`);
md.push('\n### Collaborator palette\n');
md.push('| Token | Name | Hex | Ink on it | Dark tone: core vs casing | Dark tone: line vs any pixel (info) | Light tone: core vs casing | Light tone: casing vs OSM (worst) | On dark surface (info) | On light surface (info) |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of collabRows)
  md.push(`| \`--collab-${r.n}\` | ${r.name} | \`${r.hex}\` | ${mark(r.ink, 4.5)} | ${mark(r.darkCoreVsCasing, 3)} | ${f2(r.darkLineVsBg)} | ${mark(r.lightCoreVsCasing, 3)} | ${mark(r.lightCasingVsOsm.r, 3)} (${osmName(r.lightCasingVsOsm.bg)}) | ${f2(r.onDarkSurface)} | ${f2(r.onLightSurface)} |`);
md.push('\n### Colour-blind separation (CIEDE2000, Machado 2009 severity 1)\n');
md.push('| Vision | Closest pair | ΔE00 | Gate | Pairs below 10 |');
md.push('|---|---|---|---|---|');
md.push(`| Normal | ${minN.pair} | **${f1(minN.normal)}** | >= ${NORMAL_MIN} | ${pairRows.filter((r) => r.normal < 10).length} of 66 |`);
md.push(`| Deuteranopia | ${minD.pair} | **${f1(minD.deutan)}** | >= ${CVD_MIN} | ${pairRows.filter((r) => r.deutan < 10).length} of 66 |`);
md.push(`| Protanopia | ${minP.pair} | **${f1(minP.protan)}** | >= ${CVD_MIN} | ${pairRows.filter((r) => r.protan < 10).length} of 66 |`);
md.push(`| Tritanopia (info) | ${minT.pair} | ${f1(minT.tritan)} | - | ${pairRows.filter((r) => r.tritan < 10).length} of 66 |`);
md.push('\nClosest pairs under colour-blindness (all 66 pairs are checked):\n');
md.push('| Pair | Normal | Deuteranopia | Protanopia |');
md.push('|---|---|---|---|');
for (const r of [...pairRows].sort((a, b) => Math.min(a.deutan, a.protan) - Math.min(b.deutan, b.protan)).slice(0, 8))
  md.push(`| ${r.pair} | ${f1(r.normal)} | ${f1(r.deutan)} | ${f1(r.protan)} |`);
md.push('\nReserved map colours vs the palette (closest collaborator colour):\n');
md.push('| Reserved | Hex | Normal | Deuteranopia | Protanopia | Gate |');
md.push('|---|---|---|---|---|---|');
for (const r of resRows) {
  const gate = `normal >= ${RESERVED_MIN}` + (r.kind === 'accent' ? `; CVD >= ${ACCENT_CVD_MIN}` : r.kind === 'danger' ? `; CVD >= ${DANGER_CVD_FLOOR} (x pattern carries it)` : '');
  md.push(`| ${r.label} | \`${r.hex}\` | ${f1(r.n.d)} (${r.n.w}) | ${f1(r.d.d)} (${r.d.w}) | ${f1(r.p.d)} (${r.p.w}) | ${gate} |`);
}
md.push('\n### Map overlay strokes (all required)\n');
md.push('Dark tone: core over a `#05070a` casing (the invalid edge adds a white outline), swept over every background luminance. Light tone: dark core over a white casing, against the 25 OpenStreetMap Carto area and road fills.\n');
md.push('| Map tone | Overlay | Core | Core vs its casing (worst) | Line vs background (worst) | Gate value |');
md.push('|---|---|---|---|---|---|');
for (const r of ovRows) {
  const bgNote = r.isLight ? ` (${osmName(r.coreVsBg.bg)})` : '';
  const lineVal = r.isLight ? `core ${f2(r.coreVsBg.r)}${bgNote}` : f2(r.lineVsBg.r);
  md.push(`| ${r.tone.split(' (')[0]} | ${r.label} | \`${r.core}\` | ${f2(r.coreVsCasing.r)} | ${lineVal} | ${mark(r.gate, 3)} |`);
}
const pulseDark = Math.min(...collabRows.map((r) => r.darkCoreVsCasing));
const pulseLight = Math.min(...collabRows.map((r) => Math.min(r.lightCoreVsCasing, r.lightCasingVsOsm.r)));
md.push(`\nRemote-change pulse and lock ring (the actor's / editor's --c on the dark casing): worst palette colour ${f2(pulseDark)} (dark tone, core vs casing), ${f2(pulseLight)} (light tone, core vs casing and casing vs OSM).`);
console.log(md.join('\n'));

// ------------------------------------------------------------------ gates
const problems = [];
for (const c of chrome) c.res.forEach((r, i) => { if (r.r < c.need) problems.push(`${themes[i][0]}: ${c.label} = ${f2(r.r)} < ${c.need}`); });
for (const r of floatRows) {
  if (r.label < 4.5) problems.push(`${r.theme}: float control label ${f2(r.label)} < 4.5`);
  if (r.selectedRing < 3) problems.push(`${r.theme}: selected-segment ring ${f2(r.selectedRing)} < 3`);
  if (r.focus < 3) problems.push(`${r.theme}: focus ring on float ${f2(r.focus)} < 3`);
}
for (const r of toneRows) {
  for (const [k, need] of [['attrText', 4.5], ['attrLink', 4.5], ['attrRing', 3], ['chipText', 4.5], ['chipSecondary', 4.5], ['chipSelected', 4.5], ['ringVsHalo', 3], ['ringOnMap', 3], ['invalidGlyph', 3], ['invalidTick', 3]])
    if (r[k] < need) problems.push(`${r.tone}: ${k} ${f2(r[k])} < ${need}`);
}
for (const r of collabRows) {
  if (r.ink < 4.5) problems.push(`${r.name}: ink ${f2(r.ink)} < 4.5`);
  if (r.darkCoreVsCasing < 3) problems.push(`${r.name}: dark tone core vs casing ${f2(r.darkCoreVsCasing)} < 3`);
  if (r.lightCoreVsCasing < 3) problems.push(`${r.name}: light tone core vs casing ${f2(r.lightCoreVsCasing)} < 3`);
  if (r.lightCasingVsOsm.r < 3) problems.push(`${r.name}: light tone casing vs OSM ${f2(r.lightCasingVsOsm.r)} < 3`);
}
if (minN.normal < NORMAL_MIN) problems.push(`palette normal-vision min ${f1(minN.normal)} (${minN.pair}) < ${NORMAL_MIN}`);
if (minD.deutan < CVD_MIN) problems.push(`palette deuteranopia min ${f1(minD.deutan)} (${minD.pair}) < ${CVD_MIN}`);
if (minP.protan < CVD_MIN) problems.push(`palette protanopia min ${f1(minP.protan)} (${minP.pair}) < ${CVD_MIN}`);
for (const r of resRows) {
  if (r.n.d < RESERVED_MIN) problems.push(`${r.label} vs ${r.n.w}: ${f1(r.n.d)} < ${RESERVED_MIN}`);
  const cvd = Math.min(r.d.d, r.p.d);
  if (r.kind === 'accent' && cvd < ACCENT_CVD_MIN) problems.push(`${r.label} vs palette under CVD ${f1(cvd)} < ${ACCENT_CVD_MIN}`);
  if (r.kind === 'danger' && cvd < DANGER_CVD_FLOOR) problems.push(`${r.label} vs palette under CVD ${f1(cvd)} < ${DANGER_CVD_FLOOR}`);
}
for (const r of ovRows) {
  if (r.coreVsCasing.r < 3) problems.push(`${r.tone}: ${r.label} core vs casing ${f2(r.coreVsCasing.r)} < 3`);
  if (r.gate < 3) problems.push(`${r.tone}: ${r.label} line vs background ${f2(r.gate)} < 3`);
}
console.error(problems.length ? 'FAIL:\n  ' + problems.join('\n  ') : 'PASS: every gate');
if (problems.length) process.exit(1);
