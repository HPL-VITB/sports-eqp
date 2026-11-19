import Link from "next/link";
import { navForRole, ROLE_LABELS } from "@/server/auth/permissions";
import { requireUserPage } from "@/server/next-session";
import { SignOutButton } from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUserPage();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">Sports Equipment Portal</div>
        {navForRole(user.role).map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
        <Link href="/profile">Profile</Link>
        <div className="who">
          <div>{user.name}</div>
          <div>{ROLE_LABELS[user.role]}</div>
          <SignOutButton />
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}
