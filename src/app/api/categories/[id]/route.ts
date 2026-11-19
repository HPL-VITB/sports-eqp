import { updateCategoryHandler } from "@/server/http/inventory-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  return updateCategoryHandler(getAppContext(), req, (await ctx.params).id);
}
