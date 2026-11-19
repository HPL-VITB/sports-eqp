import { listCountsHandler, startCountHandler } from "@/server/http/adjustment-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listCountsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return startCountHandler(getAppContext(), req);
}
