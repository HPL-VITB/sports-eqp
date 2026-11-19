import Link from "next/link";

const TABS = [
  { href: "/adjustments", label: "Damage & missing" },
  { href: "/adjustments/discards", label: "Discards" },
  { href: "/adjustments/corrections", label: "Corrections" },
  { href: "/adjustments/counts", label: "Stock counts" },
];

export function AdjustmentTabs({ active, pending }: { active: string; pending?: Record<string, number> }) {
  return (
    <div className="row" style={{ marginBottom: "0.75rem" }}>
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={t.href === active ? "button" : "button secondary"}>
          {t.label}
          {pending?.[t.href] ? ` (${pending[t.href]} pending)` : ""}
        </Link>
      ))}
    </div>
  );
}
