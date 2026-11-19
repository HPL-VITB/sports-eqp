import { returnIssueHandler } from "@/server/http/return-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  return returnIssueHandler(getAppContext(), req, (await ctx.params).id);
}
