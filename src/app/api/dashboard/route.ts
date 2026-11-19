import { dashboardHandler } from "@/server/http/report-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return dashboardHandler(getAppContext(), req);
}
