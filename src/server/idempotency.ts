import type { Queryable } from "./db/types";
import { AppError } from "./errors";

/**
 * Runs `fn` at most once per key. Call inside the same transaction as the work:
 * - first submission: key reserved, work done, result stored, all committed together;
 * - repeat (double click, retry): waits for the first to commit, then returns its stored result;
 * - if the first submission failed and rolled back, the key was never stored, so a retry runs normally.
 * Results must be plain JSON.
 */
export async function idempotent<T>(
  q: Queryable,
  key: string | undefined | null,
  userId: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await fn(), replayed: false };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new AppError(400, "IDEMPOTENCY_KEY", "Invalid request key.");
  const ins = await q.query(
    `INSERT INTO idempotency_keys (key, user_id, operation) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, userId, operation],
  );
  if (ins.rowCount === 1) {
    const result = await fn();
    await q.query("UPDATE idempotency_keys SET response = $2::jsonb WHERE key = $1", [key, JSON.stringify(result ?? null)]);
    return { result, replayed: false };
  }
  const prior = await q.query<{ user_id: string; operation: string; response: T | null }>(
    "SELECT user_id, operation, response FROM idempotency_keys WHERE key = $1",
    [key],
  );
  const row = prior.rows[0];
  if (!row || String(row.user_id) !== String(userId) || row.operation !== operation) {
    throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used for something else. Reload the page.");
  }
  return { result: row.response as T, replayed: true };
}
