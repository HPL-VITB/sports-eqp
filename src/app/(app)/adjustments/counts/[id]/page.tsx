import Link from "next/link";
import { notFound } from "next/navigation";
import { getCount } from "@/server/adjustments/verification";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { formatDateTimeIST } from "@/server/time";
import { CountSheet } from "./CountSheet";

export const dynamic = "force-dynamic";

export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermissionPage("incident.report");
  const { id } = await params;
  let c;
  try {
    c = await getCount(getAppContext(), user, id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const diff = (counted: number | null, expected: number) => (counted === null ? null : counted - expected);
  return (
    <>
      <p><Link href="/adjustments/counts">← Stock counts</Link></p>
      <h1>Count #{c.id}: {c.label}</h1>
      <p className="muted">
        Started {formatDateTimeIST(c.startedAt)} by {c.startedBy}.
        {c.submittedAt && ` Submitted ${formatDateTimeIST(c.submittedAt)} by ${c.submittedBy}.`}
      </p>
      {c.status === "OPEN" && can(user.role, "verification.count") ? (
        <CountSheet id={c.id} lines={c.lines} />
      ) : (
        <>
          <h2>Verification report</h2>
          <table>
            <thead>
              <tr>
                <th>Equipment</th><th style={{ textAlign: "right" }}>Expected on shelf (usable + damaged)</th><th style={{ textAlign: "right" }}>Counted</th>
                <th style={{ textAlign: "right" }}>Difference</th><th style={{ textAlign: "right" }}>Issued (not counted)</th><th>Correction</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => {
                const du = diff(l.countedUsable, l.expectedUsable);
                const dd = diff(l.countedDamaged, l.expectedDamaged);
                return (
                  <tr key={l.lineId}>
                    <td data-label="Equipment">{l.item.name} <span className="muted">{l.item.code}</span></td>
                    <td data-label="Expected" style={{ textAlign: "right" }}>{l.expectedUsable} + {l.expectedDamaged}</td>
                    <td data-label="Counted" style={{ textAlign: "right" }}>{l.countedUsable ?? "—"} + {l.countedDamaged ?? "—"}</td>
                    <td data-label="Difference" style={{ textAlign: "right" }} className={du || dd ? "error" : undefined}>
                      {du || dd ? [du ? `${du > 0 ? "+" : ""}${du} usable` : "", dd ? `${dd > 0 ? "+" : ""}${dd} damaged` : ""].filter(Boolean).join(", ") : "None"}
                    </td>
                    <td data-label="Issued" style={{ textAlign: "right" }}>{l.issued}</td>
                    <td data-label="Correction">{l.correction.map((x) => `${x.delta > 0 ? "+" : ""}${x.delta} ${x.state === "AVAILABLE" ? "usable" : "damaged"}: ${x.status.toLowerCase()}`).join("; ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {c.status === "SUBMITTED" && <p style={{ marginTop: "0.75rem" }}><Link href="/adjustments/corrections">Corrections waiting for FR Sports →</Link></p>}
        </>
      )}
    </>
  );
}
