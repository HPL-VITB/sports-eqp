"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";

const REASONS = [
  ["BROKEN", "Broken"],
  ["WORN_OUT", "Worn out"],
  ["OBSOLETE", "Obsolete"],
  ["BEYOND_USE", "Beyond usable condition"],
  ["OTHER", "Other"],
] as const;

/** Store staff (ASO / storekeeper): ask FR Sports to discard units in the store, or to correct a count difference. */
export function StockActions({ itemId, unit, availableToIssue, available, damaged }: { itemId: string; unit: string; availableToIssue: number; available: number; damaged: number }) {
  const router = useRouter();
  const [dQty, setDQty] = useState("");
  const [reason, setReason] = useState("WORN_OUT");
  const [details, setDetails] = useState("");
  const [cState, setCState] = useState<"AVAILABLE" | "DAMAGED">("AVAILABLE");
  const [counted, setCounted] = useState("");
  const [cReason, setCReason] = useState("");
  const [key, setKey] = useState(newRequestKey);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const expected = cState === "AVAILABLE" ? available : damaged;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "success", text: ok });
      setKey(newRequestKey());
      router.refresh();
    } catch (err) {
      setMsg({ kind: "error", text: (err as ApiError).message });
    }
    setBusy(false);
  }

  return (
    <details className="panel">
      <summary>Request a discard or a stock correction (FR Sports approves)</summary>
      <div className="grid2" style={{ alignItems: "start" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api("/api/discards", { method: "POST", body: { itemId, qty: Number(dQty), reason, details: details || null, idempotencyKey: key } }),
              "Discard request sent to FR Sports. The units are held until decided.",
            );
          }}
        >
          <strong>Discard units in the store</strong>
          <p className="muted">For damaged or missing units, use the record under Adjustments instead. Issued units cannot be discarded.</p>
          <label htmlFor="dq">Quantity (up to {availableToIssue} {unit}s)</label>
          <input id="dq" inputMode="numeric" value={dQty} onChange={(e) => setDQty(e.target.value.replace(/\D/g, ""))} />
          <label htmlFor="dr">Reason</label>
          <select id="dr" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label htmlFor="dd">Details</label>
          <input id="dd" value={details} onChange={(e) => setDetails(e.target.value)} placeholder={reason === "OTHER" ? "Required" : "Optional"} />
          <button type="submit" className="secondary" style={{ marginTop: "0.75rem" }} disabled={busy || !(Number(dQty) >= 1 && Number(dQty) <= availableToIssue)}>
            Request discard
          </button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api("/api/corrections", { method: "POST", body: { itemId, state: cState, countedQty: Number(counted), reason: cReason } }),
              "Correction sent to FR Sports.",
            );
          }}
        >
          <strong>Physical count differs</strong>
          <label htmlFor="cs">Which stock</label>
          <select id="cs" value={cState} onChange={(e) => setCState(e.target.value as "AVAILABLE" | "DAMAGED")}>
            <option value="AVAILABLE">Usable on the shelf (system: {available})</option>
            <option value="DAMAGED">Damaged on the shelf (system: {damaged})</option>
          </select>
          <label htmlFor="cc">Actually counted</label>
          <input id="cc" inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value.replace(/\D/g, ""))} />
          {counted !== "" && Number(counted) !== expected && (
            <p className="muted">Change: {Number(counted) - expected > 0 ? "+" : ""}{Number(counted) - expected}</p>
          )}
          <label htmlFor="cr">Reason</label>
          <input id="cr" value={cReason} onChange={(e) => setCReason(e.target.value)} placeholder="e.g. found behind rack" />
          <button type="submit" className="secondary" style={{ marginTop: "0.75rem" }} disabled={busy || counted === "" || Number(counted) === expected || cReason.trim().length < 3}>
            Request correction
          </button>
        </form>
      </div>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
    </details>
  );
}

/** FR Sports: undo a receipt or opening stock entered by mistake. */
export function ReverseButton({ movementId, qty }: { movementId: string; qty: number }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="link"
      onClick={async () => {
        const reason = window.prompt(`Reverse this entry of ${qty}? Explain what was wrong:`);
        if (!reason) return;
        try {
          await api(`/api/movements/${movementId}/reverse`, { method: "POST", body: { reason } });
          router.refresh();
        } catch (err) {
          window.alert((err as ApiError).message);
        }
      }}
    >
      Reverse
    </button>
  );
}
