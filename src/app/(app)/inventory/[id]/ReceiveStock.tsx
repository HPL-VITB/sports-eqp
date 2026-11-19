"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import type { ReceiptResult } from "@/server/inventory/items";

export function ReceiveStock({ itemId, unit, available }: { itemId: string; unit: string; available: number }) {
  const router = useRouter();
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [key, setKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const n = Number(qty);
  const valid = Number.isInteger(n) && n > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm(`Add ${n} ${unit}(s)? Available will go from ${available} to ${available + n}.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ receipt: ReceiptResult }>(`/api/items/${itemId}/receipts`, {
        method: "POST",
        body: { qty: n, remarks, idempotencyKey: key },
      });
      setMsg({ kind: "success", text: `Recorded: ${r.receipt.availableBefore} + ${r.receipt.qty} = ${r.receipt.availableAfter} available.` });
      setQty("");
      setRemarks("");
      setKey(newRequestKey());
      router.refresh();
    } catch (err) {
      setMsg({ kind: "error", text: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel">
      <strong>Receive stock</strong>
      <div className="grid2">
        <div>
          <label htmlFor="rqty">Quantity received ({unit}s)</label>
          <input id="rqty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div>
          <label htmlFor="rrem">Remarks</label>
          <input id="rrem" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. invoice / delivery note no." />
        </div>
      </div>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
      <button type="submit" disabled={busy || !valid} style={{ marginTop: "0.75rem" }}>
        {busy ? "Saving…" : "Add to stock"}
      </button>
    </form>
  );
}
