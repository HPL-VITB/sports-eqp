import { listItemsHandler, createItemHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listItemsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return createItemHandler(getAppContext(), req);
}
