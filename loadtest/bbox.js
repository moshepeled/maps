// Snapland load test (docs/BENCHMARKS.md), plain k6 JavaScript. Seed first (`seed --count 15000 --region-count
// 12000`), then run it against nginx on the compose network:
//   docker run --rm -i --network snapland-bench_default -e BASE_URL=http://nginx grafana/k6:2.3.0 run -q - < loadtest/bbox.js
// BBOX_RATE and WRITE_RATE (per second) set the offered load, e.g. `-e BBOX_RATE=8 -e WRITE_RATE=2` saturates.
//
// - bbox:   BBOX_RATE random padded 1920x1080 viewports per second over the seeded Tel Aviv region at zoom 12-16,
//           following nextCursor like the SPA (limit 2000, at most 10 pages), round-robin over 16 users.
// - writes: WRITE_RATE creates per second in the region, round-robin over 3 users (at most 2.5/s keeps each one under
//           the 50/min drawing limit).
// - burst:  one more user sends 60 creates at once: exactly 50 x 201 and 10 x 429 with Retry-After.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5173';
// The test-only value from .env.example, never a real secret.
const PASSWORD = __ENV.SEED_USER_PASSWORD || 'loadtest-password-123';
// The seeded region (backend/src/scripts/seed.ts): [west, south, east, north].
const REGION = [34.7, 31.95, 34.95, 32.2];
const READERS = 16;
const WRITERS = 3;
const BURST = 60;
const DRAW_LIMIT = 50;
const BBOX_RATE = Number(__ENV.BBOX_RATE || 3);
const WRITE_RATE = Number(__ENV.WRITE_RATE || 1);

const xCache = {
  'HIT-L1': new Counter('x_cache_hit_l1'),
  'HIT-L2': new Counter('x_cache_hit_l2'),
  MISS: new Counter('x_cache_miss'),
  BYPASS: new Counter('x_cache_bypass'),
};
const burstCreated = new Counter('burst_created');
const burstRateLimited = new Counter('burst_rate_limited');

export const options = {
  // Logins are paced by the per-IP auth limit (10/min), so logging in 20 users takes about a minute.
  setupTimeout: '3m',
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    burst: { executor: 'per-vu-iterations', exec: 'burst', vus: 1, iterations: 1 },
    bbox: {
      executor: 'constant-arrival-rate',
      exec: 'bbox',
      rate: BBOX_RATE,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
    writes: {
      executor: 'constant-arrival-rate',
      exec: 'writes',
      rate: WRITE_RATE,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 4,
      maxVUs: 10,
    },
  },
  thresholds: {
    'http_req_duration{scenario:bbox}': ['p(95)<500'],
    'http_req_duration{scenario:writes}': ['p(95)<300'],
    'http_req_failed{scenario:bbox}': ['rate<0.01'],
    'http_req_failed{scenario:writes}': ['rate<0.01'],
    // Always true; they make the summary print each scenario's request count and rate.
    'http_reqs{scenario:bbox}': ['count>0'],
    'http_reqs{scenario:writes}': ['count>0'],
    burst_created: [`count==${DRAW_LIMIT}`],
    burst_rate_limited: [`count==${BURST - DRAW_LIMIT}`],
    checks: ['rate>0.99'],
  },
};

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' };
}

function login(username) {
  for (;;) {
    const res = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({ username, password: PASSWORD }), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/v1/auth/login' },
      responseCallback: http.expectedStatuses(200, 429),
    });
    if (res.status === 200) return res.json('accessToken');
    if (res.status !== 429) throw new Error(`login ${username}: HTTP ${res.status} ${res.body}`);
    sleep(Number(res.headers['Retry-After']) + 1);
  }
}

export function setup() {
  const tokens = [];
  for (let n = 1; n <= READERS + WRITERS + 1; n += 1) {
    tokens.push(login(`bench-${String(n).padStart(3, '0')}`));
  }
  return { tokens };
}

/** A padded (1.5x) 1920x1080 viewport centred in the region, as `bbox` and `zoom` query values. */
function randomViewport() {
  const zoom = 12 + Math.floor(Math.random() * 5);
  const degreesPerPx = 360 / (256 * 2 ** zoom);
  const lng = REGION[0] + Math.random() * (REGION[2] - REGION[0]);
  const lat = REGION[1] + Math.random() * (REGION[3] - REGION[1]);
  const halfWidth = 1440 * degreesPerPx;
  const halfHeight = 810 * degreesPerPx * Math.cos((lat * Math.PI) / 180);
  const bbox = [lng - halfWidth, lat - halfHeight, lng + halfWidth, lat + halfHeight];
  return { zoom, bbox: bbox.map((value) => value.toFixed(6)).join(',') };
}

/** A ~50 m square somewhere in the region. */
function newArea() {
  const lng = REGION[0] + Math.random() * (REGION[2] - REGION[0] - 0.001);
  const lat = REGION[1] + Math.random() * (REGION[3] - REGION[1] - 0.001);
  const d = 0.0005;
  const ring = [
    [lng, lat],
    [lng + d, lat],
    [lng + d, lat + d],
    [lng, lat + d],
    [lng, lat],
  ];
  return { name: 'k6 load test', geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function bbox(data) {
  // Round-robin over the readers: each gets 0.5 viewports/s, at most 6 pages each (< 300 requests/min).
  const token = data.tokens[exec.scenario.iterationInTest % READERS];
  const viewport = randomViewport();
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = `bbox=${viewport.bbox}&zoom=${viewport.zoom}&limit=2000${cursor ? `&cursor=${cursor}` : ''}`;
    const res = http.get(`${BASE_URL}/api/v1/areas?${query}`, {
      headers: headers(token),
      tags: { name: 'GET /api/v1/areas' },
    });
    check(res, { 'bbox 200': (r) => r.status === 200 });
    const outcome = xCache[res.headers['X-Cache']];
    if (outcome) outcome.add(1);
    if (res.status !== 200) return;
    cursor = res.json('nextCursor');
    if (!cursor) return;
  }
}

export function writes(data) {
  const token = data.tokens[READERS + (exec.scenario.iterationInTest % WRITERS)];
  const res = http.post(`${BASE_URL}/api/v1/areas`, JSON.stringify(newArea()), {
    headers: headers(token),
    tags: { name: 'POST /api/v1/areas' },
  });
  check(res, { 'create 201': (r) => r.status === 201 });
}

export function burst(data) {
  const token = data.tokens[READERS + WRITERS];
  for (let i = 0; i < BURST; i += 1) {
    const res = http.post(`${BASE_URL}/api/v1/areas`, JSON.stringify(newArea()), {
      headers: headers(token),
      tags: { name: 'POST /api/v1/areas (burst)' },
      responseCallback: http.expectedStatuses(201, 429),
    });
    if (res.status === 201) burstCreated.add(1);
    if (res.status === 429) {
      burstRateLimited.add(1);
      check(res, { 'burst 429 has Retry-After': (r) => Number(r.headers['Retry-After']) > 0 });
    }
  }
}
