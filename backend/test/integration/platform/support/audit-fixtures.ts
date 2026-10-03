/** Test fixture SQL for `audit_logs` rows with chosen timestamps (the writer always stamps "now"). */
import type { Container } from '../../../../src/container.js';
import { sql } from '../../../../src/infra/db/types.js';

const INSERT_AUDIT_ROW = sql(
  'platformFixtures.insertAuditRow',
  `INSERT INTO audit_logs (occurred_at, action, outcome, actor_id, target_type, target_id, instance_id, details)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
   RETURNING id`,
);

const DELETE_BY_INSTANCE = sql(
  'platformFixtures.deleteAuditByInstance',
  'DELETE FROM audit_logs WHERE instance_id = $1',
);

export interface AuditFixtureRow {
  at: Date;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

/** Inserts the rows in order under `instanceId` (the cleanup key); returns their ids. */
export async function insertAuditRows(
  container: Container,
  instanceId: string,
  rows: readonly AuditFixtureRow[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const row of rows) {
    const [inserted] = await container.db.query<{ id: number }>(INSERT_AUDIT_ROW, [
      row.at,
      row.action,
      row.outcome,
      row.actorId ?? null,
      row.targetType ?? null,
      row.targetId ?? null,
      instanceId,
      JSON.stringify(row.details ?? {}),
    ]);
    if (inserted === undefined) throw new Error('audit fixture insert returned no row');
    ids.push(inserted.id);
  }
  return ids;
}

export async function deleteAuditRows(container: Container, instanceId: string): Promise<void> {
  await container.db.query(DELETE_BY_INSTANCE, [instanceId]);
}
