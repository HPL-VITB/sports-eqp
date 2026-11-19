import { redirect } from "next/navigation";
import { currentUser } from "@/server/next-session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return (
    <div className="center">
      <div className="card">
        <h1>Sports Equipment Portal</h1>
        <p className="muted">VIT Bhopal University · Sports Department</p>
        <LoginForm />
      </div>
    </div>
  );
}
