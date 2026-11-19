import { getReminderSettingsHandler, updateReminderSettingsHandler } from "@/server/http/return-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return getReminderSettingsHandler(getAppContext(), req);
}

export function PUT(req: Request) {
  return updateReminderSettingsHandler(getAppContext(), req);
}
