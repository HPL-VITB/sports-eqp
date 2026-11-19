import Link from "next/link";
import { AdjustmentTabs } from "@/components/AdjustmentTabs";
import { CancelLink, DecideButtons } from "@/components/DecideButtons";
import { DISCARD_REASON_LABELS, listDiscards } from "@/server/adjustments/discards";
import { can } from "@/server/auth/permissions";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";

export const dynamic = "force-dynamic";

const FROM: Record<string, string> = { AVAILABLE: "in store", DAMAGED: "damaged", MISSING: "missing" };

export default async function DiscardsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requirePermissionPage("incident.report");
  const sp = await searchParams;
  const status = sp.status === "ALL" ? undefined : (sp.status ?? "PENDING");
  const list = await listDiscards(getAppContext(), user, { status });
  const canDecide = can(user.role, "discard.approve");
  return (
    <>
      <h1>Adjustments & discards</h1>
      <AdjustmentTabs active="/adjustments/discards" />
      <p className="muted">
        Discards need FR Sports approval. Units in a pending request are held: they cannot be issued, marked usable or recovered.
        Equipment on issue cannot be discarded. To request a discard, open the item (units in store) or a damage / missing record.
      </p>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {["PENDING", "APPROVED", "REJECTED", "ALL"].map((s) => (
          <Link key={s} href={`/adjustments/discards?status=${s}`} className={(sp.status ?? "PENDING") === s ? "button" : "button secondary"}>
            {s[0] + s.slice(1).toLowerCase()}
          </Link>
        ))}
      </div>
      <table>
        <thead><tr><th>Requested</th><th>Equipment</th><th style={{ textAlign: "right" }}>Qty</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {list.map((d) => (
            <tr key={d.id}>
              <td data-label="Requested">{formatDateTimeIST(d.createdAt)}<div className="muted">{d.auto ? "Automatic (used up at return)" : d.requestedBy}</div></td>
              <td data-label="Equipment"><Link href={`/inventory/${d.item.id}`}>{d.item.name}</Link> <span className="muted">{d.item.code} · {FROM[d.fromState]}{d.issueRef ? ` · ${d.issueRef}` : ""}</span></td>
              <td data-label="Qty" style={{ textAlign: "right" }}>{d.qty}</td>
              <td data-label="Reason">{DISCARD_REASON_LABELS[d.reason as keyof typeof DISCARD_REASON_LABELS]}{d.details ? `: ${d.details}` : ""}</td>
              <td data-label="Status">
                {d.status[0] + d.status.slice(1).toLowerCase()}
                {d.decidedBy && <div className="muted">{d.decidedBy}{d.decisionNote ? `: ${d.decisionNote}` : ""}</div>}
              </td>
              <td>
                {d.status === "PENDING" && canDecide && d.requestedById !== user.id && (
                  <DecideButtons path={`/api/discards/${d.id}/decide`} summary={`discard ${d.qty} × ${d.item.name}`} />
                )}
                {d.status === "PENDING" && d.requestedById === user.id && <CancelLink path={`/api/discards/${d.id}/cancel`} />}
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
