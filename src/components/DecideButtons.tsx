"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/** FR Sports approve / reject (with reason) for discards and corrections. */
export function DecideButtons({ path, summary }: { path: string; summary: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(decision: "APPROVE" | "REJECT") {
    if (decision === "REJECT" && note.trim().length < 3) {
      window.alert("Type a short reason for rejecting.");
      return;
    }
    if (!window.confirm(`${decision === "APPROVE" ? "Approve" : "Reject"}: ${summary}?`)) return;
    setBusy(true);
    try {
      await api(path, { method: "POST", body: { decision, note: note || null } });
      router.refresh();
    } catch (err) {
      window.alert((err as ApiError).message);
    }
    setBusy(false);
  }
  return (
    <div className="row" style={{ gap: "0.25rem" }}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note / reason" aria-label="Note" style={{ maxWidth: 150 }} />
      <button type="button" disabled={busy} onClick={() => decide("APPROVE")}>Approve</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => decide("REJECT")}>Reject</button>
    </div>
  );
}

export function CancelLink({ path, label = "Cancel" }: { path: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Cancel this request?")) return;
        setBusy(true);
        try {
          await api(path, { method: "POST" });
          router.refresh();
        } catch (err) {
          window.alert((err as ApiError).message);
        }
        setBusy(false);
      }}
    >
      {label}
    </button>
  );
}
