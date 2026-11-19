import { listCategories, listLocations, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { MasterData } from "./MasterData";

export const dynamic = "force-dynamic";

export default async function MasterDataPage() {
  const user = await requirePermissionPage("masterdata.manage");
  const ctx = getAppContext();
  const [sports, categories, locations] = await Promise.all([
    listSports(ctx, user, { includeInactive: true }),
    listCategories(ctx, user, { includeInactive: true }),
    listLocations(ctx, user, { includeInactive: true }),
  ]);
  return (
    <>
      <h1>Sports, categories & locations</h1>
      <p className="muted">
        Codes are created once and never change, because equipment codes are built from them (e.g. CRI-BAL-0001). Deactivate
        instead of deleting.
      </p>
      <MasterData sports={sports} categories={categories} locations={locations} />
    </>
  );
}
