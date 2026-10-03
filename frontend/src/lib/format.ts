/**
 * Number, area, time and countdown formatting (UX C-06.4, section 9.13). Pure functions with a fixed `en-US` locale so tests
 * are deterministic (UX-AC-13). Values are rounded half away from zero, the same rule as coordinate quantisation.
 */

const LOCALE = 'en-US';
const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(decimals: number): Intl.NumberFormat {
  let format = numberFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      roundingMode: 'halfExpand',
    });
    numberFormats.set(decimals, format);
  }
  return format;
}

/** Half-away-from-zero rounding to `decimals` places. */
export function roundHalfAway(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Grouped `en-US` number with exactly `decimals` fraction digits. */
export function formatNumber(value: number, decimals = 0): string {
  return numberFormat(decimals).format(roundHalfAway(value, decimals));
}

const M2_PER_KM2 = 1_000_000;
const HA_PER_KM2 = 100;
const MIN_DISPLAY_KM2 = 0.000001;

interface AreaParts {
  value: string;
  unit: 'm²' | 'km²';
  /** True for the `< 1 m²` literal. */
  belowOneSquareMetre: boolean;
}

function areaParts(km2: number): AreaParts {
  if (km2 < MIN_DISPLAY_KM2) return { value: '1', unit: 'm²', belowOneSquareMetre: true };
  if (km2 < 0.01) return { value: formatNumber(km2 * M2_PER_KM2, 0), unit: 'm²', belowOneSquareMetre: false };
  if (km2 < 1) return { value: formatNumber(km2, 3), unit: 'km²', belowOneSquareMetre: false };
  if (km2 < 100) return { value: formatNumber(km2, 2), unit: 'km²', belowOneSquareMetre: false };
  if (km2 < 10_000) return { value: formatNumber(km2, 1), unit: 'km²', belowOneSquareMetre: false };
  return { value: formatNumber(km2, 0), unit: 'km²', belowOneSquareMetre: false };
}

/** `formatArea(km2)` exactly as UX C-06.4 (bands chosen on the raw value). */
export function formatArea(km2: number): string {
  const parts = areaParts(km2);
  return parts.belowOneSquareMetre ? '< 1 m²' : `${parts.value} ${parts.unit}`;
}

/**
 * `formatArea` split for instrument-style readouts (UI.md section 3: the number in mono, the unit beside it in sans):
 * `{ value: '1.27', unit: 'km²' }`. Joined with a space it equals `formatArea`.
 */
export function formatAreaParts(km2: number): { value: string; unit: 'm²' | 'km²' } {
  const parts = areaParts(km2);
  return { value: parts.belowOneSquareMetre ? '< 1' : parts.value, unit: parts.unit };
}

/** Spoken form for `aria-label`s: "2.31 square kilometers" / "9,980 square meters". */
export function formatAreaSpoken(km2: number): string {
  const parts = areaParts(km2);
  if (parts.belowOneSquareMetre) return 'less than 1 square meter';
  return `${parts.value} ${parts.unit === 'km²' ? 'square kilometers' : 'square meters'}`;
}

/** Hectares (1 km² = 100 ha): `< 10 ha` -> 2 decimals, `< 1,000 ha` -> 1 decimal, else integer. */
export function formatHectares(km2: number): string {
  const hectares = km2 * HA_PER_KM2;
  if (hectares < 10) return `${formatNumber(hectares, 2)} ha`;
  if (hectares < 1000) return `${formatNumber(hectares, 1)} ha`;
  return `${formatNumber(hectares, 0)} ha`;
}

/** Exact square metres for the readout tooltip ("2,310,400 m²"). */
export function formatSquareMetres(km2: number): string {
  return `${formatNumber(km2 * M2_PER_KM2, 0)} m²`;
}

/** `formatPerimeter(km)`: below 1 km in metres ("850 m"), else km with 2 decimals ("4.48 km"). */
export function formatPerimeter(km: number): string {
  if (km < 1) return `${formatNumber(km * 1000, 0)} m`;
  return `${formatNumber(km, 2)} km`;
}

/**
 * `formatCountdown(ms)` (UX section 9.13): whole seconds rounded up; <= 90 s -> "{s} s", above -> whole minutes rounded up.
 */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds <= 90) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function monthName(date: Date): string {
  return MONTHS[date.getMonth()] ?? '';
}

function hoursMinutes(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "27 Sep 2026, 17:21:04" in the user's time zone, 24-hour clock (tooltips and screen readers). */
export function formatAbsoluteTime(date: Date): string {
  return `${date.getDate()} ${monthName(date)} ${date.getFullYear()}, ${hoursMinutes(date)}:${pad2(date.getSeconds())}`;
}

/** "20 Sep" in the current year, else "20 Sep 2025" (`history.legendGhost`). */
export function formatShortDate(date: Date, now: Date): string {
  const base = `${date.getDate()} ${monthName(date)}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

function isYesterday(date: Date, now: Date): boolean {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  );
}

/** Relative time (UX section 9.13): just now, {m} min ago, {h} h ago, yesterday at 14:05, 12 Sep 2026, 14:05. */
export function formatRelativeTime(date: Date, now: Date): string {
  const elapsedMs = now.getTime() - date.getTime();
  if (elapsedMs < 45_000) return 'just now';
  if (elapsedMs < 60 * 60_000) return `${Math.max(1, Math.floor(elapsedMs / 60_000))} min ago`;
  if (elapsedMs < 24 * 60 * 60_000) return `${Math.floor(elapsedMs / (60 * 60_000))} h ago`;
  if (isYesterday(date, now)) return `yesterday at ${hoursMinutes(date)}`;
  return `${date.getDate()} ${monthName(date)} ${date.getFullYear()}, ${hoursMinutes(date)}`;
}

/** Latitude/longitude with 6 decimals, never grouped (C-27). */
export function formatDegrees(value: number): string {
  return roundHalfAway(value, 6).toFixed(6);
}

/** ITM metres with 1 decimal and no digit grouping, so the value pastes into GIS tools (C-27). */
export function formatItmMetres(value: number): string {
  return roundHalfAway(value, 1).toFixed(1);
}
