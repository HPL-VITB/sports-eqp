"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import { uploadPhoto } from "@/lib/photo";
import type { IssueView } from "@/server/returns/returns";

type Counts = { usable: number; damaged: number; missing: number; consumed: number; note: string };

export function ReturnForm({ issue }: { issue: IssueView }) {
  const router = useRouter();
  const [rows, setRows] = useState<Record<string, Counts>>(() =>
    Object.fromEntries(issue.lines.map((l) => [l.itemId, { usable: l.qty, damaged: 0, missing: 0, consumed: 0, note: "" }])),
  );
  const [remarks, setRemarks] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [key] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (itemId: string, field: keyof Counts, value: string) =>
    setRows((r) => ({ ...r, [itemId]: { ...r[itemId]!, [field]: field === "note" ? value : Number(value.replace(/\D/g, "") || 0) } }));

  const sum = (c: Counts) => c.usable + c.damaged + c.missing + c.consumed;
  const lineProblems = issue.lines.flatMap((l) => {
    const c = rows[l.itemId]!;
    const out: string[] = [];
    if (sum(c) !== l.qty) out.push(`${l.name}: ${sum(c)} of ${l.qty} accounted for`);
    if ((c.missing || c.consumed) && !c.note.trim()) out.push(`${l.name}: add a note for missing / used-up units`);
    return out;
  });
  const totals = Object.values(rows).reduce((a, c) => ({ usable: a.usable + c.usable, damaged: a.damaged + c.damaged, missing: a.missing + c.missing, consumed: a.consumed + c.consumed }), { usable: 0, damaged: 0, missing: 0, consumed: 0 });
  const anyProblem = totals.damaged + totals.missing + totals.consumed > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const summary = `Usable ${totals.usable}, damaged ${totals.damaged}, missing ${totals.missing}${totals.consumed ? `, used up ${totals.consumed}` : ""}`;
    if (!window.confirm(`Record the return of ${issue.ref}?\n\n${summary}\n\nThis closes the issue and cannot be undone here.`)) return;
    setBusy(true);
    setError(null);
    try {
      const photoId = photo ? await uploadPhoto(photo) : null;
      await api(`/api/issues/${issue.id}/return`, {
        method: "POST",
        body: {
          lines: issue.lines.map((l) => {
            const c = rows[l.itemId]!;
            return { itemId: l.itemId, usable: c.usable, damaged: c.damaged, missing: c.missing, consumed: c.consumed, note: c.note || null };
          }),
          remarks: remarks || null,
          photoId,
          idempotencyKey: key,
        },
      });
      router.push(`/returns?done=${encodeURIComponent(issue.ref)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not record the return.");
      setBusy(false);
    }
  }

  const num = (itemId: string, field: keyof Counts, label: string) => (
    <input inputMode="numeric" value={rows[itemId]![field]} onChange={(e) => set(itemId, field, e.target.value)} aria-label={label} style={{ maxWidth: 80 }} />
  );

  return (
    <form onSubmit={submit}>
      <p className="muted">Count what came back. Every issued unit must be recorded as usable, damaged or missing (used up: consumables only).</p>
      <table>
        <thead>
          <tr><th>Equipment</th><th>Issued</th><th>Usable</th><th>Damaged</th><th>Missing</th><th>Used up</th><th>Note</th></tr>
        </thead>
        <tbody>
          {issue.lines.map((l) => {
            const c = rows[l.itemId]!;
            const ok = sum(c) === l.qty;
            return (
              <tr key={l.itemId} className={ok ? undefined : "err"}>
                <td data-label="Equipment">{l.name} <span className="muted">{l.code}</span></td>
                <td data-label="Issued">{l.qty} {l.unit}</td>
                <td data-label="Usable">{num(l.itemId, "usable", `${l.name} usable`)}</td>
                <td data-label="Damaged">{num(l.itemId, "damaged", `${l.name} damaged`)}</td>
                <td data-label="Missing">{num(l.itemId, "missing", `${l.name} missing`)}</td>
                <td data-label="Used up">{l.isConsumable ? num(l.itemId, "consumed", `${l.name} used up`) : <span className="muted">—</span>}</td>
                <td data-label="Note">
                  <input value={c.note} onChange={(e) => set(l.itemId, "note", e.target.value)} placeholder={c.missing || c.consumed ? "Required: what happened?" : "Optional"} aria-label={`${l.name} note`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="panel">
        <div className="grid2">
          <div>
            <label htmlFor="remarks">Remarks (optional)</label>
            <input id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          <div>
            <label htmlFor="photo">Damage photo (optional)</label>
            <input id="photo" type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        {anyProblem && <p className="muted">Damaged, missing and used-up units will appear under Adjustments for follow-up. No penalty is calculated.</p>}
        {lineProblems.length > 0 && <p className="error">{lineProblems.join(". ")}.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || lineProblems.length > 0} style={{ marginTop: "0.75rem" }}>
          {busy ? "Recording…" : "Confirm return"}
        </button>
      </div>
    </form>
  );
}
