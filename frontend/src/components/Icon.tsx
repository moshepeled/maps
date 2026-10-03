/**
 * The icon set (UI.md section 12): Lucide 1.48 outlines (ISC licence) inlined as React elements - no icon font, no runtime
 * dependency. Icons are decorative (`aria-hidden`); every control carries a text label or an accessible name.
 */
import type { ReactElement } from 'react';

const ICONS = {
  'bell-off': [
    <path key="a" d="M10.268 21a2 2 0 0 0 3.464 0" />,
    <path key="b" d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742" />,
    <path key="c" d="m2 2 20 20" />,
    <path key="d" d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />,
  ],
  check: [<path key="a" d="M20 6 9 17l-5-5" />],
  'chevron-down': [<path key="a" d="m6 9 6 6 6-6" />],
  'chevron-up': [<path key="a" d="m18 15-6-6-6 6" />],
  'circle-alert': [
    <circle key="a" cx="12" cy="12" r="10" />,
    <line key="b" x1="12" x2="12" y1="8" y2="12" />,
    <line key="c" x1="12" x2="12.01" y1="16" y2="16" />,
  ],
  'circle-check': [<circle key="a" cx="12" cy="12" r="10" />, <path key="b" d="m16 9-5.5 5.5L8 12" />],
  'circle-help': [
    <circle key="a" cx="12" cy="12" r="10" />,
    <path key="b" d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />,
    <path key="c" d="M12 17h.01" />,
  ],
  clock: [<circle key="a" cx="12" cy="12" r="10" />, <path key="b" d="M12 6v6l4 2" />],
  'cloud-off': [
    <path key="a" d="M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057" />,
    <path key="b" d="M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78" />,
    <path key="c" d="m2 2 20 20" />,
  ],
  eye: [
    <path
      key="a"
      d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
    />,
    <circle key="b" cx="12" cy="12" r="3" />,
  ],
  'git-merge': [
    <circle key="a" cx="18" cy="18" r="3" />,
    <circle key="b" cx="6" cy="6" r="3" />,
    <path key="c" d="M6 21V9a9 9 0 0 0 9 9" />,
  ],
  history: [
    <path key="a" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />,
    <path key="b" d="M3 3v5h5" />,
    <path key="c" d="M12 7v5l4 2" />,
  ],
  info: [
    <circle key="a" cx="12" cy="12" r="10" />,
    <path key="b" d="M12 16v-4" />,
    <path key="c" d="M12 8h.01" />,
  ],
  keyboard: [
    <path key="a" d="M10 8h.01" />,
    <path key="b" d="M12 12h.01" />,
    <path key="c" d="M14 8h.01" />,
    <path key="d" d="M16 12h.01" />,
    <path key="e" d="M18 8h.01" />,
    <path key="f" d="M6 8h.01" />,
    <path key="g" d="M7 16h10" />,
    <path key="h" d="M8 12h.01" />,
    <rect key="i" width="20" height="16" x="2" y="4" rx="2" />,
  ],
  locate: [
    <line key="a" x1="2" x2="5" y1="12" y2="12" />,
    <line key="b" x1="19" x2="22" y1="12" y2="12" />,
    <line key="c" x1="12" x2="12" y1="2" y2="5" />,
    <line key="d" x1="12" x2="12" y1="19" y2="22" />,
    <circle key="e" cx="12" cy="12" r="7" />,
  ],
  list: [
    <path key="a" d="M3 5h.01" />,
    <path key="b" d="M3 12h.01" />,
    <path key="c" d="M3 19h.01" />,
    <path key="d" d="M8 5h13" />,
    <path key="e" d="M8 12h13" />,
    <path key="f" d="M8 19h13" />,
  ],
  lock: [
    <rect key="a" width="18" height="11" x="3" y="11" rx="2" ry="2" />,
    <path key="b" d="M7 11V7a5 5 0 0 1 10 0v4" />,
  ],
  'log-out': [
    <path key="a" d="m16 17 5-5-5-5" />,
    <path key="b" d="M21 12H9" />,
    <path key="c" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />,
  ],
  map: [
    <path
      key="a"
      d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"
    />,
    <path key="b" d="M15 5.764v15" />,
    <path key="c" d="M9 3.236v15" />,
  ],
  menu: [<path key="a" d="M4 5h16" />, <path key="b" d="M4 12h16" />, <path key="c" d="M4 19h16" />],
  moon: [<path key="a" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />],
  move: [
    <path key="a" d="M12 2v20" />,
    <path key="b" d="m15 19-3 3-3-3" />,
    <path key="c" d="m19 9 3 3-3 3" />,
    <path key="d" d="M2 12h20" />,
    <path key="e" d="m5 9-3 3 3 3" />,
    <path key="f" d="m9 5 3-3 3 3" />,
  ],
  'pen-tool': [
    <path
      key="a"
      d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"
    />,
    <path
      key="b"
      d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18"
    />,
    <path key="c" d="m2.3 2.3 7.286 7.286" />,
    <circle key="d" cx="11" cy="11" r="2" />,
  ],
  pencil: [
    <path
      key="a"
      d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
    />,
    <path key="b" d="m15 5 4 4" />,
  ],
  'pencil-line': [
    <path key="a" d="M13 21h8" />,
    <path key="b" d="m15 5 4 4" />,
    <path
      key="c"
      d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
    />,
  ],
  plus: [<path key="a" d="M5 12h14" />, <path key="b" d="M12 5v14" />],
  minus: [<path key="a" d="M5 12h14" />],
  /** Custom glyph (UI.md section 12): the Draw area tool - a polygon with its five vertices. */
  'snap-polygon': [
    <path key="a" d="M5 8.5 12 4l7 5.5-2.5 9h-9z" />,
    ...[
      [5, 8.5],
      [12, 4],
      [19, 9.5],
      [16.5, 18.5],
      [7.5, 18.5],
    ].map(([cx, cy]) => (
      <circle key={`v${cx}-${cy}`} cx={cx} cy={cy} r="1.6" fill="currentColor" stroke="none" />
    )),
  ],
  /** The Draw area *action* (rail, bottom bar): the polygon with a small + inside it, "add a new area". */
  'snap-polygon-plus': [
    <path key="a" d="M5 8.5 12 4l7 5.5-2.5 9h-9z" />,
    <path key="b" d="M9.5 12h5" />,
    <path key="c" d="M12 9.5v5" />,
    ...[
      [5, 8.5],
      [12, 4],
      [19, 9.5],
      [16.5, 18.5],
      [7.5, 18.5],
    ].map(([cx, cy]) => (
      <circle key={`v${cx}-${cy}`} cx={cx} cy={cy} r="1.6" fill="currentColor" stroke="none" />
    )),
  ],
  'square-mouse-pointer': [
    <path
      key="a"
      d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"
    />,
    <path key="b" d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />,
  ],
  sun: [
    <circle key="a" cx="12" cy="12" r="4" />,
    <path key="b" d="M12 2v2" />,
    <path key="c" d="M12 20v2" />,
    <path key="d" d="m4.93 4.93 1.41 1.41" />,
    <path key="e" d="m17.66 17.66 1.41 1.41" />,
    <path key="f" d="M2 12h2" />,
    <path key="g" d="M20 12h2" />,
    <path key="h" d="m6.34 17.66-1.41 1.41" />,
    <path key="i" d="m19.07 4.93-1.41 1.41" />,
  ],
  'refresh-cw': [
    <path key="a" d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />,
    <path key="b" d="M21 3v5h-5" />,
    <path key="c" d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />,
    <path key="d" d="M8 16H3v5" />,
  ],
  'rotate-ccw': [
    <path key="a" d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />,
    <path key="b" d="M3 3v5h5" />,
  ],
  satellite: [
    <path
      key="a"
      d="m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5"
    />,
    <path key="b" d="M16.5 7.5 19 5" />,
    <path
      key="c"
      d="m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5"
    />,
    <path key="d" d="M9 21a6 6 0 0 0-6-6" />,
    <path
      key="e"
      d="M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z"
    />,
  ],
  scan: [
    <path key="a" d="M3 7V5a2 2 0 0 1 2-2h2" />,
    <path key="b" d="M17 3h2a2 2 0 0 1 2 2v2" />,
    <path key="c" d="M21 17v2a2 2 0 0 1-2 2h-2" />,
    <path key="d" d="M7 21H5a2 2 0 0 1-2-2v-2" />,
  ],
  'trash-2': [
    <path key="a" d="M10 11v6" />,
    <path key="b" d="M14 11v6" />,
    <path key="c" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
    <path key="d" d="M3 6h18" />,
    <path key="e" d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />,
  ],
  'triangle-alert': [
    <path key="a" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />,
    <path key="b" d="M12 9v4" />,
    <path key="c" d="M12 17h.01" />,
  ],
  'vector-square': [
    <path key="a" d="M19.5 7a24 24 0 0 1 0 10" />,
    <path key="b" d="M4.5 7a24 24 0 0 0 0 10" />,
    <path key="c" d="M7 19.5a24 24 0 0 0 10 0" />,
    <path key="d" d="M7 4.5a24 24 0 0 1 10 0" />,
    <rect key="e" x="17" y="17" width="5" height="5" rx="1" />,
    <rect key="f" x="17" y="2" width="5" height="5" rx="1" />,
    <rect key="g" x="2" y="17" width="5" height="5" rx="1" />,
    <rect key="h" x="2" y="2" width="5" height="5" rx="1" />,
  ],
  'undo-2': [
    <path key="a" d="M9 14 4 9l5-5" />,
    <path key="b" d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />,
  ],
  user: [
    <path key="a" d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />,
    <circle key="b" cx="12" cy="7" r="4" />,
  ],
  users: [
    <path key="a" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />,
    <path key="b" d="M16 3.128a4 4 0 0 1 0 7.744" />,
    <path key="c" d="M22 21v-2a4 4 0 0 0-3-3.87" />,
    <circle key="d" cx="9" cy="7" r="4" />,
  ],
  'wifi-off': [
    <path key="a" d="M12 20h.01" />,
    <path key="b" d="M8.5 16.429a5 5 0 0 1 7 0" />,
    <path key="c" d="M5 12.859a10 10 0 0 1 5.17-2.69" />,
    <path key="d" d="M19 12.859a10 10 0 0 0-2.007-1.523" />,
    <path key="e" d="M2 8.82a15 15 0 0 1 4.177-2.643" />,
    <path key="f" d="M22 8.82a15 15 0 0 0-11.288-3.764" />,
    <path key="g" d="m2 2 20 20" />,
  ],
  x: [<path key="a" d="M18 6 6 18" />, <path key="b" d="m6 6 12 12" />],
  'zoom-in': [
    <circle key="a" cx="11" cy="11" r="8" />,
    <line key="b" x1="21" x2="16.65" y1="21" y2="16.65" />,
    <line key="c" x1="11" x2="11" y1="8" y2="14" />,
    <line key="d" x1="8" x2="14" y1="11" y2="11" />,
  ],
} satisfies Record<string, ReactElement[]>;

