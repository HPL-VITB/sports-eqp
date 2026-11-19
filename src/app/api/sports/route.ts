import { listSportsHandler, createSportHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return listSportsHandler(getAppContext(), req);
}

export function POST(req: Request) {
  return createSportHandler(getAppContext(), req);
}
