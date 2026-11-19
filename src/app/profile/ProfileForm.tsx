"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { PublicUser } from "@/server/auth/users";

export function ProfileForm({
  user,
  kind,
  regNoFromEmail,
  categories,
}: {
  user: PublicUser;
  kind: "student" | "employee";
  regNoFromEmail: string | null;
  categories: { value: string; label: string }[];
}) {
  const router = useRouter();
  const student = kind === "student";
  const [name, setName] = useState(user.name ?? "");
  const [univId, setUnivId] = useState(user.univId ?? regNoFromEmail ?? "");
  const [category, setCategory] = useState(
    user.category && categories.some((c) => c.value === user.category)
      ? user.category
      : categories.length === 1 || student ? categories[0]!.value : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Students' numbers come from their email; employees' are locked once saved.
  const locked = user.univId !== null || student;
  const idLabel = student ? "Registration number" : "Employee number";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ user: PublicUser }>("/api/me/profile", { method: "PATCH", body: { name, univId, category } });
      router.replace(r.user.role === "RECIPIENT" ? "/my" : "/dashboard");
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <label htmlFor="name">Full name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />

      <label htmlFor="univId">{idLabel}</label>
      <input
        id="univId"
        value={univId}
        onChange={(e) => setUnivId(e.target.value.toUpperCase())}
        disabled={locked}
        placeholder={student ? "e.g. 24BCG10080" : "e.g. EMP1234"}
        required
      />
      {student && user.univId === null ? (
        <p className="muted">Taken from your student email address.</p>
      ) : locked ? (
        <p className="muted">Locked. Contact FR Sports if it is wrong.</p>
      ) : (
        <p className="muted">Enter your university employee number. Check carefully: you cannot change it yourself after saving.</p>
      )}

      <label htmlFor="category">I am a</label>
      <select id="category" value={category} onChange={(e) => setCategory(e.target.value)} required>
        <option value="" disabled>Select…</option>
        {categories.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>

      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !name || !univId || !category}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
