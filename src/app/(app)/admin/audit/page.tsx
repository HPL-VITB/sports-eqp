import { listAudit } from "@/server/audit";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function summarize(before: unknown, after: unknown): string {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return "";
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => `${k}: ${String(b[k] ?? "—")} → ${String(a[k] ?? "—")}`)
    .join("; ");
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  await requirePermissionPage("audit.view");
  const sp = await searchParams;
  const rows = await listAudit(getAppContext().db, {
    limit: 100,
    beforeId: sp.before && /^\d+$/.test(sp.before) ? sp.before : undefined,
  });
  const last = rows.at(-1);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Newest first. Entries can never be edited or deleted.</p>
      <table>
        <thead>
          <tr>
            <th>When (IST)</th>
            <th>Who</th>
            <th>Action</th>
            <th>Record</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td data-label="When">{fmt.format(r.created_at)}</td>
              <td data-label="Who">{r.actor_name ?? r.actor_email ?? "System"}</td>
              <td data-label="Action">{r.action}</td>
              <td data-label="Record">
                {r.entity} {r.entity_id ? `#${r.entity_id}` : ""}
              </td>
              <td data-label="Change">{summarize(r.before, r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 100 && last && (
        <p style={{ marginTop: "0.75rem" }}>
          <a href={`/admin/audit?before=${last.id}`}>Older entries →</a>
        </p>
      )}
    </>
  );
}
