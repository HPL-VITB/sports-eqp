"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export function ResendButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ email: { status: string; lastError: string | null } }>(`/api/admin/emails/${id}/resend`, { method: "POST" });
          if (r.email.status !== "SENT") window.alert(`Still not delivered: ${r.email.lastError ?? "will retry"}`);
        } catch (err) {
          window.alert((err as ApiError).message);
        }
        router.refresh();
        setBusy(false);
      }}
    >
      {busy ? "Sending…" : "Send now"}
    </button>
  );
}
