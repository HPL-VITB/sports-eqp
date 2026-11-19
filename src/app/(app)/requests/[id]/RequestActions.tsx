"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import type { IssueResult, RequestView } from "@/server/requests/requests";

export function RequestActions({
  request: r,
  canApprove,
  ownRequest,
  issuers,
  minDate,
  maxDate,
  meId,
}: {
  request: RequestView;
  canApprove: boolean;
  ownRequest: boolean;
  issuers: { id: string; name: string; role: string }[];
  minDate: string;
  maxDate: string;
  meId: string;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(r.lines.map((l) => [l.itemId, Math.min(l.qtyRequested, l.availableNow)])),
  );
  const [dueDate, setDueDate] = useState(r.expectedReturn < minDate ? minDate : r.expectedReturn > maxDate ? maxDate : r.expectedReturn);
  const [issuedById, setIssuedById] = useState(meId);
  const [reason, setReason] = useState("");
  const [key] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const total = Object.values(qty).reduce((a, b) => a + b, 0);
  const anyShort = r.lines.some((l) => (qty[l.itemId] ?? 0) > l.availableNow);
  const issuerName = issuers.find((i) => i.id === issuedById)?.name ?? "";

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "success", text: success });
      router.refresh();
    } catch (err) {
      setMsg({ kind: "error", text: (err as ApiError).message });
      setBusy(false);
    }
  }

  async function approve() {
    const summary = r.lines.filter((l) => (qty[l.itemId] ?? 0) > 0).map((l) => `${qty[l.itemId]} × ${l.name}`).join("\n");
    if (!window.confirm(`Hand over now to ${r.requester.name}?\n\n${summary}\n\nHanded over by: ${issuerName}\nDue back: ${dueDate}\n\nStock will be deducted.`)) return;
    await act(async () => {
      const res = await api<{ issue: IssueResult }>(`/api/requests/${r.id}/issue`, {
        method: "POST",
        body: { lines: r.lines.map((l) => ({ itemId: l.itemId, qty: qty[l.itemId] ?? 0 })), dueDate, issuedById, idempotencyKey: key },
      });
      return res;
    }, "Issued. Confirmation emails are on their way.");
  }

  return (
    <>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Equipment</th>
            <th style={{ textAlign: "right" }}>Requested</th>
            <th style={{ textAlign: "right" }}>Available now</th>
            {canApprove && <th style={{ width: 120 }}>Hand over</th>}
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.itemId}>
              <td data-label="Code">{l.code}</td>
              <td data-label="Equipment">{l.name}{l.brand ? ` (${l.brand})` : ""}</td>
              <td data-label="Requested" style={{ textAlign: "right" }}>{l.qtyRequested} {l.unit}</td>
              <td data-label="Available" style={{ textAlign: "right" }} className={l.availableNow < l.qtyRequested ? "error" : undefined}>
                {l.availableNow}
              </td>
              {canApprove && (
                <td data-label="Hand over">
                  <input
                    inputMode="numeric"
                    value={qty[l.itemId] ?? 0}
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(l.qtyRequested, Number(e.target.value.replace(/\D/g, "") || 0)));
                      setQty((q) => ({ ...q, [l.itemId]: n }));
                    }}
                    aria-label={`Quantity of ${l.name} to hand over`}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {canApprove && (
        <div className="panel">
          <strong>Approve & hand over</strong>
          <p className="muted">Approval and stock deduction happen together, at the moment of handover. Set a line to 0 to leave it out.</p>
          <div className="grid2">
            <div>
              <label htmlFor="issuer">Handed over by</label>
              <select id="issuer" value={issuedById} onChange={(e) => setIssuedById(e.target.value)}>
                {issuers.map((i) => <option key={i.id} value={i.id}>{i.name}{i.id === meId ? " (me)" : ""}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="due">Due back</label>
              <input id="due" type="date" min={minDate} max={maxDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          {anyShort && <p className="error">A quantity is more than is available now. Reduce it.</p>}
          <button type="button" onClick={approve} disabled={busy || total === 0 || anyShort} style={{ marginTop: "0.75rem" }}>
            {busy ? "Working…" : `Approve & hand over (${total})`}
          </button>
        </div>
      )}
      {ownRequest && <p className="muted">This is your own request; another officer must decide on it.</p>}

      <div className="grid2" style={{ alignItems: "start" }}>
        {canApprove && (
          <div className="panel">
            <strong>Reject</strong>
            <label htmlFor="reason">Reason (sent to the requester)</label>
            <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ground closed this week" />
            <button
              type="button"
              className="secondary"
              style={{ marginTop: "0.75rem" }}
              disabled={busy || reason.trim().length < 3}
              onClick={() => {
                if (window.confirm(`Reject ${r.ref}? Nothing will be issued.`)) {
                  void act(() => api(`/api/requests/${r.id}/reject`, { method: "POST", body: { reason } }), "Rejected. The requester has been emailed.");
                }
              }}
            >
              Reject request
            </button>
          </div>
        )}
        <div className="panel">
          <strong>Preparation</strong>
          <p className="muted">{r.ready ? "Marked as set aside and ready." : "Mark when the equipment has been picked and set aside. No stock moves."}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => act(() => api(`/api/requests/${r.id}/ready`, { method: "POST", body: { ready: !r.ready } }), r.ready ? "Unmarked." : "Marked ready.")}
          >
            {r.ready ? "Unmark ready" : "Mark ready for handover"}
          </button>
        </div>
      </div>
    </>
  );
}
