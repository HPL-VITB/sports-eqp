import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <div className="center">
      <div className="card">
        <h1>Not available for your role</h1>
        <p className="muted">If you need access, ask FR Sports to update your role.</p>
        <Link href="/">Go to your home page</Link>
      </div>
    </div>
  );
}
