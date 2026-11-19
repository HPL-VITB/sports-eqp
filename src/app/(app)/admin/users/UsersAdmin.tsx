"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { PublicUser } from "@/server/auth/users";

type Option = { value: string; label: string };

export function UsersAdmin({ meId, roles }: { meId: string; roles: Option[] }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const roleLabel = (r: string) => roles.find((x) => x.value === r)?.label ?? r;

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (role) params.set("role", role);
    try {
      const r = await api<{ users: PublicUser[]; total: number }>(`/api/admin/users?${params}`);
      setUsers(r.users);
      setTotal(r.total);
    } catch (err) {
      setMessage({ kind: "error", text: (err as ApiError).message });
    } finally {
      setLoading(false);
    }
  }, [q, role]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function change(u: PublicUser, patch: { role?: string; isActive?: boolean }, summary: string) {
    if (!window.confirm(`${summary}?`)) return;
    setBusyId(u.id);
    setMessage(null);
    try {
      const r = await api<{ user: PublicUser }>(`/api/admin/users/${u.id}`, { method: "PATCH", body: patch });
      setUsers((list) => list.map((x) => (x.id === u.id ? r.user : x)));
      setMessage({ kind: "success", text: `Saved: ${summary}.` });
    } catch (err) {
      setMessage({ kind: "error", text: (err as ApiError).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <input
          style={{ maxWidth: 320 }}
          placeholder="Search name, email or registration no."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search users"
        />
        <select style={{ maxWidth: 220 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <span className="muted">{loading ? "Loading…" : `${total} user${total === 1 ? "" : "s"}`}</span>
      </div>
      {message && <p className={message.kind} role="status">{message.text}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Reg. / emp. no.</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const self = u.id === meId;
            return (
              <tr key={u.id}>
                <td data-label="Name">{u.name ?? <span className="muted">Profile not completed</span>}</td>
                <td data-label="Email">{u.email}</td>
                <td data-label="Reg. no.">{u.univId ?? "—"}</td>
                <td data-label="Role">
                  <select
                    value={u.role}
                    disabled={self || busyId === u.id}
                    title={self ? "You cannot change your own role" : undefined}
                    onChange={(e) => change(u, { role: e.target.value }, `Make ${u.name ?? u.email} ${roleLabel(e.target.value)}`)}
                    aria-label={`Role for ${u.email}`}
                  >
                    {roles.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </td>
                <td data-label="Status">
                  <span className="badge">{u.isActive ? "Active" : "Deactivated"}</span>{" "}
                  {!self && (
                    <button
                      type="button"
                      className="link"
                      disabled={busyId === u.id}
                      onClick={() =>
                        change(u, { isActive: !u.isActive }, `${u.isActive ? "Deactivate" : "Reactivate"} ${u.name ?? u.email}`)
                      }
                    >
                      {u.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
