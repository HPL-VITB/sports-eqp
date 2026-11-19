"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Category, Location, Sport } from "@/server/inventory/masterdata";

function AddForm({
  placeholder,
  onAdd,
  withCode,
  busy,
  parents,
}: {
  placeholder: string;
  onAdd: (name: string, code: string, parentId: string) => Promise<unknown>;
  withCode?: boolean;
  busy: boolean;
  parents?: { id: string; name: string }[];
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [parentId, setParentId] = useState("");
  return (
    <form
      className="row"
      style={{ marginTop: "0.5rem" }}
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(name.trim(), code.trim(), parentId).then((ok) => {
          if (ok === false) return; // keep the typed text so it can be corrected
          setName("");
          setCode("");
        });
      }}
    >
      <input style={{ maxWidth: 240 }} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {withCode && (
        <input style={{ maxWidth: 110 }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Code (auto)" aria-label="Code" maxLength={4} />
      )}
      {parents && (
        <select style={{ maxWidth: 220 }} value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Inside">
          <option value="">Top-level location</option>
          {parents.map((p) => <option key={p.id} value={p.id}>Room inside {p.name}</option>)}
        </select>
      )}
      <button type="submit" className="secondary" disabled={busy || name.length < 2}>Add</button>
    </form>
  );
}

export function MasterData({ sports, categories, locations }: { sports: Sport[]; categories: Category[]; locations: Location[] }) {
  const router = useRouter();
  const [sportId, setSportId] = useState(sports.find((s) => s.is_active)?.id ?? "");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "success", text: label });
      router.refresh();
      return true;
    } catch (err) {
      setMsg({ kind: "error", text: (err as ApiError).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const toggle = (path: string, active: boolean, name: string) =>
    run(`${active ? "Deactivated" : "Reactivated"} ${name}.`, () => api(path, { method: "PATCH", body: { isActive: !active } }));

  const cats = categories.filter((c) => c.sport_id === sportId);

  return (
    <>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
      <div className="grid2" style={{ alignItems: "start" }}>
        <section className="panel">
          <h2 style={{ marginTop: 0 }}>Sports</h2>
          <table>
            <tbody>
              {sports.map((s) => (
                <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.55 }}>
                  <td>
                    <button type="button" className="link" onClick={() => setSportId(s.id)} style={{ fontWeight: s.id === sportId ? 700 : 500 }}>
                      {s.name}
                    </button>
                  </td>
                  <td className="muted">{s.code}</td>
                  <td className="muted">{s.category_count} cat. · {s.item_count} items</td>
                  <td><button type="button" className="link" disabled={busy} onClick={() => toggle(`/api/sports/${s.id}`, s.is_active, s.name)}>{s.is_active ? "Deactivate" : "Reactivate"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddForm busy={busy} placeholder="New sport" withCode onAdd={(name, code) => run(`Added ${name}.`, () => api("/api/sports", { method: "POST", body: { name, code: code || undefined } }))} />
        </section>

        <section className="panel">
          <h2 style={{ marginTop: 0 }}>Categories — {sports.find((s) => s.id === sportId)?.name ?? "select a sport"}</h2>
          <table>
            <tbody>
              {cats.map((c) => (
                <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.55 }}>
                  <td>{c.name}</td>
                  <td className="muted">{c.code}</td>
                  <td className="muted">{c.item_count} items</td>
                  <td><button type="button" className="link" disabled={busy} onClick={() => toggle(`/api/categories/${c.id}`, c.is_active, c.name)}>{c.is_active ? "Deactivate" : "Reactivate"}</button></td>
                </tr>
              ))}
              {cats.length === 0 && <tr><td className="muted">No categories yet.</td></tr>}
            </tbody>
          </table>
          {sportId && (
            <AddForm busy={busy} placeholder="New category, e.g. Balls" withCode onAdd={(name, code) => run(`Added ${name}.`, () => api("/api/categories", { method: "POST", body: { sportId, name, code: code || undefined } }))} />
          )}
        </section>

        <section className="panel">
          <h2 style={{ marginTop: 0 }}>Storage locations</h2>
          <table>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id} style={{ opacity: l.is_active ? 1 : 0.55 }}>
                  <td>{l.path}</td>
                  <td><button type="button" className="link" disabled={busy} onClick={() => toggle(`/api/locations/${l.id}`, l.is_active, l.name)}>{l.is_active ? "Deactivate" : "Reactivate"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <AddForm
            busy={busy}
            placeholder="New location or room"
            parents={locations.filter((l) => l.parent_id === null && l.is_active).map((l) => ({ id: l.id, name: l.name }))}
            onAdd={(name, _code, parentId) =>
              run(`Added ${name}.`, () => api("/api/locations", { method: "POST", body: { name, parentId: parentId || undefined } }))
            }
          />
        </section>
      </div>
    </>
  );
}
