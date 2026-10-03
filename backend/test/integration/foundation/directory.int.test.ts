import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createUser, disableUserInDb, revokeSessionInDb } from '../../helpers/users.js';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const EXPIRE = sql(
  'testDirectory.expire',
  "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
);
const INSERT_AREA = sql(
  'testDirectory.insertArea',
  `INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, change_seq, created_by, updated_by, deleted_at, deleted_by)
   SELECT $1, 'Directory probe', g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4, 0.01,
          nextval('area_change_seq'), $2, $2, CASE WHEN $3::boolean THEN now() END, CASE WHEN $3::boolean THEN $2::uuid END
   FROM (SELECT ST_MakeEnvelope(34.78, 32.08, 34.79, 32.09, 4326) AS g) s`,
);
const INSERT_VERSION = sql(
  'testDirectory.insertVersion',
  `INSERT INTO area_versions (area_id, version, op, name, geom, area_km2, perimeter_km, vertex_count, changed_fields, change_seq, actor_id)
   SELECT id, version, 'create', name, geom, area_km2, perimeter_km, vertex_count, ARRAY[]::text[], change_seq, created_by FROM areas WHERE id = $1`,
);
const SET_WATERMARK = sql(
  'testDirectory.setWatermark',
  "UPDATE system_state SET value = to_jsonb($1::bigint) WHERE key = 'change_feed_purge_watermark'",
);
const MAX_SEQ = sql('testDirectory.maxSeq', 'SELECT COALESCE(max(change_seq), 0) AS max FROM area_versions');

describe('SessionReader (section 3.3, section 0 "Active session")', () => {
  it('returns only active sessions of enabled users', async () => {
    const { container } = testApp;
    const active = await createUser(container);
    const revoked = await createUser(container);
    const expired = await createUser(container);
    const disabled = await createUser(container);
    await revokeSessionInDb(container, revoked.sessionId);
    await container.db.query(EXPIRE, [expired.sessionId]);
    await disableUserInDb(container, disabled.id);

    await expect(container.sessions.getActive(active.sessionId)).resolves.toMatchObject({
      sessionId: active.sessionId,
      userId: active.id,
      role: 'user',
    });
    for (const sessionId of [
      revoked.sessionId,
      expired.sessionId,
      disabled.sessionId,
      randomUUID(),
      'not-a-uuid',
    ]) {
      await expect(container.sessions.getActive(sessionId)).resolves.toBeNull();
    }

    const many = await container.sessions.getActiveMany([
      active.sessionId,
      revoked.sessionId,
      expired.sessionId,
      disabled.sessionId,
      'garbage',
      ...Array.from({ length: 600 }, () => randomUUID()),
    ]);
    expect([...many.keys()]).toEqual([active.sessionId]);
    expect(many.get(active.sessionId)?.absoluteExpiresAt).toBeInstanceOf(Date);
    await expect(container.sessions.getActiveMany([])).resolves.toEqual(new Map());
  });
});

describe('UserDirectory (section 3.3)', () => {
  it('returns current profiles with colour, role and disabled flag', async () => {
    const { container } = testApp;
    const admin = await createUser(container, { role: 'admin', color: '#9888d7' });
    const disabled = await createUser(container, { disabled: true });
    const profiles = await container.users.getProfiles([admin.id, disabled.id, randomUUID(), 'x']);
    expect(profiles.get(admin.id)).toEqual({
      id: admin.id,
      displayName: admin.displayName,
      color: '#9888d7',
      role: 'admin',
      disabled: false,
    });
    expect(profiles.get(disabled.id)?.disabled).toBe(true);
    expect(profiles.size).toBe(2);
  });
});

describe('AreaReader (section 3.3, section 5.5)', () => {
  it('returns the bbox of live areas only', async () => {
    const { container } = testApp;
    const owner = await createUser(container);
    const live = randomUUID();
    const deleted = randomUUID();
    await container.db.query(INSERT_AREA, [live, owner.id, false]);
    await container.db.query(INSERT_AREA, [deleted, owner.id, true]);
    const bbox = await container.areasReader.getBbox(live);
    expect(bbox?.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([34.78, 32.08, 34.79, 32.09]);
    await expect(container.areasReader.getBbox(deleted)).resolves.toBeNull();
    await expect(container.areasReader.getBbox(randomUUID())).resolves.toBeNull();
    await expect(container.areasReader.getBbox('nope')).resolves.toBeNull();
  });

  it('latestChangeSeq = GREATEST(max(change_seq), purge watermark)', async () => {
    const { container } = testApp;
    const owner = await createUser(container);
    const areaId = randomUUID();
    await container.db.query(INSERT_AREA, [areaId, owner.id, false]);
    await container.db.query(INSERT_VERSION, [areaId]);
    const [row] = await container.db.query<{ max: number }>(MAX_SEQ);
    const max = row?.max ?? 0;
    expect(max).toBeGreaterThan(0);
    await expect(container.areasReader.latestChangeSeq()).resolves.toBe(max);
    try {
      await container.db.query(SET_WATERMARK, [max + 1000]);
      await expect(container.areasReader.latestChangeSeq()).resolves.toBe(max + 1000);
    } finally {
      await container.db.query(SET_WATERMARK, [0]);
    }
  });
});
