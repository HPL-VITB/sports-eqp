import Link from "next/link";
import { AdjustmentTabs } from "@/components/AdjustmentTabs";
import { CancelLink, DecideButtons } from "@/components/DecideButtons";
import { listCorrections } from "@/server/adjustments/corrections";
import { can } from "@/server/auth/permissions";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";

export const dynamic = "force-dynamic";

export default async function CorrectionsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requirePermissionPage("incident.report");
  const sp = await searchParams;
  const status = sp.status === "ALL" ? undefined : (sp.status ?? "PENDING");
  const list = await listCorrections(getAppContext(), user, { status });
  const canDecide = can(user.role, "adjustment.approve");
  return (
    <>
      <h1>Adjustments & discards</h1>
      <AdjustmentTabs active="/adjustments/corrections" />
      <p className="muted">
        A correction records the difference between the system and a physical count. FR Sports approval applies the difference (not
        the counted total), so issues and returns made in between are not lost. Raise one from an item page or a stock count.
      </p>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        {["PENDING", "APPROVED", "REJECTED", "ALL"].map((s) => (
          <Link key={s} href={`/adjustments/corrections?status=${s}`} className={(sp.status ?? "PENDING") === s ? "button" : "button secondary"}>
            {s[0] + s.slice(1).toLowerCase()}
          </Link>
        ))}
      </div>
      <table>
        <thead><tr><th>Requested</th><th>Equipment</th><th>Stock</th><th style={{ textAlign: "right" }}>System → counted</th><th style={{ textAlign: "right" }}>Change</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td data-label="Requested">{formatDateTimeIST(c.createdAt)}<div className="muted">{c.requestedBy}</div></td>
              <td data-label="Equipment"><Link href={`/inventory/${c.item.id}`}>{c.item.name}</Link> <span className="muted">{c.item.code}</span></td>
              <td data-label="Stock">{c.state === "AVAILABLE" ? "Usable" : "Damaged"}</td>
              <td data-label="Counted" style={{ textAlign: "right" }}>{c.expected} → {c.counted}</td>
              <td data-label="Change" style={{ textAlign: "right", fontWeight: 600 }} className={c.delta < 0 ? "error" : undefined}>{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
              <td data-label="Reason">{c.reason}{c.fromCount && <> · <Link href={`/adjustments/counts/${c.fromCount}`}>count #{c.fromCount}</Link></>}</td>
              <td data-label="Status">
                {c.status[0] + c.status.slice(1).toLowerCase()}
                {c.decidedBy && c.status !== "CANCELLED" && <div className="muted">{c.decidedBy}{c.decisionNote ? `: ${c.decisionNote}` : ""}</div>}
              </td>
              <td>
                {c.status === "PENDING" && canDecide && c.requestedById !== user.id && (
                  <DecideButtons path={`/api/corrections/${c.id}/decide`} summary={`${c.delta > 0 ? "+" : ""}${c.delta} ${c.state === "AVAILABLE" ? "usable" : "damaged"} ${c.item.name}`} />
                )}
                {c.status === "PENDING" && c.requestedById === user.id && <CancelLink path={`/api/corrections/${c.id}/cancel`} />}
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={8} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
