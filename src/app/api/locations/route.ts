import { listLocationsHandler, createLocationHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listLocationsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return createLocationHandler(getAppContext(), req);
}
