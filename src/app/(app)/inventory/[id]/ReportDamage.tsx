"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import { uploadPhoto } from "@/lib/photo";

/** Damage found in the store: moves units from Available to Damaged. */
export function ReportDamage({ itemId, unit, available }: { itemId: string; unit: string; available: number }) {
  const router = useRouter();
  const [qty, setQty] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [key, setKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const n = Number(qty);
  return (
    <details className="panel">
      <summary>Report damage found in the store</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!window.confirm(`Move ${n} ${unit}(s) from Available to Damaged?`)) return;
          setBusy(true);
          setMsg(null);
          try {
            const photoId = photo ? await uploadPhoto(photo) : null;
            await api(`/api/items/${itemId}/damage`, { method: "POST", body: { qty: n, description, photoId, idempotencyKey: key } });
            setMsg({ kind: "success", text: `Recorded ${n} damaged.` });
            setQty("");
            setDescription("");
            setPhoto(null);
            setKey(newRequestKey());
            router.refresh();
          } catch (err) {
            setMsg({ kind: "error", text: err instanceof ApiError || err instanceof Error ? err.message : "Failed." });
          }
          setBusy(false);
        }}
      >
        <div className="grid2">
          <div>
            <label htmlFor="dqty">Damaged units (of {available} in the store)</label>
            <input id="dqty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div>
            <label htmlFor="ddesc">What is wrong</label>
            <input id="ddesc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label htmlFor="dphoto">Photo (optional)</label>
            <input id="dphoto" type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        {msg && <p className={msg.kind} role="status">{msg.text}</p>}
        <button type="submit" className="secondary" disabled={busy || !(n >= 1 && n <= available) || description.trim().length < 3} style={{ marginTop: "0.75rem" }}>
          {busy ? "Saving…" : "Record damage"}
        </button>
      </form>
    </details>
  );
}
