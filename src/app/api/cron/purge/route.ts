import { purgeHandler } from "@/server/http/handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return purgeHandler(getAppContext(), req);
}
