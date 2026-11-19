import { getCountHandler, saveCountHandler } from "@/server/http/adjustment-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return getCountHandler(getAppContext(), req, (await ctx.params).id);
}

export async function PUT(req: Request, ctx: Ctx) {
  return saveCountHandler(getAppContext(), req, (await ctx.params).id);
}
