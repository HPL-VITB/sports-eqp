import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, type Action } from "./auth/permissions";
import { getSessionUser } from "./auth/sessions";
import { needsProfile, type User } from "./auth/users";
import { sessionCookieName } from "./http/handlers";
import { getAppContext } from "./runtime";

/**
 * For server components: the signed-in user, or null.
 * Wrapped in React cache() so the layout and the page share ONE session lookup per request
 * (previously every page load queried the session table at least twice).
 */
export const currentUser = cache(async (): Promise<User | null> => {
  const ctx = getAppContext();
  const store = await cookies();
  return getSessionUser(ctx, store.get(sessionCookieName(ctx))?.value);
});

/** Signed in with a completed profile, else redirected to /login or /profile. */
export async function requireUserPage(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (needsProfile(getAppContext().config, user)) redirect("/profile");
  return user;
}

/** Same, plus a permission check. Sends users without the permission to /forbidden. */
export async function requirePermissionPage(action: Action): Promise<User> {
  const user = await requireUserPage();
  if (!can(user.role, action)) redirect("/forbidden");
  return user;
}
