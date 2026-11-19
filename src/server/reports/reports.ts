/**
 * Registers (blueprint Section 18, plus stock receipts and corrections for success criteria 10 and 12).
 * Each report is one SQL query + a column list; the page, the Excel file and the PDF all come from the same rows,
 * so they always agree. Dates are shown and filtered in Indian Standard Time.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, type Role } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";
import { writeXlsx } from "../inventory/spreadsheet";
import { addDays, formatDate, formatDateTimeIST, isIsoDate, todayIST } from "../time";
import { writePdf } from "./pdf";

export type Cell = string | number | null;
export interface Column {
  key: string;
  label: string;
  width: number;
  align?: "left" | "right";
  total?: boolean;
}
type FilterKey = "dates" | "sport" | "category" | "itemStatus" | "issueStatus" | "incidentType" | "openClosed" | "decisionStatus" | "q";

interface ReportDef {
  key: string;
  title: string;
  description: string;
  roles: Role[];
  filters: FilterKey[];
  columns: Column[];
  run(q: Queryable, f: Filters): Promise<Record<string, unknown>[]>;
}

const ALL_STAFF: Role[] = ["FR_SPORTS", "ASO", "MANAGEMENT"];
const IST = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')`;
const TS = (col: string) => `to_char(${IST(col)}, 'YYYY-MM-DD HH24:MI')`;
const DATE = (col: string) => `${IST(col)}::date`;

export const filterSchema = z.object({
  from: z.string().refine(isIsoDate, "Invalid start date.").optional(),
  to: z.string().refine(isIsoDate, "Invalid end date.").optional(),
  sportId: z.string().regex(/^\d+$/).optional(),
  categoryId: z.string().regex(/^\d+$/).optional(),
  itemStatus: z.enum(["active", "inactive", "all"]).optional(),
  issueStatus: z.enum(["all", "open", "overdue", "returned"]).optional(),
  incidentType: z.enum(["DAMAGED", "STORE_DAMAGE", "MISSING", "CONSUMED"]).optional(),
  openClosed: z.enum(["all", "open", "closed"]).optional(),
  decisionStatus: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  q: z.string().trim().max(100).optional(),
});
export type Filters = z.infer<typeof filterSchema> & { today: string };

const like = (q?: string) => (q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);
const equipment = "it.name || coalesce(' · ' || nullif(concat_ws(' ', it.brand, it.model, it.size), ''), '')";

const REPORTS: ReportDef[] = [
  {
    key: "stock",
    title: "Stock register",
    description: "Every item with its current available, issued, damaged and missing quantities.",
    roles: [...ALL_STAFF, "STOREKEEPER", "PROCUREMENT"],
    filters: ["sport", "category", "itemStatus", "q"],
    columns: [
      { key: "code", label: "Code", width: 1.6 },
      { key: "sport", label: "Sport", width: 1.4 },
      { key: "category", label: "Category", width: 1.4 },
      { key: "equipment", label: "Equipment", width: 3.2 },
      { key: "unit", label: "Unit", width: 0.8 },
      { key: "available", label: "Available", width: 1, align: "right", total: true },
      { key: "issued", label: "Issued", width: 0.9, align: "right", total: true },
      { key: "damaged", label: "Damaged", width: 1, align: "right", total: true },
      { key: "missing", label: "Missing", width: 0.9, align: "right", total: true },
      { key: "accountable", label: "Total accountable", width: 1.2, align: "right", total: true },
      { key: "discarded", label: "Discarded", width: 1, align: "right", total: true },
      { key: "minStock", label: "Min. stock", width: 0.9, align: "right" },
      { key: "status", label: "Status", width: 1 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT it.code, s.name AS sport, c.name AS category, ${equipment} AS equipment, it.unit,
                st.available, st.issued, st.damaged, st.missing, st.available + st.issued + st.damaged + st.missing AS accountable,
                st.discarded, it.min_stock AS "minStock",
                CASE WHEN NOT it.is_active THEN 'Deactivated' WHEN it.min_stock IS NOT NULL AND st.available - st.reserved < it.min_stock THEN 'Low stock' ELSE 'OK' END AS status
           FROM items it JOIN sports s ON s.id = it.sport_id JOIN categories c ON c.id = it.category_id JOIN item_stock st ON st.item_id = it.id
          WHERE ($1::bigint IS NULL OR it.sport_id = $1::bigint) AND ($2::bigint IS NULL OR it.category_id = $2::bigint)
            AND ($3 = 'all' OR it.is_active = ($3 = 'active'))
            AND ($4::text IS NULL OR it.name ILIKE $4 OR it.code ILIKE $4 OR it.brand ILIKE $4)
          ORDER BY s.name, c.name, it.name`,
        [f.sportId ?? null, f.categoryId ?? null, f.itemStatus ?? "active", like(f.q)],
      )).rows,
  },
  {
    key: "issues",
    title: "Issue and return register",
    description: "Every item issued: who has it, who approved and handed it over, when it is due and how it came back.",
    roles: [...ALL_STAFF, "STOREKEEPER"],
    filters: ["dates", "issueStatus", "q"],
    columns: [
      { key: "ref", label: "Issue ref.", width: 1.6 },
      { key: "recipient", label: "Recipient", width: 1.8 },
      { key: "univId", label: "Reg./emp. no.", width: 1.3 },
      { key: "group", label: "For", width: 1.2 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.2 },
      { key: "qty", label: "Qty", width: 0.6, align: "right", total: true },
      { key: "issued", label: "Issued", width: 1.4 },
      { key: "due", label: "Due", width: 1 },
      { key: "returned", label: "Returned", width: 1.4 },
      { key: "issuedBy", label: "Issued by", width: 1.3 },
      { key: "approvedBy", label: "Approved by", width: 1.3 },
      { key: "status", label: "Status", width: 1.2 },
      { key: "condition", label: "Condition at return", width: 2 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT i.ref, ru.name AS recipient, ru.univ_id AS "univId", r.group_name AS "group", it.code, ${equipment} AS equipment, l.qty,
                ${TS("i.issued_at")} AS issued, i.due_date::text AS due, ${TS("i.returned_at")} AS returned,
                coalesce(ib.name, ib.email) AS "issuedBy", coalesce(ab.name, ab.email) AS "approvedBy",
                CASE WHEN i.status = 'RETURNED' THEN 'Returned'
                     WHEN i.due_date < $3::date THEN 'Overdue ' || ($3::date - i.due_date) || ' d'
                     ELSE 'Issued' END AS status,
                CASE WHEN rl.id IS NULL THEN NULL ELSE concat_ws(', ',
                  CASE WHEN rl.qty_usable > 0 THEN rl.qty_usable || ' usable' END,
                  CASE WHEN rl.qty_damaged > 0 THEN rl.qty_damaged || ' damaged' END,
                  CASE WHEN rl.qty_missing > 0 THEN rl.qty_missing || ' missing' END,
                  CASE WHEN rl.qty_consumed > 0 THEN rl.qty_consumed || ' used up' END) END AS condition
           FROM issue_lines l JOIN issues i ON i.id = l.issue_id JOIN requests r ON r.id = i.request_id JOIN users ru ON ru.id = i.recipient_id
           JOIN items it ON it.id = l.item_id JOIN users ib ON ib.id = i.issued_by JOIN users ab ON ab.id = i.approved_by
           LEFT JOIN return_lines rl ON rl.issue_id = i.id AND rl.item_id = l.item_id
          WHERE ${DATE("i.issued_at")} BETWEEN $1::date AND $2::date
            AND CASE $4::text WHEN 'open' THEN i.status = 'ISSUED' WHEN 'overdue' THEN i.status = 'ISSUED' AND i.due_date < $3::date
                              WHEN 'returned' THEN i.status = 'RETURNED' ELSE true END
            AND ($5::text IS NULL OR i.ref ILIKE $5 OR ru.name ILIKE $5 OR ru.univ_id ILIKE $5 OR it.name ILIKE $5 OR it.code ILIKE $5)
          ORDER BY i.issued_at DESC, i.id DESC, l.id`,
        [f.from, f.to, f.today, f.issueStatus ?? "all", like(f.q)],
      )).rows,
  },
  {
    key: "damage",
    title: "Damaged and missing equipment",
    description: "Damage and loss records with the accountable recipient and what has been done about them.",
    roles: [...ALL_STAFF, "STOREKEEPER"],
    filters: ["dates", "incidentType", "openClosed", "q"],
    columns: [
      { key: "date", label: "Recorded", width: 1.4 },
      { key: "type", label: "Type", width: 1.3 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.2 },
      { key: "qty", label: "Qty", width: 0.6, align: "right", total: true },
      { key: "open", label: "Still open", width: 0.8, align: "right", total: true },
      { key: "recipient", label: "Accountable", width: 1.7 },
      { key: "univId", label: "Reg./emp. no.", width: 1.2 },
      { key: "issueRef", label: "Issue ref.", width: 1.5 },
      { key: "description", label: "Description", width: 2.4 },
      { key: "reportedBy", label: "Recorded by", width: 1.3 },
      { key: "outcome", label: "Outcome", width: 2.2 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT ${TS("n.created_at")} AS date,
                CASE n.type WHEN 'DAMAGED' THEN 'Returned damaged' WHEN 'STORE_DAMAGE' THEN 'Damaged in store' WHEN 'MISSING' THEN 'Missing' ELSE 'Used up' END AS type,
                it.code, ${equipment} AS equipment, n.qty, n.qty - n.qty_resolved AS open, ru.name AS recipient, ru.univ_id AS "univId", i.ref AS "issueRef",
                n.description, coalesce(rb.name, rb.email) AS "reportedBy",
                (SELECT string_agg(x.qty || ' ' || lower(replace(x.action, '_', ' ')), ', ' ORDER BY x.id) FROM incident_resolutions x WHERE x.incident_id = n.id) AS outcome
           FROM incidents n JOIN items it ON it.id = n.item_id LEFT JOIN users ru ON ru.id = n.recipient_id LEFT JOIN issues i ON i.id = n.issue_id
           JOIN users rb ON rb.id = n.reported_by
          WHERE ${DATE("n.created_at")} BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR n.type = $3::text)
            AND ($4 = 'all' OR ($4 = 'open') = (n.qty_resolved < n.qty))
            AND ($5::text IS NULL OR it.name ILIKE $5 OR it.code ILIKE $5 OR ru.name ILIKE $5 OR ru.univ_id ILIKE $5 OR i.ref ILIKE $5)
          ORDER BY n.created_at DESC, n.id DESC`,
        [f.from, f.to, f.incidentType ?? null, f.openClosed ?? "all", like(f.q)],
      )).rows,
  },
  {
    key: "counts",
    title: "Physical verification report",
    description: "Submitted stock counts: what the system expected on the shelf, what was counted, and the correction decision.",
    roles: [...ALL_STAFF, "STOREKEEPER"],
    filters: ["dates", "q"],
    columns: [
      { key: "count", label: "Count", width: 0.7 },
      { key: "date", label: "Submitted", width: 1.4 },
      { key: "scope", label: "Counted", width: 1.6 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.4 },
      { key: "expected", label: "Expected on shelf", width: 1.2, align: "right", total: true },
      { key: "counted", label: "Counted", width: 0.9, align: "right", total: true },
      { key: "difference", label: "Difference", width: 0.9, align: "right", total: true },
      { key: "issued", label: "On issue (not counted)", width: 1.3, align: "right" },
      { key: "countedBy", label: "Counted by", width: 1.3 },
      { key: "approval", label: "Correction", width: 2.2 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT '#' || v.id AS count, ${TS("v.submitted_at")} AS date, v.scope_label AS scope, it.code, ${equipment} AS equipment,
                vl.expected_usable + vl.expected_damaged AS expected, vl.counted_usable + vl.counted_damaged AS counted,
                (vl.counted_usable + vl.counted_damaged) - (vl.expected_usable + vl.expected_damaged) AS difference,
                vl.issued_at_count AS issued, coalesce(sb.name, sb.email) AS "countedBy",
                (SELECT string_agg(CASE WHEN a.delta > 0 THEN '+' ELSE '' END || a.delta || ' ' || CASE a.state WHEN 'AVAILABLE' THEN 'usable' ELSE 'damaged' END
                                   || ': ' || lower(a.status) || coalesce(' (' || coalesce(du.name, du.email) || ')', ''), '; ' ORDER BY a.id)
                   FROM adjustments a LEFT JOIN users du ON du.id = a.decided_by AND a.status <> 'CANCELLED' WHERE a.verification_line_id = vl.id) AS approval
           FROM verification_lines vl JOIN verification_sessions v ON v.id = vl.session_id JOIN items it ON it.id = vl.item_id
           LEFT JOIN users sb ON sb.id = v.submitted_by
          WHERE v.status = 'SUBMITTED' AND ${DATE("v.submitted_at")} BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR it.name ILIKE $3 OR it.code ILIKE $3 OR v.scope_label ILIKE $3)
          ORDER BY v.submitted_at DESC, it.name`,
        [f.from, f.to, like(f.q)],
      )).rows,
  },
  {
    key: "discards",
    title: "Discard register",
    description: "Equipment discarded or put forward for discard, with reasons, requesters and FR Sports decisions.",
    roles: ALL_STAFF,
    filters: ["dates", "decisionStatus", "q"],
    columns: [
      { key: "date", label: "Requested", width: 1.4 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.3 },
      { key: "from", label: "From", width: 0.9 },
      { key: "qty", label: "Qty", width: 0.6, align: "right", total: true },
      { key: "reason", label: "Reason", width: 1.3 },
      { key: "details", label: "Details", width: 2.2 },
      { key: "requestedBy", label: "Requested by", width: 1.4 },
      { key: "status", label: "Status", width: 0.9 },
      { key: "decidedBy", label: "Decided by", width: 1.3 },
      { key: "decided", label: "Decided", width: 1.4 },
      { key: "note", label: "Decision note", width: 1.6 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT ${TS("d.created_at")} AS date, it.code, ${equipment} AS equipment,
                CASE d.from_state WHEN 'AVAILABLE' THEN 'Store' WHEN 'DAMAGED' THEN 'Damaged' ELSE 'Missing' END AS "from", d.qty,
                CASE d.reason WHEN 'BROKEN' THEN 'Broken' WHEN 'WORN_OUT' THEN 'Worn out' WHEN 'OBSOLETE' THEN 'Obsolete' WHEN 'BEYOND_USE' THEN 'Beyond use'
                              WHEN 'LOST' THEN 'Lost' WHEN 'CONSUMED' THEN 'Used up' ELSE 'Other' END AS reason,
                d.details, CASE WHEN d.auto THEN 'Automatic (used up)' ELSE coalesce(rq.name, rq.email) END AS "requestedBy",
                initcap(d.status) AS status, coalesce(dc.name, dc.email) AS "decidedBy", ${TS("d.decided_at")} AS decided, d.decision_note AS note
           FROM discard_requests d JOIN items it ON it.id = d.item_id LEFT JOIN users rq ON rq.id = d.requested_by
           LEFT JOIN users dc ON dc.id = d.decided_by AND d.status IN ('APPROVED','REJECTED')
          WHERE ${DATE("d.created_at")} BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR d.status = $3::text)
            AND ($4::text IS NULL OR it.name ILIKE $4 OR it.code ILIKE $4)
          ORDER BY d.created_at DESC, d.id DESC`,
        [f.from, f.to, f.decisionStatus ?? null, like(f.q)],
      )).rows,
  },
  {
    key: "corrections",
    title: "Stock correction register",
    description: "Differences between records and physical counts, who raised them and who approved them.",
    roles: ALL_STAFF,
    filters: ["dates", "decisionStatus", "q"],
    columns: [
      { key: "date", label: "Requested", width: 1.4 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.3 },
      { key: "stock", label: "Stock", width: 0.9 },
      { key: "expected", label: "System", width: 0.8, align: "right" },
      { key: "counted", label: "Counted", width: 0.8, align: "right" },
      { key: "change", label: "Change", width: 0.8, align: "right", total: true },
      { key: "reason", label: "Reason", width: 2 },
      { key: "requestedBy", label: "Requested by", width: 1.4 },
      { key: "status", label: "Status", width: 0.9 },
      { key: "decidedBy", label: "Decided by", width: 1.3 },
      { key: "decided", label: "Decided", width: 1.4 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT ${TS("a.created_at")} AS date, it.code, ${equipment} AS equipment, CASE a.state WHEN 'AVAILABLE' THEN 'Usable' ELSE 'Damaged' END AS stock,
                a.expected_qty AS expected, a.counted_qty AS counted, a.delta AS change, a.reason, coalesce(rq.name, rq.email) AS "requestedBy",
                initcap(a.status) AS status, CASE WHEN a.status IN ('APPROVED','REJECTED') THEN coalesce(dc.name, dc.email) END AS "decidedBy",
                ${TS("a.decided_at")} AS decided
           FROM adjustments a JOIN items it ON it.id = a.item_id JOIN users rq ON rq.id = a.requested_by LEFT JOIN users dc ON dc.id = a.decided_by
          WHERE ${DATE("a.created_at")} BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR a.status = $3::text)
            AND ($4::text IS NULL OR it.name ILIKE $4 OR it.code ILIKE $4)
          ORDER BY a.created_at DESC, a.id DESC`,
        [f.from, f.to, f.decisionStatus ?? null, like(f.q)],
      )).rows,
  },
  {
    key: "receipts",
    title: "Stock received",
    description: "Opening stock and newly received stock (including Excel imports), and any reversals of mistaken entries.",
    roles: [...ALL_STAFF, "PROCUREMENT"],
    filters: ["dates", "sport", "q"],
    columns: [
      { key: "date", label: "Date", width: 1.4 },
      { key: "code", label: "Code", width: 1.5 },
      { key: "equipment", label: "Equipment", width: 2.6 },
      { key: "sport", label: "Sport", width: 1.2 },
      { key: "type", label: "Entry", width: 1.2 },
      { key: "qty", label: "Qty", width: 0.7, align: "right", total: true },
      { key: "availableAfter", label: "Available after", width: 1, align: "right" },
      { key: "by", label: "Recorded by", width: 1.4 },
      { key: "remarks", label: "Remarks", width: 2.6 },
    ],
    run: async (q, f) =>
      (await q.query(
        `SELECT ${TS("m.created_at")} AS date, it.code, ${equipment} AS equipment, s.name AS sport,
                CASE m.type WHEN 'OPENING' THEN 'Opening stock' WHEN 'RECEIPT' THEN 'Received' ELSE 'Reversal' END
                  || CASE WHEN m.source_table = 'import_batches' THEN ' (Excel import)' ELSE '' END
                  || CASE WHEN EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_id = m.id) THEN ' - reversed' ELSE '' END AS type,
                CASE WHEN m.type = 'REVERSAL' THEN -m.qty ELSE m.qty END AS qty, (m.after->>'available')::int AS "availableAfter",
                coalesce(u.name, u.email) AS by, m.remarks
           FROM stock_movements m JOIN items it ON it.id = m.item_id JOIN sports s ON s.id = it.sport_id LEFT JOIN users u ON u.id = m.actor_id
          WHERE m.type IN ('OPENING','RECEIPT','REVERSAL') AND ${DATE("m.created_at")} BETWEEN $1::date AND $2::date
            AND ($3::bigint IS NULL OR it.sport_id = $3::bigint) AND ($4::text IS NULL OR it.name ILIKE $4 OR it.code ILIKE $4 OR m.remarks ILIKE $4)
          ORDER BY m.created_at DESC, m.id DESC`,
        [f.from, f.to, f.sportId ?? null, like(f.q)],
      )).rows,
  },
];

export function reportsFor(user: User) {
  if (!user.is_active || !can(user.role, "reports.view")) return [];
  return REPORTS.filter((r) => r.roles.includes(user.role)).map(({ key, title, description, filters }) => ({ key, title, description, filters }));
}

export const PAGE_ROW_LIMIT = 500;
export const EXPORT_ROW_LIMIT = 20_000;

export interface ReportResult {
  key: string;
  title: string;
  description: string;
  filters: FilterKey[];
  applied: Filters;
  columns: Column[];
  rows: Cell[][];
  totalRows: number;
  truncated: boolean;
  totals: (number | null)[] | null;
}

export async function runReport(ctx: AppContext, actor: User, key: string, input: unknown, limit = PAGE_ROW_LIMIT): Promise<ReportResult> {
  if (!actor.is_active || !can(actor.role, "reports.view")) throw forbidden();
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw notFound("Report");
  if (!def.roles.includes(actor.role)) throw forbidden("This report is not available for your role.");
  const raw = Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).filter(([, v]) => v !== "" && v !== undefined && v !== null));
  const p = filterSchema.safeParse(raw);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid filters.");
  const today = todayIST(ctx.now());
  const f: Filters = { ...p.data, today, from: p.data.from ?? addDays(today, -90), to: p.data.to ?? today };
  if (f.from! > f.to!) throw new AppError(400, "VALIDATION", "The start date is after the end date.");
  const objs = await def.run(ctx.db, f);
  // Only numeric (right-aligned) columns become numbers; IDs such as "00123" stay text.
  const toCell = (v: unknown, c: Column): Cell =>
    v === null || v === undefined ? null : c.align === "right" && /^-?\d+$/.test(String(v)) ? Number(v) : String(v);
  const all = objs.map((o) => def.columns.map((c) => toCell(o[c.key], c)));
  const totals = def.columns.some((c) => c.total)
    ? def.columns.map((c, i) => (c.total ? all.reduce((s, r) => s + (typeof r[i] === "number" ? (r[i] as number) : 0), 0) : null))
    : null;
  return {
    key: def.key, title: def.title, description: def.description, filters: def.filters, applied: f, columns: def.columns,
    rows: all.slice(0, limit), totalRows: all.length, truncated: all.length > limit, totals,
  };
}

function describeFilters(r: ReportResult): string {
  const f = r.applied;
  const parts: string[] = [];
  if (r.filters.includes("dates")) parts.push(`${formatDate(f.from!)} to ${formatDate(f.to!)}`);
  if (f.issueStatus && f.issueStatus !== "all") parts.push(`status: ${f.issueStatus}`);
  if (f.openClosed && f.openClosed !== "all") parts.push(f.openClosed);
  if (f.decisionStatus) parts.push(f.decisionStatus.toLowerCase());
  if (f.incidentType) parts.push(f.incidentType.toLowerCase().replace("_", " "));
  if (f.itemStatus && f.itemStatus !== "active") parts.push(`items: ${f.itemStatus}`);
  if (f.sportId) parts.push("one sport");
  if (f.categoryId) parts.push("one category");
  if (f.q) parts.push(`search "${f.q}"`);
  return parts.join(" · ");
}

export async function exportReport(ctx: AppContext, actor: User, key: string, format: "xlsx" | "pdf", input: unknown, ip: string | null) {
  const r = await runReport(ctx, actor, key, input, EXPORT_ROW_LIMIT);
  const generated = `Generated ${formatDateTimeIST(ctx.now())} IST by ${actor.name ?? actor.email}`;
  const filterText = describeFilters(r);
  const rows = r.totals ? [...r.rows, r.totals.map((t, i) => (i === 0 ? "Total" : t))] : r.rows;
  const stamp = todayIST(ctx.now());
  const filename = `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}.${format}`;
  let bytes: Uint8Array;
  if (format === "xlsx") {
    bytes = await writeXlsx([
      {
        name: r.title.slice(0, 31),
        rows: [r.columns.map((c) => c.label), ...rows],
        widths: r.columns.map((c) => Math.round(c.width * 9)),
        boldFirstRow: true,
      },
      { name: "About", rows: [["Report", r.title], ["Filters", filterText || "None"], ["", generated], ["Rows", String(r.totalRows)], ...(r.truncated ? [["Note", `Only the first ${EXPORT_ROW_LIMIT} rows are included; narrow the filters.`]] : [])], widths: [12, 80] },
    ]);
  } else {
    bytes = writePdf({
      title: `${r.title} — VIT Bhopal Sports Store`,
      subtitle: [filterText, `${r.totalRows} row(s)`, generated].filter(Boolean).join("   ·   "),
      columns: r.columns.map((c) => ({ label: c.label, width: c.width, align: c.align })),
      rows: rows.slice(0, 5000),
      footer: r.totalRows > 5000 ? "PDF shows the first 5,000 rows; use Excel for the full list" : "VIT Bhopal Sports Equipment Portal",
    });
  }
  await writeAudit(ctx.db, { actorId: actor.id, action: "report.export", entity: "report", entityId: key, after: { format, filters: r.applied, rows: r.totalRows }, ip });
  return { bytes, filename, contentType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf" };
}
