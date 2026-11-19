import { healthHandler } from "@/server/http/health-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return healthHandler(getAppContext(), req);
}
