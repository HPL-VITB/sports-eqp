import { redirect } from "next/navigation";
import { homePathForRole } from "@/server/auth/permissions";
import { needsProfile } from "@/server/auth/users";
import { currentUser } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (needsProfile(getAppContext().config, user)) redirect("/profile");
  redirect(homePathForRole(user.role));
}
