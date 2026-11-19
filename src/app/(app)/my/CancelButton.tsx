"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export function CancelButton({ id, refText }: { id: string; refText: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(`Cancel request ${refText}?`)) return;
        setBusy(true);
        try {
          await api(`/api/requests/${id}/cancel`, { method: "POST" });
        } catch (err) {
          window.alert((err as ApiError).message);
        }
        router.refresh();
        setBusy(false);
      }}
    >
      Cancel
    </button>
  );
}
