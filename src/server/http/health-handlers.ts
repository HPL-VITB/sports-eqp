import type { AppContext } from "../context";
import { EXPECTED_SCHEMA_VERSION } from "../db/schema-version";

/**
 * Public health check for uptime monitors and the post-deploy smoke test. Reveals nothing but up/down and whether the
 * database schema matches this build. Never cached.
 */
export async function healthHandler(ctx: AppContext, _req: Request): Promise<Response> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    const r = await ctx.db.query<{ v: string | null }>("SELECT left(max(version), 4) AS v FROM schema_migrations");
    const current = r.rows[0]?.v ?? null;
    const schema = current === EXPECTED_SCHEMA_VERSION ? "current" : current && current > EXPECTED_SCHEMA_VERSION ? "newer" : "behind";
    const ok = schema !== "behind";
    return new Response(JSON.stringify({ status: ok ? "ok" : "degraded", database: "up", schema }), { status: ok ? 200 : 503, headers });
  } catch {
    return new Response(JSON.stringify({ status: "down", database: "unreachable" }), { status: 503, headers });
  }
}
