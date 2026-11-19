import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "../audit";
import { isAdminEmail } from "../config";
import type { AppContext } from "../context";
import { otpEmail } from "../email/mailer";
import { AppError } from "../errors";
import { hit } from "./rate-limit";
import { createSession } from "./sessions";
import { emailDomain, normalizeEmail, USER_COLUMNS, type User } from "./users";

export const OTP_TTL_MIN = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SEC = 60;
export const OTP_SENDS_PER_EMAIL_PER_HOUR = 5;
export const OTP_SENDS_PER_IP_PER_HOUR = 20;
export const OTP_VERIFIES_PER_IP_PER_HOUR = 60;

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function hashCode(secret: string, salt: string, code: string): string {
  return createHmac("sha256", secret).update(`${salt}:${code}`).digest("hex");
}

function tooMany(retryAfterSec: number, message: string) {
  return new AppError(429, "RATE_LIMITED", message, { retryAfterSec });
}

/** The response is identical whether or not an account exists for the email. */
export async function requestOtp(ctx: AppContext, input: { email: string; ip: string | null }) {
  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) throw new AppError(400, "EMAIL_INVALID", "Enter a valid email address.");
  const email = normalizeEmail(parsed.data);
  if (!ctx.config.ALLOWED_EMAIL_DOMAINS.includes(emailDomain(email))) {
    const domains = ctx.config.ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(" or ");
    throw new AppError(400, "EMAIL_DOMAIN", `Use your ${domains} email address.`);
  }
  const now = ctx.now();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");

  // Limits and cooldown are checked in the same transaction that creates the code, under a per-email lock,
  // so two simultaneous requests cannot both slip past the cooldown.
  const outcome = await ctx.db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`otp:${email}`]);
    if (input.ip) {
      const ipLimit = await hit(q, `otp-send-ip:${input.ip}`, OTP_SENDS_PER_IP_PER_HOUR, 3600, now);
      if (!ipLimit.allowed) return { blocked: tooMany(ipLimit.retryAfterSec, "Too many sign-in attempts from this network. Try again later.") };
    }
    const last = await q.query<{ created_at: Date }>(
      "SELECT created_at FROM otp_challenges WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
      [email],
    );
    const lastAt = last.rows[0]?.created_at;
    if (lastAt) {
      const waitMs = lastAt.getTime() + OTP_RESEND_COOLDOWN_SEC * 1000 - now.getTime();
      if (waitMs > 0) {
        const s = Math.ceil(waitMs / 1000);
        return { blocked: tooMany(s, `Please wait ${s} seconds before requesting another code.`) };
      }
    }
    const emailLimit = await hit(q, `otp-send-email:${email}`, OTP_SENDS_PER_EMAIL_PER_HOUR, 3600, now);
    if (!emailLimit.allowed) {
      return { blocked: tooMany(emailLimit.retryAfterSec, "Too many codes requested for this email. Try again later.") };
    }
    await q.query(
      "UPDATE otp_challenges SET invalidated_at = $2 WHERE email = $1 AND consumed_at IS NULL AND invalidated_at IS NULL",
      [email, now],
    );
    const ins = await q.query<{ id: string }>(
      `INSERT INTO otp_challenges (email, code_salt, code_hash, created_at, expires_at, request_ip)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, salt, hashCode(ctx.config.OTP_HMAC_SECRET, salt, code), now, new Date(now.getTime() + OTP_TTL_MIN * 60_000), input.ip],
    );
    return { challengeId: ins.rows[0]!.id };
  });
  if ("blocked" in outcome) throw outcome.blocked;

  try {
    await ctx.mailer.send(otpEmail(email, code, OTP_TTL_MIN));
  } catch (err) {
    // Remove the unsent code so the user is not held by the cooldown, then report a clear failure.
    await ctx.db.query("DELETE FROM otp_challenges WHERE id = $1", [outcome.challengeId]);
    console.error("OTP email failed", err);
    throw new AppError(502, "EMAIL_FAILED", "We could not send the code just now. Please try again in a minute.");
  }
  return { sent: true, expiresInSec: OTP_TTL_MIN * 60, resendAfterSec: OTP_RESEND_COOLDOWN_SEC };
}

type VerifyOutcome =
  | { ok: true; user: User; token: string }
  | { ok: false; error: AppError };

export async function verifyOtp(
  ctx: AppContext,
  input: { email: string; code: string; ip: string | null; userAgent: string | null },
): Promise<{ user: User; token: string }> {
  const email = normalizeEmail(input.email ?? "");
  const code = String(input.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new AppError(400, "OTP_FORMAT", "Enter the 6-digit code from the email.");
  const now = ctx.now();

  // Returns instead of throwing for wrong codes so the attempt counter is committed.
  const outcome: VerifyOutcome = await ctx.db.tx(async (q) => {
    if (input.ip) {
      const lim = await hit(q, `otp-verify-ip:${input.ip}`, OTP_VERIFIES_PER_IP_PER_HOUR, 3600, now);
      if (!lim.allowed) return { ok: false, error: tooMany(lim.retryAfterSec, "Too many attempts from this network. Try again later.") };
    }
    const found = await q.query<{ id: string; code_salt: string; code_hash: string; expires_at: Date; attempts: number }>(
      `SELECT id, code_salt, code_hash, expires_at, attempts FROM otp_challenges
        WHERE email = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email],
    );
    const ch = found.rows[0];
    if (!ch || now >= ch.expires_at) {
      return { ok: false, error: new AppError(400, "OTP_INVALID", "This code has expired or is not valid. Request a new code.") };
    }
    if (ch.attempts >= OTP_MAX_ATTEMPTS) {
      return { ok: false, error: new AppError(400, "OTP_LOCKED", "Too many wrong attempts. Request a new code.") };
    }
    await q.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [ch.id]);
    const expected = Buffer.from(ch.code_hash, "hex");
    const actual = Buffer.from(hashCode(ctx.config.OTP_HMAC_SECRET, ch.code_salt, code), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      const left = OTP_MAX_ATTEMPTS - ch.attempts - 1;
      return {
        ok: false,
        error:
          left > 0
            ? new AppError(400, "OTP_WRONG", `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.`, { attemptsLeft: left })
            : new AppError(400, "OTP_LOCKED", "Too many wrong attempts. Request a new code."),
      };
    }
    await q.query("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [ch.id, now]);

    // First successful sign-in creates the account as a Recipient. Roles are granted only by FR Sports.
    const up = await q.query<User>(
      `INSERT INTO users AS u (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING ${USER_COLUMNS}`,
      [email],
    );
    let user = up.rows[0]!;
    if (!user.is_active) {
      return { ok: false, error: new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated. Contact the Sports Department.") };
    }
    // The department admin mailbox (ADMIN_EMAILS, default fr.sports@vitbhopal.ac.in) is always FR Sports.
    // Safe: the user has just proven control of that mailbox with the emailed code.
    if (isAdminEmail(ctx.config, email) && user.role !== "FR_SPORTS") {
      const promoted = await q.query<User>(
        `UPDATE users u SET role = 'FR_SPORTS', name = COALESCE(u.name, 'FR Sports'), updated_at = $2
          WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [user.id, now],
      );
      await writeAudit(q, {
        actorId: user.id,
        action: "user.admin_mailbox_promote",
        entity: "user",
        entityId: user.id,
        before: { role: user.role },
        after: { role: "FR_SPORTS" },
        ip: input.ip,
      });
      user = promoted.rows[0]!;
    }
    const token = await createSession(q, user.id, { ip: input.ip, userAgent: input.userAgent }, now);
    await writeAudit(q, { actorId: user.id, action: "auth.login", entity: "user", entityId: user.id, ip: input.ip });
    return { ok: true, user, token };
  });
  if (!outcome.ok) throw outcome.error;
  return { user: outcome.user, token: outcome.token };
}

/** Housekeeping for a daily job: old codes, expired sessions and spent rate-limit windows. */
export async function purgeExpired(ctx: AppContext) {
  const now = ctx.now();
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000);
  const otp = await ctx.db.query("DELETE FROM otp_challenges WHERE created_at < $1", [monthAgo]);
  const sess = await ctx.db.query("DELETE FROM sessions WHERE expires_at < $1 OR last_seen_at < $2", [now, new Date(now.getTime() - 7 * 24 * 3600_000)]);
  const rl = await ctx.db.query("DELETE FROM rate_limits WHERE window_start < $1", [dayAgo]);
  return { otpChallenges: otp.rowCount, sessions: sess.rowCount, rateLimitWindows: rl.rowCount };
}
