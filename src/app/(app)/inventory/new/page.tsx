import Link from "next/link";
import { listCategories, listLocations, listSports } from "@/server/inventory/masterdata";
import { requirePermissionPage } from "@/server/next-session";
import { getAppContext } from "@/server/runtime";
import { ItemForm } from "../ItemForm";

export const dynamic = "force-dynamic";

export default async function NewItemPage() {
  const user = await requirePermissionPage("item.manage");
  const ctx = getAppContext();
  const [sports, categories, locations] = await Promise.all([listSports(ctx, user), listCategories(ctx, user), listLocations(ctx, user)]);
  return (
    <>
      <p><Link href="/inventory">← Inventory</Link></p>
      <h1>Add equipment</h1>
      <p className="muted">
        Use this for equipment that is not yet in the portal. To add more of an existing item, open it and use Receive stock.
        The item code is created automatically.
      </p>
      <ItemForm
        sports={sports.map((s) => ({ id: s.id, name: s.name }))}
        categories={categories.map((c) => ({ id: c.id, sportId: c.sport_id, name: c.name }))}
        locations={locations.map((l) => ({ id: l.id, name: l.path }))}
      />
    </>
  );
}
