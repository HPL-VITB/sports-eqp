import { listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { MAX_LOAN_DAYS } from "@/server/requests/requests";
import { getAppContext } from "@/server/runtime";
import { addDays, todayIST } from "@/server/time";
import { BrowseRequest } from "./BrowseRequest";

export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const user = await requirePermissionPage("request.create");
  const ctx = getAppContext();
  const sports = await listSports(ctx, user);
  const today = todayIST(ctx.now());
  return (
    <>
      <h1>Browse & request equipment</h1>
      <p className="muted">
        Choose items and quantities, then send the request. Collect the equipment from the sports store once it is approved.
      </p>
      <BrowseRequest
        sports={sports.map((s) => ({ id: s.id, name: s.name }))}
        minDate={today}
        maxDate={addDays(today, MAX_LOAN_DAYS)}
        defaultDate={addDays(today, 1)}
      />
    </>
  );
}
