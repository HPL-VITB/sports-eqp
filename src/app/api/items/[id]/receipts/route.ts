import { receiveStockHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  return receiveStockHandler(getAppContext(), req, (await ctx.params).id);
}
