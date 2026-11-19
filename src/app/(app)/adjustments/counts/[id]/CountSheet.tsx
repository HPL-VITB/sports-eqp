"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { CountLineView } from "@/server/adjustments/verification";

type Entry = { usable: string; damaged: string };

export function CountSheet({ id, lines }: { id: string; lines: CountLineView[] }) {
  const router = useRouter();
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(lines.map((l) => [l.item.id, { usable: l.countedUsable?.toString() ?? "", damaged: l.countedDamaged?.toString() ?? "" }])),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const filled = Object.values(entries).filter((e) => e.usable !== "" && e.damaged !== "").length;
  const toNum = (s: string) => (s === "" ? null : Number(s));

  async function save(quiet = false) {
    await api(`/api/counts/${id}`, {
      method: "PUT",
      body: { lines: Object.entries(entries).map(([itemId, e]) => ({ itemId, usable: toNum(e.usable), damaged: toNum(e.damaged) })) },
    });
    if (!quiet) setMsg({ kind: "success", text: "Saved. You can continue later." });
  }

  return (
    <>
      <p className="muted">
        Count physically. Leave a box empty until counted; enter 0 if there are none. The system figures are shown for reference and
        are captured again when you submit.
      </p>
      <table>
        <thead>
          <tr><th>Equipment</th><th style={{ textAlign: "right" }}>System: usable / damaged</th><th style={{ textAlign: "right" }}>Out on issue</th><th>Counted usable</th><th>Counted damaged</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const e = entries[l.item.id]!;
            const differs = e.usable !== "" && e.damaged !== "" && (Number(e.usable) !== l.expectedUsable || Number(e.damaged) !== l.expectedDamaged);
            return (
              <tr key={l.lineId} className={differs ? "err" : undefined}>
                <td data-label="Equipment">{l.item.name} <span className="muted">{l.item.code} · {l.item.category}</span></td>
                <td data-label="System" style={{ textAlign: "right" }}>{l.expectedUsable} / {l.expectedDamaged}</td>
                <td data-label="On issue" style={{ textAlign: "right" }}>{l.issued}</td>
                {(["usable", "damaged"] as const).map((k) => (
                  <td key={k} data-label={`Counted ${k}`}>
                    <input
                      inputMode="numeric"
                      value={e[k]}
                      onChange={(ev) => setEntries((x) => ({ ...x, [l.item.id]: { ...x[l.item.id]!, [k]: ev.target.value.replace(/\D/g, "") } }))}
                      aria-label={`${l.item.name} ${k}`}
                      style={{ maxWidth: 90 }}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="panel row">
        <span>{filled} of {lines.length} counted</span>
        <button type="button" className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await save(); } catch (e) { setMsg({ kind: "error", text: (e as ApiError).message }); } setBusy(false); }}>
          Save progress
        </button>
        <button
          type="button"
          disabled={busy || filled < lines.length}
          onClick={async () => {
            if (!window.confirm("Submit the count? Differences will be sent to FR Sports as corrections.")) return;
            setBusy(true);
            setMsg(null);
            try {
              await save(true);
              await api(`/api/counts/${id}/submit`, { method: "POST" });
              router.refresh();
            } catch (e) {
              setMsg({ kind: "error", text: (e as ApiError).message });
            }
            setBusy(false);
          }}
        >
          Submit count
        </button>
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm("Abandon this count? Nothing will change in stock.")) return;
            await api(`/api/counts/${id}/abandon`, { method: "POST" }).catch((e: ApiError) => window.alert(e.message));
            router.push("/adjustments/counts");
          }}
        >
          Abandon
        </button>
      </div>
      {msg && <p className={msg.kind} role="status">{msg.text}</p>}
    </>
  );
}
