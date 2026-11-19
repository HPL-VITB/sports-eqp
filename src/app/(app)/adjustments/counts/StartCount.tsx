"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

type Opt = { id: string; name: string };

export function StartCount({ sports, categories, locations }: { sports: Opt[]; categories: Opt[]; locations: Opt[] }) {
  const router = useRouter();
  const [scopeType, setScopeType] = useState("SPORT");
  const [scopeId, setScopeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = scopeType === "SPORT" ? sports : scopeType === "CATEGORY" ? categories : scopeType === "LOCATION" ? locations : [];
  return (
    <form
      className="panel row"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api<{ count: { id: string } }>("/api/counts", { method: "POST", body: { scopeType, scopeId: scopeType === "ALL" ? null : scopeId } });
          router.push(`/adjustments/counts/${r.count.id}`);
        } catch (err) {
          setError((err as ApiError).message);
          setBusy(false);
        }
      }}
    >
      <strong>Start a count:</strong>
      <select value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(""); }} aria-label="Count by" style={{ maxWidth: 150 }}>
        <option value="SPORT">One sport</option>
        <option value="CATEGORY">One category</option>
        <option value="LOCATION">One location</option>
        <option value="ALL">Whole store</option>
      </select>
      {scopeType !== "ALL" && (
        <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="Which" style={{ maxWidth: 260 }}>
          <option value="">Choose…</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
      <button type="submit" disabled={busy || (scopeType !== "ALL" && !scopeId)}>Start</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
