/**
 * Minimal database contract used by all server code.
 * Production implementation: src/server/db/pg.ts (node-postgres).
 * Values follow node-postgres defaults: bigint/numeric -> string, int -> number,
 * timestamptz -> Date, json/jsonb -> parsed, date -> 'YYYY-MM-DD' string.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  /** Without params: simple protocol (multi-statement allowed). With params: one statement. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /**
   * Runs fn inside BEGIN/COMMIT on one connection. Rolls back on any throw.
   * A serialization failure or deadlock is retried once automatically.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** SQLSTATE codes we react to. */
export const PG = {
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
  FOREIGN_KEY_VIOLATION: "23503",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK: "40P01",
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "constraint" in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}

/** Shared retry logic for tx() implementations. */
export async function withTxRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const code = pgCode(err);
    if (code === PG.SERIALIZATION_FAILURE || code === PG.DEADLOCK) return attempt();
    throw err;
  }
}
