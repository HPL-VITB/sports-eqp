/** Dashboard and report API handlers (Phase 7). GET only: nothing here changes data. */
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { getDashboard } from "../reports/dashboard";
import { exportReport, reportsFor, runReport } from "../reports/reports";
import { clientIp, handle, json, requireUser } from "./handlers";

export const dashboardHandler = handle(async (ctx, req) => json({ dashboard: await getDashboard(ctx, await requireUser(ctx, req)) }));

export const listReportsHandler = handle(async (ctx, req) => json({ reports: reportsFor(await requireUser(ctx, req)) }));

/** GET /api/reports/:key?format=json|xlsx|pdf&from=…&to=…  */
export function reportHandler(ctx: AppContext, req: Request, key: string) {
  return handle(async (c, r) => {
    const user = await requireUser(c, r);
    const params = Object.fromEntries(new URL(r.url).searchParams);
    const { format = "json", ...filters } = params;
    if (format === "json") return json({ report: await runReport(c, user, key, filters) });
    if (format !== "xlsx" && format !== "pdf") throw new AppError(400, "VALIDATION", "Format must be xlsx or pdf.");
    const out = await exportReport(c, user, key, format, filters, clientIp(r));
    return new Response(new Blob([out.bytes as Uint8Array<ArrayBuffer>]), {
      headers: {
        "content-type": out.contentType,
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  })(ctx, req);
}
