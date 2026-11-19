/** Usage: DATABASE_URL=... npm run db:migrate   (run on every deploy before the new version serves traffic) */
import path from "node:path";
import { createPgDb } from "../src/server/db/pg";
import { runMigrations } from "../src/server/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
// Migrations should use the DIRECT (unpooled) Neon connection string when available.
const db = createPgDb(process.env.DATABASE_URL_UNPOOLED ?? url, 1);
try {
  const report = await runMigrations(db, path.resolve("db/migrations"));
  console.log(`Applied: ${report.applied.join(", ") || "none"}; already applied: ${report.alreadyApplied.length}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
}
