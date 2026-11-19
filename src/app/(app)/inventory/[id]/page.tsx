import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { getItem } from "@/server/inventory/items";
import { listCategories, listLocations, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { ItemForm } from "../ItemForm";
import { ReceiveStock } from "./ReceiveStock";
import { ReportDamage } from "./ReportDamage";
import { ReverseButton, StockActions } from "./StockActions";

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const TYPE_LABEL: Record<string, string> = {
  OPENING: "Opening stock",
  RECEIPT: "Stock received",
  ISSUE: "Issued",
  RETURN_USABLE: "Returned usable",
  RETURN_DAMAGED: "Returned damaged",
  RETURN_MISSING: "Recorded missing",
  STORE_DAMAGE: "Damage found in store",
  MARK_USABLE: "Marked usable",
  RECOVERED: "Recovered",
  DISCARD: "Discarded",
  CORRECTION: "Correction",
  REVERSAL: "Reversal",
};

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; created?: string }>;
}) {
  const user = await requirePermissionPage("inventory.view");
  const { id } = await params;
  const sp = await searchParams;
  const ctx = getAppContext();
  let data;
  try {
    data = await getItem(ctx, user, id, { movementsBefore: sp.before });
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const { item, movements } = data;
  const canEdit = can(user.role, "item.manage");
  const canReverse = can(user.role, "movement.reverse");
  const lists = canEdit
    ? await Promise.all([listSports(ctx, user), listCategories(ctx, user), listLocations(ctx, user)])
    : null;
  const s = item.stock;
  const last = movements.at(-1);

  return (
    <>
      <p><Link href="/inventory">← Inventory</Link></p>
      {sp.created && <p className="success" role="status">Created {item.code}.</p>}
      <h1>
        {item.name} <span className="muted" style={{ fontWeight: 400 }}>{item.code}</span>
      </h1>
      <p className="muted">
        {item.sport.name} › {item.category.name}
        {[item.brand, item.model, item.size].filter(Boolean).length > 0 && ` · ${[item.brand, item.model, item.size].filter(Boolean).join(" · ")}`}
        {item.spec && ` · ${item.spec}`} · stored at {item.location.name} · counted in {item.unit}s
        {item.isConsumable && " · consumable"}
        {!item.isActive && " · DEACTIVATED"}
      </p>

      <div className="stats">
        <div className="stat"><span className="muted">Available to issue</span><b>{s.availableToIssue}</b></div>
        <div className="stat"><span className="muted">Issued</span><b>{s.issued}</b></div>
        <div className="stat"><span className="muted">Damaged</span><b>{s.damaged}</b></div>
        <div className="stat"><span className="muted">Missing</span><b>{s.missing}</b></div>
        <div className="stat"><span className="muted">Total accountable</span><b>{s.accountable}</b></div>
        <div className="stat"><span className="muted">Discarded (history)</span><b>{s.discarded}</b></div>
      </div>
      {item.lowStock && <p className="error">Below the minimum stock of {item.minStock}.</p>}

      {can(user.role, "stock.receive") && item.isActive && <ReceiveStock itemId={item.id} unit={item.unit} available={s.available} />}
      {can(user.role, "incident.report") && s.availableToIssue > 0 && <ReportDamage itemId={item.id} unit={item.unit} available={s.availableToIssue} />}
      {can(user.role, "adjustment.request") && (
        <StockActions itemId={item.id} unit={item.unit} availableToIssue={s.availableToIssue} available={s.available} damaged={s.damaged} />
      )}
      {s.reserved > 0 && <p className="muted">{s.reserved} unit(s) held by a pending discard request.</p>}

      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>When (IST)</th>
            <th>What</th>
            <th style={{ textAlign: "right" }}>Qty</th>
            <th style={{ textAlign: "right" }}>Available before → after</th>
            <th>By</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id}>
              <td data-label="When">{fmt.format(new Date(m.createdAt))}</td>
              <td data-label="What">{TYPE_LABEL[m.type] ?? m.type}{m.source ? ` (${m.source})` : ""}</td>
              <td data-label="Qty" style={{ textAlign: "right" }}>{m.qty}</td>
              <td data-label="Available" style={{ textAlign: "right" }}>{m.before.available} → {m.after.available}</td>
              <td data-label="By">{m.actor ?? "System"}</td>
              <td data-label="Remarks">
                {m.remarks}
                {m.reversed && <span className="badge"> reversed</span>}
                {canReverse && !m.reversed && (m.type === "RECEIPT" || m.type === "OPENING") && <> <ReverseButton movementId={m.id} qty={m.qty} /></>}
              </td>
            </tr>
          ))}
          {movements.length === 0 && <tr><td colSpan={6} className="muted">No stock movements yet.</td></tr>}
        </tbody>
      </table>
      {movements.length === 50 && last && (
        <p style={{ marginTop: "0.5rem" }}><a href={`/inventory/${item.id}?before=${last.id}`}>Older history →</a></p>
      )}

      {canEdit && lists && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary>Edit details</summary>
          <ItemForm
            item={item}
            sports={lists[0].map((x) => ({ id: x.id, name: x.name }))}
            categories={lists[1].map((c) => ({ id: c.id, sportId: c.sport_id, name: c.name }))}
            locations={lists[2].map((l) => ({ id: l.id, name: l.path }))}
          />
        </details>
      )}
    </>
  );
}
