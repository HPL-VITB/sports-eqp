import { listDiscardsHandler, requestDiscardHandler } from "@/server/http/adjustment-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listDiscardsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return requestDiscardHandler(getAppContext(), req);
}
