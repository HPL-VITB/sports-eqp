"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";

export function ResolveIncident({ id, itemId, open, actions }: { id: string; itemId: string; open: number; actions: { value: string; label: string }[] }) {
  const router = useRouter();
  const [action, setAction] = useState(actions[0]?.value ?? "");
  const [qty, setQty] = useState(String(open));
  const [remarks, setRemarks] = useState("");
  const [key, setKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  if (!actions.length) return null;
  const n = Number(qty);
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: "0.25rem" }}>
      <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action" style={{ maxWidth: 150 }}>
        {actions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </select>
      <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} aria-label="Quantity" style={{ maxWidth: 60 }} />
      <input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Remarks" aria-label="Remarks" style={{ maxWidth: 140 }} />
      <button
        type="button"
        className="secondary"
        disabled={busy || !(n >= 1 && n <= open)}
        onClick={async () => {
          const label = actions.find((a) => a.value === action)!.label;
          if (!window.confirm(`${label}: ${n} unit(s)?`)) return;
          setBusy(true);
          try {
            if (action === "DISCARD") {
              await api("/api/discards", {
                method: "POST",
                body: { itemId, incidentId: id, qty: n, reason: "BEYOND_USE", details: remarks || null, idempotencyKey: key },
              });
            } else {
              await api(`/api/incidents/${id}/resolve`, { method: "POST", body: { action, qty: n, remarks: remarks || null, idempotencyKey: key } });
            }
            setKey(newRequestKey());
            router.refresh();
          } catch (err) {
            window.alert((err as ApiError).message);
          }
          setBusy(false);
        }}
      >
        Save
      </button>
    </div>
  );
}
