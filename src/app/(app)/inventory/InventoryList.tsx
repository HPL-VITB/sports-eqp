"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ItemView } from "@/server/inventory/items";

type Opt = { id: string; name: string };

export function InventoryList({
  sports,
  categories,
  locations,
  initialLowStock = false,
  initialSportId = "",
}: {
  sports: Opt[];
  categories: (Opt & { sportId: string })[];
  locations: Opt[];
  initialLowStock?: boolean;
  initialSportId?: string;
}) {
  const [q, setQ] = useState("");
  const [sportId, setSportId] = useState(initialSportId);
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lowStock, setLowStock] = useState(initialLowStock);
  const [status, setStatus] = useState("active");
  const [data, setData] = useState<{ items: ItemView[]; total: number; sums: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    const p = new URLSearchParams({ status, limit: String(limit) });
    if (q.trim()) p.set("q", q.trim());
    if (sportId) p.set("sportId", sportId);
    if (categoryId) p.set("categoryId", categoryId);
    if (locationId) p.set("locationId", locationId);
    if (lowStock) p.set("lowStock", "1");
    const t = setTimeout(() => {
      api<{ items: ItemView[]; total: number; sums: Record<string, number> }>(`/api/items?${p}`)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: ApiError) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, sportId, categoryId, locationId, lowStock, status, limit]);

  const cats = categories.filter((c) => !sportId || c.sportId === sportId);

  return (
    <>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <input style={{ maxWidth: 280 }} placeholder="Search name, code, brand…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select style={{ maxWidth: 170 }} value={sportId} onChange={(e) => { setSportId(e.target.value); setCategoryId(""); }} aria-label="Sport">
          <option value="">All sports</option>
          {sports.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select style={{ maxWidth: 170 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {locations.length > 1 && (
          <select style={{ maxWidth: 200 }} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
            <option value="">All locations</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <select style={{ maxWidth: 130 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
          <option value="all">All</option>
        </select>
        <label className="row" style={{ fontWeight: 400, margin: 0 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={lowStock} onChange={(e) => setLowStock(e.target.checked)} /> Low stock only
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <p className="muted">
          {data.total} item{data.total === 1 ? "" : "s"} · available {data.sums.available} · issued {data.sums.issued} · damaged {data.sums.damaged} · missing {data.sums.missing}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Equipment</th>
            <th>Sport / category</th>
            <th style={{ textAlign: "right" }}>Available</th>
            <th style={{ textAlign: "right" }}>Issued</th>
            <th style={{ textAlign: "right" }}>Damaged</th>
            <th style={{ textAlign: "right" }}>Missing</th>
            <th style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((i) => (
            <tr key={i.id}>
              <td data-label="Code"><Link href={`/inventory/${i.id}`}>{i.code}</Link></td>
              <td data-label="Equipment">
                <Link href={`/inventory/${i.id}`}>{i.name}</Link>
                {[i.brand, i.model, i.size].filter(Boolean).length > 0 && <span className="muted"> · {[i.brand, i.model, i.size].filter(Boolean).join(" ")}</span>}
                {i.lowStock && <> <span className="badge" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Low</span></>}
                {!i.isActive && <> <span className="badge">Deactivated</span></>}
              </td>
              <td data-label="Sport">{i.sport.name} › {i.category.name}</td>
              <td data-label="Available" style={{ textAlign: "right", fontWeight: 600 }}>{i.stock.availableToIssue} <span className="muted">{i.unit}</span></td>
              <td data-label="Issued" style={{ textAlign: "right" }}>{i.stock.issued}</td>
              <td data-label="Damaged" style={{ textAlign: "right" }}>{i.stock.damaged}</td>
              <td data-label="Missing" style={{ textAlign: "right" }}>{i.stock.missing}</td>
              <td data-label="Total" style={{ textAlign: "right" }}>{i.stock.accountable}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && (
            <tr><td colSpan={8} className="muted">No equipment matches these filters.</td></tr>
          )}
        </tbody>
      </table>
      {data && data.total > data.items.length && (
        <p style={{ marginTop: "0.75rem" }}>
          <button type="button" className="secondary" onClick={() => setLimit((l) => Math.min(l + 100, 500))} disabled={limit >= 500}>
            Show more ({data.items.length} of {data.total})
          </button>
        </p>
      )}
    </>
  );
}
