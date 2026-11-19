import type { Queryable } from "./db/types";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Always call inside the same transaction as the change it records. */
export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      e.actorId,
      e.action,
      e.entity,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.ip ?? null,
    ],
  );
}

export interface AuditRow {
  id: string;
  created_at: Date;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  actor_email: string | null;
  actor_name: string | null;
}

export async function listAudit(
  q: Queryable,
  opts: { limit?: number; beforeId?: string; entity?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const res = await q.query<AuditRow>(
    `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.before, a.after, a.ip,
            u.email AS actor_email, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::bigint IS NULL OR a.id < $1::bigint)
        AND ($2::text IS NULL OR a.entity = $2::text)
      ORDER BY a.id DESC
      LIMIT $3`,
    [opts.beforeId ?? null, opts.entity ?? null, limit],
  );
  return res.rows;
}
