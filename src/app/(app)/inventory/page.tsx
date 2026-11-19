import Link from "next/link";
import { can } from "@/server/auth/permissions";
import { listCategories, listLocations, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { InventoryList } from "./InventoryList";

export const dynamic = "force-dynamic";

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ lowStock?: string; sportId?: string }> }) {
  const sp = await searchParams;
  const user = await requirePermissionPage("inventory.view");
  const ctx = getAppContext();
  const [sports, categories, locations] = await Promise.all([
    listSports(ctx, user),
    listCategories(ctx, user),
    listLocations(ctx, user),
  ]);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h1 style={{ margin: 0 }}>Inventory</h1>
        <div className="row">
          {can(user.role, "item.manage") && (
            <Link className="button" href="/inventory/new">Add equipment</Link>
          )}
          {can(user.role, "stock.receive") && (
            <Link className="button secondary" href="/inventory/import">Import from Excel</Link>
          )}
        </div>
      </div>
      <InventoryList
        sports={sports.map((s) => ({ id: s.id, name: s.name }))}
        categories={categories.map((c) => ({ id: c.id, sportId: c.sport_id, name: c.name }))}
        locations={locations.map((l) => ({ id: l.id, name: l.path }))}
        initialLowStock={sp.lowStock === "1"}
        initialSportId={sp.sportId ?? ""}
      />
    </>
  );
}
