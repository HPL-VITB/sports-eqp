"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import type { CatalogItem } from "@/server/requests/requests";

type Opt = { id: string; name: string };

export function BrowseRequest({ sports, minDate, maxDate, defaultDate }: { sports: Opt[]; minDate: string; maxDate: string; defaultDate: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sportId, setSportId] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [basket, setBasket] = useState<Map<string, { item: CatalogItem; qty: number }>>(new Map());
  const [purpose, setPurpose] = useState("");
  const [groupName, setGroupName] = useState("");
  const [expectedReturn, setExpectedReturn] = useState(defaultDate);
  const [key] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (sportId) p.set("sportId", sportId);
    const t = setTimeout(() => {
      api<{ items: CatalogItem[] }>(`/api/catalog?${p}`).then((d) => setItems(d.items)).catch((e: ApiError) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, sportId]);

  function setQty(item: CatalogItem, qty: number) {
    setBasket((b) => {
      const next = new Map(b);
      if (qty <= 0) next.delete(item.id);
      else next.set(item.id, { item, qty: Math.min(qty, item.available) });
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/requests", {
        method: "POST",
        body: {
          lines: [...basket.values()].map((b) => ({ itemId: b.item.id, qty: b.qty })),
          purpose,
          groupName: groupName || null,
          expectedReturn,
          idempotencyKey: key,
        },
      });
      router.push("/my?sent=1");
      router.refresh();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  const lines = [...basket.values()];
  return (
    <>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <input style={{ maxWidth: 280 }} placeholder="Search equipment…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select style={{ maxWidth: 200 }} value={sportId} onChange={(e) => setSportId(e.target.value)} aria-label="Sport">
          <option value="">All sports</option>
          {sports.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <table>
        <thead>
          <tr><th>Equipment</th><th>Sport</th><th style={{ textAlign: "right" }}>Available</th><th style={{ width: 150 }}>Quantity</th></tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const inBasket = basket.get(i.id)?.qty ?? 0;
            return (
              <tr key={i.id}>
                <td data-label="Equipment">{i.name}{[i.brand, i.size].filter(Boolean).length > 0 && <span className="muted"> · {[i.brand, i.size].filter(Boolean).join(" ")}</span>}</td>
                <td data-label="Sport">{i.sport.name} › {i.category}</td>
                <td data-label="Available" style={{ textAlign: "right" }}>{i.available} {i.unit}{i.available === 1 ? "" : "s"}</td>
                <td data-label="Quantity">
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <button type="button" className="secondary" onClick={() => setQty(i, inBasket - 1)} disabled={inBasket === 0} aria-label={`Fewer ${i.name}`}>−</button>
                    <span style={{ minWidth: 28, textAlign: "center" }}>{inBasket}</span>
                    <button type="button" className="secondary" onClick={() => setQty(i, inBasket + 1)} disabled={inBasket >= i.available} aria-label={`More ${i.name}`}>+</button>
                  </div>
                </td>
              </tr>
            );
          })}
          {items.length === 0 && <tr><td colSpan={4} className="muted">Nothing available matches your search.</td></tr>}
        </tbody>
      </table>

      <form onSubmit={submit} className="panel" style={{ position: "sticky", bottom: 0 }}>
        <strong>Your request</strong>
        {lines.length === 0 ? (
          <p className="muted">No items yet. Use + to add equipment.</p>
        ) : (
          <p>{lines.map((l) => `${l.qty} × ${l.item.name}`).join(", ")}</p>
        )}
        <div className="grid2">
          <div>
            <label htmlFor="purpose">Purpose</label>
            <input id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Inter-hostel cricket practice" required />
          </div>
          <div>
            <label htmlFor="group">For a team / house / hostel / event (optional)</label>
            <input id="group" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="You remain responsible for the return" />
          </div>
          <div>
            <label htmlFor="ret">I will return it by</label>
            <input id="ret" type="date" min={minDate} max={maxDate} value={expectedReturn} onChange={(e) => setExpectedReturn(e.target.value)} required />
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || lines.length === 0 || purpose.trim().length < 3} style={{ marginTop: "0.75rem" }}>
          {busy ? "Sending…" : "Send request"}
        </button>
      </form>
    </>
  );
}
