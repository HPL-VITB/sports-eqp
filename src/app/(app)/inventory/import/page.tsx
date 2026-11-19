import Link from "next/link";
import { requirePermissionPage } from "@/server/next-session";
import { ImportWizard } from "./ImportWizard";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requirePermissionPage("stock.receive");
  return (
    <>
      <p><Link href="/inventory">← Inventory</Link></p>
      <h1>Import stock from Excel</h1>
      <ol className="muted">
        <li><a href="/api/import/template">Download the template</a> (it lists current sports, categories, units and locations).</li>
        <li>Fill one row per equipment type. For equipment already in the portal you can enter just its item code and quantity.</li>
        <li>Upload it. You will see exactly what each row will do. Nothing changes until you confirm, and if any row has an error, nothing is imported.</li>
      </ol>
      <ImportWizard />
    </>
  );
}
