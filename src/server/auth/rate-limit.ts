import type { Queryable } from "../db/types";

export interface RateResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Fixed-window counter stored in Postgres (no Redis needed at this scale).
 * Each call counts one hit; allowed while count <= limit within the window.
 */
export async function hit(
  q: Queryable,
  bucket: string,
  limit: number,
  windowSec: number,
  now: Date,
): Promise<RateResult> {
  const windowMs = windowSec * 1000;
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const res = await q.query<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [bucket, start],
  );
  const count = res.rows[0]!.count;
  const retryAfterSec = Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: count <= limit, retryAfterSec };
}
