import { timingSafeEqual } from "node:crypto";
/**
 * Framework-independent HTTP handlers (standard Request -> Response).
 * Next.js route files in src/app/api/** only forward to these, so the same code is tested without Next.js.
 */
import { z } from "zod";
import { listAudit } from "../audit";
import { listUsers, updateOwnProfile, updateUser } from "../auth/accounts";
import { purgeExpired, requestOtp, verifyOtp } from "../auth/otp";
import { homePathForRole, navForRole, requirePermission } from "../auth/permissions";
import { getSessionUser, revokeSession, SESSION_ABSOLUTE_MS } from "../auth/sessions";
import { needsProfile, publicUser, type User } from "../auth/users";
import type { AppContext } from "../context";
import { AppError, unauthenticated } from "../errors";
import { ledgerMismatches } from "../inventory/ledger";

// ---------- cookies ----------

export function sessionCookieName(ctx: AppContext): string {
  // __Host- prefix: browser only accepts it over HTTPS, for this exact host, path "/".
  return ctx.config.secureCookies ? "__Host-sei_session" : "sei_session";
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(ctx: AppContext, token: string, maxAgeSec: number): string {
  const parts = [
    `${sessionCookieName(ctx)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (ctx.config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

export function tokenFromRequest(ctx: AppContext, req: Request): string | null {
  return parseCookies(req.headers.get("cookie"))[sessionCookieName(ctx)] ?? null;
}

// ---------- request helpers ----------

/** On Vercel, x-forwarded-for is set by the platform; the first entry is the client. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim().slice(0, 64) || null;
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/**
 * CSRF defence for every state-changing request: the browser-set Origin header must match this app.
 * (Session cookie is also SameSite=Lax.) Requests without Origin are accepted only when the browser
 * marks them same-origin via Sec-Fetch-Site.
 */
export function assertSameOrigin(ctx: AppContext, req: Request): void {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin === ctx.config.APP_ORIGIN) return;
    // Also accept the address the request was actually sent to (e.g. the *.vercel.app URL or a second
    // domain), so a stale APP_ORIGIN does not lock everyone out. A different website still never matches,
    // because the browser sets Origin to that website.
    if (requestOrigins(req).includes(origin)) return;
  } else if (req.headers.get("sec-fetch-site") === "same-origin") {
    return;
  }
  throw new AppError(403, "BAD_ORIGIN", "Request blocked: it did not come from this site.");
}

/** The origin(s) this request was addressed to: from the URL, and from Vercel's forwarded host headers. */
function requestOrigins(req: Request): string[] {
  const out: string[] = [];
  try {
    out.push(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    out.push(`${proto}://${host}`);
  }
  return out;
}

export async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 64_000) throw new AppError(413, "TOO_LARGE", "Request too large.");
  try {
    return await req.json();
  } catch {
    throw new AppError(400, "BAD_JSON", "Request body must be JSON.");
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (typeof err.extra.retryAfterSec === "number") headers["retry-after"] = String(err.extra.retryAfterSec);
    return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status, headers);
  }
  console.error("Unhandled error", err);
  return json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } }, 500);
}

export type Handler = (ctx: AppContext, req: Request) => Promise<Response>;

export function handle(fn: Handler): Handler {
  return async (ctx, req) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(ctx, req);
      return await fn(ctx, req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function requireUser(ctx: AppContext, req: Request, opts: { allowIncompleteProfile?: boolean } = {}): Promise<User> {
  const user = await getSessionUser(ctx, tokenFromRequest(ctx, req));
  if (!user) throw unauthenticated();
  if (!opts.allowIncompleteProfile && needsProfile(ctx.config, user)) {
    throw new AppError(403, "PROFILE_INCOMPLETE", "Complete your profile first.");
  }
  return user;
}

// ---------- auth ----------

const requestOtpBody = z.object({ email: z.string().max(254) });
const verifyOtpBody = z.object({ email: z.string().max(254), code: z.string().max(12) });

export const requestOtpHandler = handle(async (ctx, req) => {
  const body = requestOtpBody.safeParse(await readJson(req));
  if (!body.success) throw new AppError(400, "EMAIL_INVALID", "Enter a valid email address.");
  const result = await requestOtp(ctx, { email: body.data.email, ip: clientIp(req) });
  return json(result);
});

export const verifyOtpHandler = handle(async (ctx, req) => {
  const body = verifyOtpBody.safeParse(await readJson(req));
  if (!body.success) throw new AppError(400, "OTP_FORMAT", "Enter the 6-digit code from the email.");
  const { user, token } = await verifyOtp(ctx, {
    ...body.data,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  // Tell the browser where to go, so it lands on the right page in one hop (admins -> dashboard).
  const home = needsProfile(ctx.config, user) ? "/profile" : homePathForRole(user.role);
  return json({ user: publicUser(user), home }, 200, {
    "set-cookie": sessionCookie(ctx, token, Math.floor(SESSION_ABSOLUTE_MS / 1000)),
  });
});

export const logoutHandler = handle(async (ctx, req) => {
  const token = tokenFromRequest(ctx, req);
  if (token) await revokeSession(ctx.db, token);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(ctx, "", 0) });
});

// ---------- current user ----------

export const meHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req, { allowIncompleteProfile: true });
  return json({ user: publicUser(user), nav: navForRole(user.role) });
});

export const updateProfileHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req, { allowIncompleteProfile: true });
  const updated = await updateOwnProfile(ctx, user, await readJson(req), clientIp(req));
  return json({ user: publicUser(updated) });
});

// ---------- administration ----------

export const listUsersHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const result = await listUsers(ctx, user, params);
  return json({ users: result.users.map(publicUser), total: result.total });
});

export function updateUserHandler(ctx: AppContext, req: Request, targetId: string): Promise<Response> {
  return handle(async (c, r) => {
    const user = await requireUser(c, r);
    const updated = await updateUser(c, user, targetId, await readJson(r), clientIp(r));
    return json({ user: publicUser(updated) });
  })(ctx, req);
}

export const listAuditHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  requirePermission(user, "audit.view");
  const sp = new URL(req.url).searchParams;
  const before = sp.get("before");
  const rows = await listAudit(ctx.db, {
    beforeId: before && /^\d+$/.test(before) ? before : undefined,
    entity: sp.get("entity") ?? undefined,
    limit: Number(sp.get("limit") ?? 100) || 100,
  });
  return json({ entries: rows });
});

// ---------- scheduled maintenance ----------

export function assertCronSecret(ctx: AppContext, req: Request): void {
  const secret = ctx.config.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid job credentials.");
  }
}

/**
 * Daily maintenance (Vercel Cron, "Authorization: Bearer $CRON_SECRET"): housekeeping plus the stock ledger
 * consistency check. Any mismatch is logged as an error for the maintainer; balances are never auto-"fixed".
 */
export const purgeHandler = handle(async (ctx, req) => {
  assertCronSecret(ctx, req);
  const purged = await purgeExpired(ctx);
  const mismatches = await ledgerMismatches(ctx.db);
  if (mismatches.length) console.error("STOCK LEDGER MISMATCH", JSON.stringify(mismatches));
  return json({ purged, ledgerMismatches: mismatches.length });
});
