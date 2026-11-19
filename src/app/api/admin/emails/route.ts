import { listEmailsHandler } from "@/server/http/request-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listEmailsHandler(getAppContext(), req);
}
