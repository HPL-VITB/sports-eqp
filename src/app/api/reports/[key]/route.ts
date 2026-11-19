import { reportHandler } from "@/server/http/report-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  return reportHandler(getAppContext(), req, (await ctx.params).key);
}
