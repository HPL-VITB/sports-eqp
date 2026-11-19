/** Dates the store works in: Indian Standard Time (UTC+05:30, no daylight saving). */
const IST_OFFSET_MS = 330 * 60_000;

/** Today's calendar date in IST, as 'YYYY-MM-DD'. */
export function todayIST(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/** '2026-11-20' -> '20 Nov 2026' */
export function formatDate(date: string): string {
  return dateFmt.format(new Date(`${date}T00:00:00Z`));
}

export function formatDateTimeIST(d: Date): string {
  return dateTimeFmt.format(d);
}
