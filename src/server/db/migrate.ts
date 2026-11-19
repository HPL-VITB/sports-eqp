import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "./types";

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

const LOCK_KEY = 72_410_001; // arbitrary constant: one migration run at a time

/**
 * Applies pending db/migrations/NNNN_name.sql files in order, all in ONE transaction:
 * either every pending migration lands or none does.
 * Refuses to run if an already-applied file has been edited (checksum mismatch).
 */
export async function runMigrations(db: Db, dir: string): Promise<MigrationReport> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const report: MigrationReport = { applied: [], alreadyApplied: [] };

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    const done = await q.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(done.rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const version = file.replace(/\.sql$/, "");
      const prior = applied.get(version);
      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        }
        report.alreadyApplied.push(version);
        continue;
      }
      await q.query(sql);
      await q.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
      report.applied.push(version);
    }
  });
  return report;
}
