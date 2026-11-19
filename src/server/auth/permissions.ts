import { forbidden } from "../errors";

export const ROLES = ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  FR_SPORTS: "FR Sports",
  ASO: "Assistant Sports Officer",
  STOREKEEPER: "Storekeeper",
  PROCUREMENT: "Procurement",
  MANAGEMENT: "HAC / Management",
  RECIPIENT: "Recipient",
};

export const CATEGORIES = ["STUDENT", "FACULTY", "STAFF", "COACH", "SPORTS_COORDINATOR"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = {
  STUDENT: "Student",
  FACULTY: "Faculty",
  STAFF: "Staff",
  COACH: "Coach",
  SPORTS_COORDINATOR: "Sports coordinator",
};

const FR: Role = "FR_SPORTS";
const ASO: Role = "ASO";
const SK: Role = "STOREKEEPER";
const PR: Role = "PROCUREMENT";
const MG: Role = "MANAGEMENT";
const RC: Role = "RECIPIENT";

/**
 * The single source of truth for "who may do what" (blueprint Section E).
 * Every server action and API route calls can()/requirePermission(); UI hiding is cosmetic only.
 */
export const PERMISSIONS = {
  "catalog.view": [FR, ASO, SK, PR, MG, RC], // browse equipment (recipients: available items only)
  "dashboard.view": [FR, ASO, SK, PR, MG],
  "inventory.view": [FR, ASO, SK, PR, MG],
  "item.manage": [FR, ASO],
  "stock.receive": [FR, ASO, PR],
  "request.create": [FR, ASO, SK, PR, RC],
  "request.approveIssue": [FR, ASO],
  "request.markReady": [FR, ASO, SK],
  "request.reject": [FR, ASO],
  "return.record": [FR, ASO, SK],
  "damaged.markUsable": [FR, ASO],
  "incident.report": [FR, ASO, SK],
  "verification.count": [FR, ASO, SK],
  "adjustment.request": [ASO, SK],
  "adjustment.approve": [FR],
  "discard.request": [ASO, SK],
  "discard.approve": [FR],
  "movement.reverse": [FR],
  "reports.view": [FR, ASO, SK, PR, MG],
  "audit.view": [FR, MG],
  "users.manage": [FR],
  "masterdata.manage": [FR],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function requirePermission(user: { role: Role; is_active: boolean }, action: Action): void {
  if (!user.is_active || !can(user.role, action)) throw forbidden();
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Staff stay signed in for 12 idle hours; recipients for 7 idle days (blueprint Section J). */
export function idleTimeoutMs(role: Role): number {
  return role === "RECIPIENT" ? 7 * 24 * 3600_000 : 12 * 3600_000;
}

export interface NavItem {
  href: string;
  label: string;
}

const NAV: ReadonlyArray<NavItem & { action: Action; recipientOnly?: boolean; staffOnly?: boolean }> = [
  { href: "/dashboard", label: "Dashboard", action: "dashboard.view" },
  { href: "/inventory", label: "Inventory", action: "inventory.view" },
  { href: "/requests", label: "Requests & Issues", action: "request.markReady" },
  { href: "/returns", label: "Returns", action: "return.record" },
  { href: "/adjustments", label: "Adjustments & discards", action: "incident.report" },
  { href: "/reports", label: "Reports", action: "reports.view" },
  { href: "/admin/users", label: "Users & roles", action: "users.manage" },
  { href: "/admin/master", label: "Sports & locations", action: "masterdata.manage" },
  { href: "/admin/emails", label: "Email delivery", action: "users.manage" },
  { href: "/admin/audit", label: "Audit log", action: "audit.view" },
  { href: "/browse", label: "Browse & request", action: "catalog.view", recipientOnly: true },
  { href: "/my", label: "My requests & equipment", action: "request.create", recipientOnly: true },
];

/** Navigation for a role. Management sees requests read-only via Reports, so the operational menus are staff-only. */
export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => can(role, n.action) && (!n.recipientOnly || role === "RECIPIENT")).map(({ href, label }) => ({
    href,
    label,
  }));
}

export function homePathForRole(role: Role): string {
  return role === "RECIPIENT" ? "/my" : "/dashboard";
}
