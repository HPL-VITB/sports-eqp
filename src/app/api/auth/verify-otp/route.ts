import { verifyOtpHandler } from "@/server/http/handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return verifyOtpHandler(getAppContext(), req);
}
