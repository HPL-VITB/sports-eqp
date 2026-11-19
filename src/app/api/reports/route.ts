import { listReportsHandler } from "@/server/http/report-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listReportsHandler(getAppContext(), req);
}
