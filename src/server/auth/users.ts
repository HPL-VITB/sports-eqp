import { isAdminEmail, type Config } from "../config";
import type { Queryable } from "../db/types";
import type { Category, Role } from "./permissions";

export interface User {
  id: string;
  email: string;
  name: string | null;
  univ_id: string | null;
  category: Category | null;
  role: Role;
  is_active: boolean;
  profile_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const USER_COLUMNS =
  "u.id, u.email, u.name, u.univ_id, u.category, u.role, u.is_active, u.profile_completed_at, u.created_at, u.updated_at";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Registration / employee numbers: upper case, no spaces, e.g. "23BCE10045". */
export function normalizeUnivId(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export const UNIV_ID_PATTERN = /^[A-Z0-9/-]{3,30}$/;

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** VIT Bhopal registration number, e.g. 24BCG10080: 2-digit year, 2-4 letter programme, 4-6 digits. */
const REG_NO_SEGMENT = /^\d{2}[a-z]{2,4}\d{4,6}$/;

/**
 * Student emails carry the registration number: "abhilash.24bcg10080@vitbhopal.ac.in" -> "24BCG10080".
 * Faculty / staff emails ("abishekisrael@vitbhopal.ac.in") do not, so this returns null for them.
 */
export function registrationNoFromEmail(email: string): string | null {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  const last = local.split(".").pop() ?? "";
  return REG_NO_SEGMENT.test(last) ? last.toUpperCase() : null;
}

export type AccountKind = "student" | "employee";
export function accountKindFromEmail(email: string): AccountKind {
  return registrationNoFromEmail(email) ? "student" : "employee";
}

/** Profile must be completed before using the portal, except for the department admin mailbox. */
export function needsProfile(config: Pick<Config, "ADMIN_EMAILS">, user: Pick<User, "email" | "profile_completed_at">): boolean {
  return user.profile_completed_at === null && !isAdminEmail(config, user.email);
}

export async function findUserById(q: Queryable, id: string, lock = false): Promise<User | null> {
  const res = await q.query<User>(
    `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Public shape returned to the browser. */
export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    univId: u.univ_id,
    category: u.category,
    role: u.role,
    isActive: u.is_active,
    profileComplete: u.profile_completed_at !== null,
  };
}
export type PublicUser = ReturnType<typeof publicUser>;
