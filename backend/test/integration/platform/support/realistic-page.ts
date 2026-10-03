/**
 * A realistic bbox page body (SPEC section 10.2 v1.2, section 5.5 seed distribution): `count` list items over the Tel Aviv region,
 * each a convex polygon with 5-40 vertices (uniform) whose radius is log-uniform in [15 m, 800 m], at the display
 * precision of the page. QA measured such 2,000-item pages at ~ 1.1 MiB (z12) - 1.4 MiB (z14) of raw JSON.
 * Deterministic (seeded PRNG), so sizes are reproducible.
 */
const TEL_AVIV_REGION = { west: 34.7, south: 31.95, east: 34.95, north: 32.2 };
const METERS_PER_DEGREE_LAT = 111_320;

/** mulberry32 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function uuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RealisticPageOptions {
  count?: number;
  /** Decimals of the page's coordinates (section 8.7: display precision per zoom). */
  decimals?: number;
  /**
   * Simplification tolerance of the page's zoom in metres (section 5.5 ST_Simplify ~ 1 px): a circle of radius r keeps about
   * π / acos(1 − t / r) vertices, so small polygons collapse to a few vertices like they do in real list pages.
   */
  toleranceM?: number;
  seed?: number;
}

/** Vertices a Douglas-Peucker simplification keeps on a regular polygon of radius `radiusM`. */
function keptVertices(vertices: number, radiusM: number, toleranceM: number): number {
  if (toleranceM <= 0) return vertices;
  const kept = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - toleranceM / radiusM)));
  return Math.max(4, Math.min(vertices, kept));
}

export function realisticPageBody({
  count = 2000,
  decimals = 6,
  toleranceM = 4,
  seed = 42,
}: RealisticPageOptions = {}): string {
  const random = seededRandom(seed);
  const round = (value: number): number => Number(value.toFixed(decimals));
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const radiusM = 15 * Math.exp(random() * Math.log(800 / 15));
    const vertices = keptVertices(5 + Math.floor(random() * 36), radiusM, toleranceM);
    const lat = TEL_AVIV_REGION.south + random() * (TEL_AVIV_REGION.north - TEL_AVIV_REGION.south);
    const lng = TEL_AVIV_REGION.west + random() * (TEL_AVIV_REGION.east - TEL_AVIV_REGION.west);
    const dLat = radiusM / METERS_PER_DEGREE_LAT;
    const dLng = dLat / Math.cos((lat * Math.PI) / 180);
    const ring: [number, number][] = [];
    for (let v = 0; v < vertices; v += 1) {
      const angle = (2 * Math.PI * v) / vertices;
      ring.push([round(lng + dLng * Math.cos(angle)), round(lat + dLat * Math.sin(angle))]);
    }
    ring.push(ring[0] ?? [lng, lat]);
    const lngs = ring.map((position) => position[0]);
    const lats = ring.map((position) => position[1]);
    const userId = uuid(random);
    items.push({
      id: uuid(random),
      name: `Parcel ${i + 1}`,
      geometry: { type: 'Polygon', coordinates: [ring] },
      bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      areaKm2: round(Math.PI * (radiusM / 1000) ** 2),
      version: 1 + Math.floor(random() * 5),
      changeSeq: 1000 + i,
      createdById: userId,
      updatedBy: { id: userId, displayName: `Editor ${i % 97}`, color: '#9888d7' },
      updatedAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    });
  }
  return JSON.stringify({
    items,
    nextCursor: 'b2Zmc2V0LTIwMDA',
    asOfChangeSeq: 1000 + count,
    simplified: true,
    precision: decimals,
    zoom: 14,
    queryBbox: [TEL_AVIV_REGION.west, TEL_AVIV_REGION.south, TEL_AVIV_REGION.east, TEL_AVIV_REGION.north],
    minExtentDeg: 0,
    culledCount: 0,
  });
}
