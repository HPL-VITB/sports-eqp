"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { newRequestKey } from "@/lib/idempotency";
import type { ItemView } from "@/server/inventory/items";

type Opt = { id: string; name: string };
const UNITS = ["piece", "pair", "set", "box", "dozen", "tube", "roll", "metre", "pack"];

/** Create (no `item`) or edit (with `item`). Sport, category and code cannot change after creation. */
export function ItemForm({
  sports,
  categories,
  locations,
  item,
}: {
  sports: Opt[];
  categories: (Opt & { sportId: string })[];
  locations: Opt[];
  item?: ItemView;
}) {
  const router = useRouter();
  const editing = Boolean(item);
  const [f, setF] = useState({
    sportId: item?.sport.id ?? "",
    categoryId: item?.category.id ?? "",
    name: item?.name ?? "",
    brand: item?.brand ?? "",
    model: item?.model ?? "",
    size: item?.size ?? "",
    spec: item?.spec ?? "",
    unit: item?.unit ?? "piece",
    locationId: item?.location.id ?? locations[0]?.id ?? "",
    minStock: item?.minStock?.toString() ?? "",
    isConsumable: item?.isConsumable ?? false,
    openingQty: "0",
  });
  const [key] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; itemId?: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const cats = useMemo(() => categories.filter((c) => c.sportId === f.sportId), [categories, f.sportId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const minStock = f.minStock.trim() === "" ? null : Number(f.minStock);
    if (!editing && !window.confirm(`Create "${f.name}" with ${f.openingQty || 0} ${f.unit}(s) in stock?`)) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api(`/api/items/${item!.id}`, {
          method: "PATCH",
          body: { name: f.name, brand: f.brand, model: f.model, size: f.size, spec: f.spec, unit: f.unit, locationId: f.locationId, minStock, isConsumable: f.isConsumable },
        });
        router.refresh();
        setBusy(false);
      } else {
        const r = await api<{ item: ItemView }>("/api/items", {
          method: "POST",
          body: { ...f, minStock, openingQty: Number(f.openingQty || 0), idempotencyKey: key },
        });
        router.push(`/inventory/${r.item.id}?created=1`);
      }
    } catch (err) {
      const ae = err as ApiError;
      setError({ message: ae.message, itemId: typeof ae.data.itemId === "string" ? ae.data.itemId : undefined });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel">
      <div className="grid2">
        <div>
          <label htmlFor="sport">Sport</label>
          <select id="sport" value={f.sportId} onChange={(e) => setF((x) => ({ ...x, sportId: e.target.value, categoryId: "" }))} disabled={editing} required>
            <option value="" disabled>Select…</option>
            {sports.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="category">Category</label>
          <select id="category" value={f.categoryId} onChange={set("categoryId")} disabled={editing || !f.sportId} required>
            <option value="" disabled>{f.sportId && cats.length === 0 ? "No categories — ask FR Sports" : "Select…"}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="name">Equipment name</label>
      <input id="name" value={f.name} onChange={set("name")} placeholder="e.g. Leather cricket ball" required />
      <div className="grid2">
        <div><label htmlFor="brand">Brand</label><input id="brand" value={f.brand} onChange={set("brand")} /></div>
        <div><label htmlFor="model">Model</label><input id="model" value={f.model} onChange={set("model")} /></div>
        <div><label htmlFor="size">Size</label><input id="size" value={f.size} onChange={set("size")} /></div>
        <div>
          <label htmlFor="unit">Unit</label>
          <select id="unit" value={f.unit} onChange={set("unit")}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
        </div>
      </div>
      <label htmlFor="spec">Specification</label>
      <input id="spec" value={f.spec} onChange={set("spec")} placeholder="Optional" />
      <div className="grid2">
        <div>
          <label htmlFor="location">Storage location</label>
          <select id="location" value={f.locationId} onChange={set("locationId")} required>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="min">Minimum stock (optional)</label>
          <input id="min" inputMode="numeric" value={f.minStock} onChange={set("minStock")} placeholder="Warn below this" />
        </div>
        {!editing && (
          <div>
            <label htmlFor="qty">Quantity in stock now</label>
            <input id="qty" inputMode="numeric" value={f.openingQty} onChange={set("openingQty")} required />
          </div>
        )}
      </div>
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={f.isConsumable} onChange={set("isConsumable")} />
        Consumable (shuttlecocks, grip tape…) — may be recorded as used up at return, with FR Sports approval
      </label>
      {error && (
        <p className="error" role="alert">
          {error.message} {error.itemId && <a href={`/inventory/${error.itemId}`}>Open it</a>}
        </p>
      )}
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create equipment"}</button>
      </div>
    </form>
  );
}
