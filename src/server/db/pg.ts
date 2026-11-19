import pg from "pg";
import { withTxRetry, type Db, type Queryable, type QueryResult } from "./types";

// Keep DATE columns as 'YYYY-MM-DD' strings (node-postgres would build a local-midnight Date).
pg.types.setTypeParser(1082, (v: string) => v);

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
      const res = params === undefined ? await client.query(text) : await client.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
  };
}

/** Production database: one small pool per server instance (serverless-friendly). */
export function createPgDb(connectionString: string, max = 5): Db {
  // Opening a new TLS connection to Neon costs several round trips, so keep idle connections around longer
  // (warm serverless instances reuse them) and keep them alive through proxies.
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  const base = wrap(pool);
  return {
    query: base.query,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return withTxRetry(async () => {
        const client = await pool.connect();
        try {
          // One round trip instead of two (simple-protocol query, so both statements run together).
          await client.query("BEGIN; SET LOCAL lock_timeout = '5s'");
          const result = await fn(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      });
    },
    end: () => pool.end(),
  };
}
