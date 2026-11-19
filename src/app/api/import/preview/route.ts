import { importPreviewHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return importPreviewHandler(getAppContext(), req);
}
