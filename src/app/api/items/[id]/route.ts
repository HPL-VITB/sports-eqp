import { getItemHandler, updateItemHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return getItemHandler(getAppContext(), req, (await ctx.params).id);
}

export async function PATCH(req: Request, ctx: Ctx) {
  return updateItemHandler(getAppContext(), req, (await ctx.params).id);
}
