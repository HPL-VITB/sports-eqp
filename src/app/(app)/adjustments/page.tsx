import Link from "next/link";
import { AdjustmentTabs } from "@/components/AdjustmentTabs";
import { can } from "@/server/auth/permissions";
import { requirePermissionPage } from "@/server/next-session";
import { listIncidents } from "@/server/returns/incidents";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";
import { ResolveIncident } from "./ResolveIncident";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  DAMAGED: "Returned damaged",
  STORE_DAMAGE: "Damaged in store",
  MISSING: "Missing",
  CONSUMED: "Used up (awaiting discard)",
};

export default async function AdjustmentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requirePermissionPage("incident.report");
  const sp = await searchParams;
  const status = sp.status === "closed" || sp.status === "all" ? sp.status : "open";
  const incidents = await listIncidents(getAppContext(), user, { status });
  const canMarkUsable = can(user.role, "damaged.markUsable");
  const canRecover = can(user.role, "return.record");
  const canDiscard = can(user.role, "discard.request");
  return (
    <>
      <h1>Adjustments & discards</h1>
      <AdjustmentTabs active="/adjustments" />
      <p className="muted">
        Units recorded at returns or found damaged in the store. Damaged units cannot be issued until marked usable. Units that cannot
        be repaired or found can be put forward for discard (FR Sports approves). No penalties are calculated.
      </p>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {(["open", "closed", "all"] as const).map((s) => (
          <Link key={s} href={`/adjustments?status=${s}`} className={s === status ? "button" : "button secondary"}>
            {s === "open" ? "Open" : s === "closed" ? "Resolved" : "All"}
          </Link>
        ))}
      </div>
      <table>
        <thead><tr><th>Reported</th><th>Type</th><th>Equipment</th><th style={{ textAlign: "right" }}>Open / total</th><th>Accountable</th><th>Details</th><th></th></tr></thead>
        <tbody>
          {incidents.map((i) => (
            <tr key={i.id}>
              <td data-label="Reported">{formatDateTimeIST(i.createdAt)}<div className="muted">{i.reportedBy}</div></td>
              <td data-label="Type">{TYPE_LABEL[i.type]}</td>
              <td data-label="Equipment"><Link href={`/inventory/${i.item.id}`}>{i.item.name}</Link> <span className="muted">{i.item.code}</span></td>
              <td data-label="Open" style={{ textAlign: "right" }}>
                {i.qtyOpen} / {i.qty}
                {i.qtyReserved > 0 && <div className="muted">{i.qtyReserved} held for discard</div>}
              </td>
              <td data-label="Accountable">
                {i.recipient ? <>{i.recipient.name} <span className="muted">{i.recipient.univId}</span></> : <span className="muted">—</span>}
                {i.issue && <div className="muted"><Link href={`/returns/${i.issue.id}`}>{i.issue.ref}</Link></div>}
              </td>
              <td data-label="Details">
                {i.description}
                {i.photoId && <> · <a href={`/api/photos/${i.photoId}`} target="_blank" rel="noreferrer">photo</a></>}
                {i.resolutions.map((r, n) => (
                  <div key={n} className="muted">{r.qty} {r.action.toLowerCase().replace(/_/g, " ")} by {r.by}{r.remarks ? `: ${r.remarks}` : ""}</div>
                ))}
              </td>
              <td>
                {i.qtyOpen - i.qtyReserved > 0 && (
                  <ResolveIncident
                    id={i.id}
                    itemId={i.item.id}
                    open={i.qtyOpen - i.qtyReserved}
                    actions={[
                      ...((i.type === "DAMAGED" || i.type === "STORE_DAMAGE") && canMarkUsable ? [{ value: "MARKED_USABLE", label: "Mark usable" }] : []),
                      ...(i.type === "MISSING" && canRecover
                        ? [{ value: "RECOVERED_USABLE", label: "Found, usable" }, { value: "RECOVERED_DAMAGED", label: "Found, damaged" }]
                        : []),
                      ...(i.type !== "CONSUMED" && canDiscard ? [{ value: "DISCARD", label: "Request discard" }] : []),
                    ]}
                  />
                )}
              </td>
            </tr>
          ))}
          {incidents.length === 0 && <tr><td colSpan={7} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
