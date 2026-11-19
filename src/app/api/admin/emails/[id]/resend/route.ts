import { resendEmailHandler } from "@/server/http/request-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  return resendEmailHandler(getAppContext(), req, (await ctx.params).id);
}