export type IconName = keyof typeof ICONS;

/** Sizes (UI.md section 12): 2xs 10 badges, xs 12 chips and strips, sm 14 small controls, md 16 buttons, lg 18 rail and bars. */
export type IconSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg';

export function Icon({
  name,
  size = 'md',
  className,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
}) {
  const classes = ['ic', size === 'md' ? '' : `ic-${size}`, className ?? '']
    .filter((part) => part !== '')
    .join(' ');
  return (
    <svg className={classes} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

/**
 * The Snapland mark (UI.md section 10.2): a dark rounded square holding the accent quadrilateral with its four vertex squares.
 * Colours are theme tokens (`--brand-mark-*`), so the mark follows the light / dark theme.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  const vertices: [number, number, string][] = [
    [5, 6.7, 'var(--brand-mark-vertex)'],
    [14.3, 4.4, 'var(--brand-mark-vertex)'],
    [16.5, 13.9, 'var(--brand-mark-vertex)'],
    [7.1, 16.6, 'var(--brand-mark-line)'],
  ];
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="0.75"
        y="0.75"
        width="22.5"
        height="22.5"
        rx="6"
        fill="var(--brand-mark-bg)"
        stroke="var(--brand-mark-edge)"
        strokeWidth="1"
      />
      <path
        d="M6.5 8.2 15.8 5.9 18 15.4 8.6 18.1Z"
        fill="var(--brand-mark-fill)"
        stroke="var(--brand-mark-line)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {vertices.map(([x, y, fill]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" rx="0.6" fill={fill} />
      ))}
    </svg>
  );
}
