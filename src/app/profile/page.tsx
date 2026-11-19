import { redirect } from "next/navigation";
import { CATEGORIES, CATEGORY_LABELS } from "@/server/auth/permissions";
import { publicUser, registrationNoFromEmail } from "@/server/auth/users";
import { currentUser } from "@/server/next-session";
import { ProfileForm } from "./ProfileForm";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const first = user.profile_completed_at === null;
  // Students' emails contain their registration number (name.24bcg10080@...); faculty / staff emails do not.
  const regNo = registrationNoFromEmail(user.email);
  const kind = regNo ? "student" : "employee";
  const allowed = CATEGORIES.filter((c) =>
    kind === "student" ? c === "STUDENT" || c === "SPORTS_COORDINATOR" : c !== "STUDENT",
  );
  return (
    <div className="center">
      <div className="card">
        <h1>{first ? "Complete your profile" : "Your profile"}</h1>
        <p className="muted">
          Signed in as {user.email}.{" "}
          {first ? "We need these details once, to record who holds equipment." : null}
        </p>
        <ProfileForm
          user={publicUser(user)}
          kind={kind}
          regNoFromEmail={regNo}
          categories={allowed.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        />
      </div>
    </div>
  );
}
