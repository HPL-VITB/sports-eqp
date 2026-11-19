import { z } from "zod";
import { writeAudit } from "../audit";
import type { AppContext } from "../context";
import { PG, pgCode, pgConstraint, type Queryable } from "../db/types";
import { AppError, notFound } from "../errors";
import { CATEGORIES, ROLES, requirePermission, type Role } from "./permissions";
import { revokeAllSessions } from "./sessions";
import { findUserById, normalizeUnivId, registrationNoFromEmail, UNIV_ID_PATTERN, USER_COLUMNS, type User } from "./users";

const univIdSchema = z
  .string()
  .transform(normalizeUnivId)
  .refine((v) => UNIV_ID_PATTERN.test(v), "Registration / employee number: 3-30 letters, digits, '-' or '/'.");

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(100),
  // Students: taken from their email, so it may be omitted. Employees: required.
  univId: z.string().max(60).optional(),
  category: z.enum(CATEGORIES),
});

function validation(err: z.ZodError) {
  return new AppError(400, "VALIDATION", err.issues[0]?.message ?? "Invalid input.", {
    fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

function univIdTaken(err: unknown): never {
  if (pgCode(err) === PG.UNIQUE_VIOLATION && pgConstraint(err) === "users_univ_id_key") {
    throw new AppError(409, "UNIV_ID_TAKEN", "This registration / employee number is already linked to another account. Contact FR Sports.");
  }
  throw err;
}

/**
 * A user completes their own profile once. Name and category can be updated later;
 * the registration / employee number is then locked and only FR Sports can change it,
 * so nobody can take over another person's identity by typing their number.
 */
export async function updateOwnProfile(ctx: AppContext, actor: User, input: unknown, ip: string | null): Promise<User> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error);
  const { name, category } = parsed.data;
  // Student emails contain the registration number (abhilash.24bcg10080@...). Use it, so nobody can
  // register under someone else's number. Faculty / staff emails have none: they enter an employee number.
  const regNo = registrationNoFromEmail(actor.email);
  let univId: string;
  if (regNo) {
    // Student sports coordinators are students too.
    if (category !== "STUDENT" && category !== "SPORTS_COORDINATOR") {
      throw new AppError(400, "VALIDATION", "This is a student email address: choose Student or Sports coordinator.");
    }
    univId = regNo;
  } else {
    if (category === "STUDENT") {
      throw new AppError(400, "VALIDATION", "Student accounts use the registration-number email (name.24abc10000@vitbhopal.ac.in).");
    }
    const emp = univIdSchema.safeParse(parsed.data.univId ?? "");
    if (!emp.success) throw new AppError(400, "VALIDATION", "Employee number: 3-30 letters, digits, '-' or '/'.");
    univId = emp.data;
  }
  try {
    return await ctx.db.tx(async (q) => {
      const current = await findUserById(q, actor.id, true);
      if (!current || !current.is_active) throw new AppError(403, "ACCOUNT_DISABLED", "This account has been deactivated.");
      // A student's number was already locked in (possibly set by FR Sports): keep it.
      if (regNo && current.univ_id !== null) univId = current.univ_id;
      if (current.univ_id !== null && current.univ_id !== univId) {
        throw new AppError(403, "UNIV_ID_LOCKED", "Your registration / employee number is locked. Contact FR Sports to change it.");
      }
      const res = await q.query<User>(
        `UPDATE users u SET name = $2, univ_id = $3, category = $4,
                profile_completed_at = COALESCE(profile_completed_at, $5), updated_at = $5
          WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [actor.id, name, univId, category, ctx.now()],
      );
      const updated = res.rows[0]!;
      await writeAudit(q, {
        actorId: actor.id,
        action: "user.profile",
        entity: "user",
        entityId: actor.id,
        before: { name: current.name, univId: current.univ_id, category: current.category },
        after: { name, univId, category },
        ip,
      });
      return updated;
    });
  } catch (err) {
    univIdTaken(err);
  }
}

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listUsers(ctx: AppContext, actor: User, input: unknown) {
  requirePermission(actor, "users.manage");
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error);
  const { q, role, limit, offset } = parsed.data;
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const res = await ctx.db.query<User & { total: string }>(
    `SELECT ${USER_COLUMNS}, count(*) OVER () AS total FROM users u
      WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.name ILIKE $1 OR u.univ_id ILIKE $1)
        AND ($2::text IS NULL OR u.role = $2)
      ORDER BY (u.role = 'RECIPIENT'), u.name NULLS LAST, u.email
      LIMIT $3 OFFSET $4`,
    [pattern, role ?? null, limit, offset],
  );
  return { users: res.rows.map(({ total: _t, ...u }) => u as User), total: Number(res.rows[0]?.total ?? 0) };
}

const updateSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
    name: z.string().trim().min(2).max(100).optional(),
    univId: univIdSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

async function lockActiveFrIds(q: Queryable): Promise<string[]> {
  // Locks every active FR Sports row in id order, so concurrent demotions are serialised and cannot
  // together remove the last administrator.
  const res = await q.query<{ id: string }>(
    "SELECT id FROM users WHERE role = 'FR_SPORTS' AND is_active ORDER BY id FOR UPDATE",
  );
  return res.rows.map((r) => r.id);
}

/** FR Sports changes another user's role, active status, name or registration number. */
export async function updateUser(ctx: AppContext, actor: User, targetId: string, input: unknown, ip: string | null): Promise<User> {
  requirePermission(actor, "users.manage");
  if (!/^\d+$/.test(targetId)) throw notFound("User");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error);
  const change = parsed.data;
  if (targetId === actor.id && (change.role !== undefined || change.isActive !== undefined)) {
    throw new AppError(409, "SELF_CHANGE", "You cannot change your own role or deactivate yourself. Ask another FR Sports user.");
  }
  try {
    return await ctx.db.tx(async (q) => {
      const frIds = await lockActiveFrIds(q);
      // Re-check the actor inside the transaction: they may have been demoted a moment ago.
      if (!frIds.includes(actor.id)) throw new AppError(403, "FORBIDDEN", "You do not have permission to do this.");
      const target = await findUserById(q, targetId, true);
      if (!target) throw notFound("User");

      const losesAdmin =
        target.role === "FR_SPORTS" &&
        target.is_active &&
        ((change.role !== undefined && change.role !== "FR_SPORTS") || change.isActive === false);
      if (losesAdmin && frIds.length <= 1) {
        throw new AppError(409, "LAST_ADMIN", "At least one active FR Sports user must remain.");
      }

      const next = {
        role: (change.role ?? target.role) as Role,
        is_active: change.isActive ?? target.is_active,
        name: change.name ?? target.name,
        univ_id: change.univId ?? target.univ_id,
      };
      const res = await q.query<User>(
        `UPDATE users u SET role = $2, is_active = $3, name = $4, univ_id = $5, updated_at = $6
          WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [targetId, next.role, next.is_active, next.name, next.univ_id, ctx.now()],
      );
      if (target.is_active && !next.is_active) await revokeAllSessions(q, targetId);
      await writeAudit(q, {
        actorId: actor.id,
        action: "user.update",
        entity: "user",
        entityId: targetId,
        before: { role: target.role, isActive: target.is_active, name: target.name, univId: target.univ_id },
        after: { role: next.role, isActive: next.is_active, name: next.name, univId: next.univ_id },
        ip,
      });
      return res.rows[0]!;
    });
  } catch (err) {
    univIdTaken(err);
  }
}

/** Used by scripts/create-admin.ts at deployment: creates or promotes the first FR Sports user. */
export async function ensureAdmin(ctx: AppContext, email: string, name: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  return ctx.db.tx(async (q) => {
    const res = await q.query<User>(
      `INSERT INTO users AS u (email, name, role) VALUES ($1, $2, 'FR_SPORTS')
       ON CONFLICT (email) DO UPDATE SET role = 'FR_SPORTS', is_active = true, name = COALESCE(u.name, EXCLUDED.name), updated_at = now()
       RETURNING ${USER_COLUMNS}`,
      [normalized, name],
    );
    const user = res.rows[0]!;
    await writeAudit(q, { actorId: null, action: "user.bootstrap_admin", entity: "user", entityId: user.id, after: { role: "FR_SPORTS" } });
    return user;
  });
}
