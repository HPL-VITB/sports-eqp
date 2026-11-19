import { ROLES, ROLE_LABELS } from "@/server/auth/permissions";
import { requirePermissionPage } from "@/server/next-session";
import { UsersAdmin } from "./UsersAdmin";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requirePermissionPage("users.manage");
  return (
    <>
      <h1>Users & roles</h1>
      <p className="muted">
        Everyone who signs in with a university email starts as a Recipient. Grant staff roles here. Every change is
        recorded in the audit log.
      </p>
      <UsersAdmin meId={me.id} roles={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
    </>
  );
}
