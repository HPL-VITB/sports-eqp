import { listRequestsHandler, createRequestHandler } from "@/server/http/request-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listRequestsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return createRequestHandler(getAppContext(), req);
}
