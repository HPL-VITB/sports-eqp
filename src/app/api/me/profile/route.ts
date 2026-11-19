import { updateProfileHandler } from "@/server/http/handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PATCH(req: Request) {
  return updateProfileHandler(getAppContext(), req);
}
