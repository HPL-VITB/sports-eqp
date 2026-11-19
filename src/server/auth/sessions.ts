import { createHash, randomBytes } from "node:crypto";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { idleTimeoutMs } from "./permissions";
import { USER_COLUMNS, type User } from "./users";

export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Returns the raw token for the cookie. Only its SHA-256 is stored. */
export async function createSession(
  q: Queryable,
  userId: string,
  meta: { ip: string | null; userAgent: string | null },
  now: Date,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q.query(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [hashToken(token), userId, now, new Date(now.getTime() + SESSION_ABSOLUTE_MS), meta.ip, meta.userAgent?.slice(0, 300) ?? null],
  );
  return token;
}

/**
 * Resolves a cookie token to an active user, enforcing absolute expiry, role-based idle timeout
 * and deactivation. Reads the user fresh on every request, so role changes apply immediately.
 */
export async function getSessionUser(ctx: AppContext, token: string | null | undefined): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const id = hashToken(token);
  const res = await ctx.db.query<User & { s_last_seen_at: Date; s_expires_at: Date }>(
    `SELECT ${USER_COLUMNS}, s.last_seen_at AS s_last_seen_at, s.expires_at AS s_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) return null;
  const now = ctx.now();
  const idleFor = now.getTime() - row.s_last_seen_at.getTime();
  if (now >= row.s_expires_at || idleFor > idleTimeoutMs(row.role) || !row.is_active) {
    await ctx.db.query("DELETE FROM sessions WHERE id = $1", [id]);
    return null;
  }
  if (idleFor > TOUCH_INTERVAL_MS) {
    await ctx.db.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [id, now]);
  }
  const { s_last_seen_at: _a, s_expires_at: _b, ...user } = row;
  return user;
}

export async function revokeSession(q: Queryable, token: string): Promise<void> {
  await q.query("DELETE FROM sessions WHERE id = $1", [hashToken(token)]);
}

export async function revokeAllSessions(q: Queryable, userId: string): Promise<number> {
  const res = await q.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return res.rowCount;
}
