/**
 * Equipment requests and issues.
 * A request never moves stock. "Approve & hand over" is ONE transaction: it re-checks permission and availability,
 * moves Available -> Issued for every line, creates the issue record, and queues the emails — or does nothing.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import type { Queryable } from "../db/types";
import { AppError, forbidden, notFound } from "../errors";
import { idempotent } from "../idempotency";
import { applyMovement, availableToIssue, lockStock } from "../inventory/ledger";
import { dispatchSoon, enqueue } from "../notify/outbox";
import { issueEmail, rejectionEmail } from "../notify/templates";
import { addDays, daysBetween, formatDate, isIsoDate, todayIST } from "../time";

export const MAX_LOAN_DAYS = 30;
export const MAX_LINES = 20;
export const MAX_PENDING_PER_USER = 5;

const idStr = z.string().regex(/^\d+$/, "Invalid id.");
const dateStr = z.string().refine(isIsoDate, "Enter a valid date.");

function validation(err: z.ZodError) {
  return new AppError(400, "VALIDATION", err.issues[0]?.message ?? "Invalid input.", {
    fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

const isStaffViewer = (u: User) => can(u.role, "request.markReady") || can(u.role, "reports.view");

/** Gap-free yearly numbers: REQ-2026-000001, ISS-2026-000001. */
export async function nextRef(q: Queryable, prefix: "REQ" | "ISS", now: Date): Promise<string> {
  const year = todayIST(now).slice(0, 4);
  const res = await q.query<{ value: number }>(
    `INSERT INTO counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [`${prefix}-${year}`],
  );
  return `${prefix}-${year}-${String(res.rows[0]!.value).padStart(6, "0")}`;
}

function checkDueDate(due: string, now: Date) {
  const today = todayIST(now);
  if (due < today) throw new AppError(400, "DUE_DATE", "The return date cannot be in the past.");
  if (due > addDays(today, MAX_LOAN_DAYS)) {
    throw new AppError(400, "DUE_DATE", `The return date can be at most ${MAX_LOAN_DAYS} days ahead (${formatDate(addDays(today, MAX_LOAN_DAYS))}).`);
  }
}

// ---------- catalog ----------

export async function catalog(ctx: AppContext, actor: User, input: { q?: string; sportId?: string } = {}) {
  requirePermission(actor, "catalog.view");
  const q = (input.q ?? "").trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const res = await ctx.db.query<{
    id: string; code: string; name: string; brand: string | null; model: string | null; size: string | null; unit: string;
    sport_id: string; sport_name: string; category_name: string; available: number; reserved: number;
  }>(
    `SELECT i.id, i.code, i.name, i.brand, i.model, i.size, i.unit, i.sport_id, s.name AS sport_name, c.name AS category_name,
            st.available, st.reserved
       FROM items i JOIN sports s ON s.id = i.sport_id JOIN categories c ON c.id = i.category_id JOIN item_stock st ON st.item_id = i.id
      WHERE i.is_active AND s.is_active AND c.is_active AND st.available - st.reserved > 0
        AND ($1::text IS NULL OR i.name ILIKE $1 OR i.code ILIKE $1 OR i.brand ILIKE $1 OR c.name ILIKE $1 OR s.name ILIKE $1)
        AND ($2::bigint IS NULL OR i.sport_id = $2::bigint)
      ORDER BY s.name, c.name, i.name LIMIT 300`,
    [pattern, input.sportId && /^\d+$/.test(input.sportId) ? input.sportId : null],
  );
  return res.rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, brand: r.brand, model: r.model, size: r.size, unit: r.unit,
    sport: { id: r.sport_id, name: r.sport_name }, category: r.category_name, available: availableToIssue(r),
  }));
}
export type CatalogItem = Awaited<ReturnType<typeof catalog>>[number];

// ---------- views ----------

interface RequestRow {
  id: string; ref: string; status: string; ready: boolean; group_name: string | null; purpose: string; expected_return: string;
  created_at: Date; decided_at: Date | null; reject_reason: string | null;
  requester_id: string; requester_name: string | null; requester_email: string; requester_univ_id: string | null; requester_category: string | null;
  decided_by_name: string | null; ready_by_name: string | null;
  issue_id: string | null; issue_ref: string | null; due_date: string | null; issued_at: Date | null; issue_status: string | null;
  issued_by_name: string | null; approved_by_name: string | null;
}

const REQUEST_SELECT = `
  SELECT r.id, r.ref, r.status, r.ready, r.group_name, r.purpose, r.expected_return::text AS expected_return, r.created_at,
         r.decided_at, r.reject_reason,
         r.requester_id, ru.name AS requester_name, ru.email AS requester_email, ru.univ_id AS requester_univ_id, ru.category AS requester_category,
         coalesce(du.name, du.email) AS decided_by_name, coalesce(rb.name, rb.email) AS ready_by_name,
         i.id AS issue_id, i.ref AS issue_ref, i.due_date::text AS due_date, i.issued_at, i.status AS issue_status,
         coalesce(ib.name, ib.email) AS issued_by_name, coalesce(ab.name, ab.email) AS approved_by_name
    FROM requests r
    JOIN users ru ON ru.id = r.requester_id
    LEFT JOIN users du ON du.id = r.decided_by
    LEFT JOIN users rb ON rb.id = r.ready_by
    LEFT JOIN issues i ON i.request_id = r.id
    LEFT JOIN users ib ON ib.id = i.issued_by
    LEFT JOIN users ab ON ab.id = i.approved_by`;

async function loadLines(q: Queryable, requestIds: string[]) {
  if (!requestIds.length) return new Map<string, RequestLineView[]>();
  const res = await q.query<{
    request_id: string; item_id: string; code: string; name: string; brand: string | null; unit: string;
    qty_requested: number; qty_issued: number | null; available: number; reserved: number; is_active: boolean;
  }>(
    `SELECT l.request_id, l.item_id, it.code, it.name, it.brand, it.unit, l.qty_requested, l.qty_issued, st.available, st.reserved, it.is_active
       FROM request_lines l JOIN items it ON it.id = l.item_id JOIN item_stock st ON st.item_id = l.item_id
      WHERE l.request_id = ANY($1::bigint[]) ORDER BY l.id`,
    [requestIds],
  );
  const map = new Map<string, RequestLineView[]>();
  for (const r of res.rows) {
    const list = map.get(String(r.request_id)) ?? [];
    list.push({
      itemId: r.item_id, code: r.code, name: r.name, brand: r.brand, unit: r.unit, qtyRequested: r.qty_requested,
      qtyIssued: r.qty_issued, availableNow: r.is_active ? availableToIssue(r) : 0, itemActive: r.is_active,
    });
    map.set(String(r.request_id), list);
  }
  return map;
}

export interface RequestLineView {
  itemId: string; code: string; name: string; brand: string | null; unit: string;
  qtyRequested: number; qtyIssued: number | null; availableNow: number; itemActive: boolean;
}

function requestView(r: RequestRow, lines: RequestLineView[], now: Date) {
  const today = todayIST(now);
  return {
    id: r.id,
    ref: r.ref,
    status: r.status,
    ready: r.ready,
    readyBy: r.ready_by_name,
    requester: { id: r.requester_id, name: r.requester_name, email: r.requester_email, univId: r.requester_univ_id, category: r.requester_category },
    groupName: r.group_name,
    purpose: r.purpose,
    expectedReturn: r.expected_return,
    createdAt: r.created_at,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at,
    rejectReason: r.reject_reason,
    lines,
    issue: r.issue_id
      ? {
          id: r.issue_id,
          ref: r.issue_ref!,
          dueDate: r.due_date!,
          issuedAt: r.issued_at!,
          status: r.issue_status!,
          issuedBy: r.issued_by_name,
          approvedBy: r.approved_by_name,
          overdue: r.issue_status === "ISSUED" && r.due_date! < today,
          daysOverdue: r.issue_status === "ISSUED" && r.due_date! < today ? daysBetween(r.due_date!, today) : 0,
        }
      : null,
  };
}
export type RequestView = ReturnType<typeof requestView>;

const listSchema = z.object({
  status: z.enum(["PENDING", "ISSUED", "OVERDUE", "CLOSED", "ALL"]).default("ALL"),
  mine: z.enum(["1", "true"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Staff see every request; everyone else sees only their own. Overdue is computed from today's date, never stored. */
export async function listRequests(ctx: AppContext, actor: User, input: unknown): Promise<RequestView[]> {
  const p = listSchema.safeParse(input ?? {});
  if (!p.success) throw validation(p.error);
  const f = p.data;
  const ownOnly = !isStaffViewer(actor) || f.mine !== undefined;
  const today = todayIST(ctx.now());
  const pattern = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const res = await ctx.db.query<RequestRow>(
    `${REQUEST_SELECT}
      WHERE ($1::bigint IS NULL OR r.requester_id = $1::bigint)
        AND CASE $2::text
              WHEN 'PENDING' THEN r.status = 'PENDING'
              WHEN 'ISSUED' THEN r.status = 'ISSUED'
              WHEN 'OVERDUE' THEN r.status = 'ISSUED' AND i.due_date < $3::date
              WHEN 'CLOSED' THEN r.status IN ('CANCELLED','REJECTED','RETURNED')
              ELSE true END
        AND ($4::text IS NULL OR r.ref ILIKE $4 OR i.ref ILIKE $4 OR ru.name ILIKE $4 OR ru.email ILIKE $4 OR ru.univ_id ILIKE $4 OR r.group_name ILIKE $4)
      ORDER BY ${f.status === "PENDING" ? "r.ready DESC, r.created_at ASC" : f.status === "ISSUED" || f.status === "OVERDUE" ? "i.due_date ASC" : "r.created_at DESC"}
      LIMIT $5`,
    [ownOnly ? actor.id : null, f.status, today, pattern, f.limit],
  );
  const lines = await loadLines(ctx.db, res.rows.map((r) => r.id));
  return res.rows.map((r) => requestView(r, lines.get(String(r.id)) ?? [], ctx.now()));
}

export async function getRequest(ctx: AppContext, actor: User, id: string): Promise<RequestView> {
  if (!/^\d+$/.test(id)) throw notFound("Request");
  const res = await ctx.db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  const row = res.rows[0];
  if (!row || (!isStaffViewer(actor) && String(row.requester_id) !== String(actor.id))) throw notFound("Request");
  const lines = await loadLines(ctx.db, [row.id]);
  return requestView(row, lines.get(String(row.id)) ?? [], ctx.now());
}

// ---------- create / cancel / ready ----------

const createSchema = z.object({
  lines: z
    .array(z.object({ itemId: idStr, qty: z.number().int("Quantities must be whole numbers.").min(1).max(1000) }))
    .min(1, "Add at least one item.")
    .max(MAX_LINES, `At most ${MAX_LINES} different items per request.`),
  purpose: z.string().trim().min(3, "Say briefly what the equipment is for.").max(300),
  expectedReturn: dateStr,
  groupName: z.string().trim().max(100).optional().nullable().transform((v) => (v ? v : null)),
  idempotencyKey: z.string().optional(),
});

export async function createRequest(ctx: AppContext, actor: User, input: unknown, ip: string | null): Promise<RequestView> {
  requirePermission(actor, "request.create");
  const p = createSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const d = p.data;
  const ids = d.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "VALIDATION", "Each item can appear only once; change its quantity instead.");
  const now = ctx.now();
  checkDueDate(d.expectedReturn, now);

  const { result } = await ctx.db.tx((q) =>
    idempotent(q, d.idempotencyKey, actor.id, "request.create", async () => {
      await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`requests:${actor.id}`]);
      const pending = await q.query<{ n: string }>("SELECT count(*) AS n FROM requests WHERE requester_id = $1 AND status = 'PENDING'", [actor.id]);
      if (Number(pending.rows[0]!.n) >= MAX_PENDING_PER_USER) {
        throw new AppError(409, "TOO_MANY_PENDING", `You already have ${MAX_PENDING_PER_USER} requests waiting. Wait for a decision or cancel one.`);
      }
      const items = await q.query<{ id: string; name: string; is_active: boolean; available: number; reserved: number }>(
        `SELECT i.id, i.name, i.is_active AND s.is_active AND c.is_active AS is_active, st.available, st.reserved
           FROM items i JOIN sports s ON s.id = i.sport_id JOIN categories c ON c.id = i.category_id JOIN item_stock st ON st.item_id = i.id
          WHERE i.id = ANY($1::bigint[])`,
        [ids],
      );
      const byId = new Map(items.rows.map((r) => [String(r.id), r]));
      const problems: string[] = [];
      for (const l of d.lines) {
        const it = byId.get(l.itemId);
        if (!it || !it.is_active) problems.push(`Item ${l.itemId} is not available for requests.`);
        else if (availableToIssue(it) < l.qty) problems.push(`${it.name}: only ${availableToIssue(it)} available, you asked for ${l.qty}.`);
      }
      if (problems.length) throw new AppError(409, "NOT_AVAILABLE", problems.join(" "), { problems });

      const ref = await nextRef(q, "REQ", now);
      const ins = await q.query<{ id: string }>(
        `INSERT INTO requests (ref, requester_id, group_name, purpose, expected_return, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ref, actor.id, d.groupName, d.purpose, d.expectedReturn, now],
      );
      const requestId = ins.rows[0]!.id;
      for (const l of d.lines) {
        await q.query("INSERT INTO request_lines (request_id, item_id, qty_requested) VALUES ($1, $2, $3)", [requestId, l.itemId, l.qty]);
      }
      await writeAudit(q, { actorId: actor.id, action: "request.create", entity: "request", entityId: requestId, after: { ref, lines: d.lines, expectedReturn: d.expectedReturn }, ip });
      const row = (await q.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId])).rows[0]!;
      return requestView(row, (await loadLines(q, [requestId])).get(String(requestId)) ?? [], now);
    }),
  );
  return result;
}

async function lockPending(q: Queryable, id: string) {
  const r = (await q.query<{ status: string; requester_id: string; ref: string; decided_by_name: string | null; decided_at: Date | null }>(
    `SELECT r.status, r.requester_id, r.ref, coalesce(u.name, u.email) AS decided_by_name, r.decided_at
       FROM requests r LEFT JOIN users u ON u.id = r.decided_by WHERE r.id = $1 FOR UPDATE OF r`,
    [id],
  )).rows[0];
  if (!r) throw notFound("Request");
  if (r.status !== "PENDING") {
    const by = r.decided_by_name ? ` by ${r.decided_by_name}` : "";
    throw new AppError(409, "ALREADY_PROCESSED", `This request was already ${r.status.toLowerCase()}${by}. Refresh the page.`, { status: r.status });
  }
  return r;
}

export async function cancelRequest(ctx: AppContext, actor: User, id: string, ip: string | null) {
  if (!/^\d+$/.test(id)) throw notFound("Request");
  await ctx.db.tx(async (q) => {
    const exists = (await q.query<{ requester_id: string }>("SELECT requester_id FROM requests WHERE id = $1", [id])).rows[0];
    if (!exists || String(exists.requester_id) !== String(actor.id)) throw notFound("Request");
    await lockPending(q, id);
    await q.query("UPDATE requests SET status = 'CANCELLED', decided_by = $2, decided_at = $3 WHERE id = $1", [id, actor.id, ctx.now()]);
    await writeAudit(q, { actorId: actor.id, action: "request.cancel", entity: "request", entityId: id, ip });
  });
  return getRequest(ctx, actor, id);
}

export async function setReady(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "request.markReady");
  if (!/^\d+$/.test(id)) throw notFound("Request");
  const p = z.object({ ready: z.boolean() }).safeParse(input);
  if (!p.success) throw validation(p.error);
  await ctx.db.tx(async (q) => {
    await lockPending(q, id);
    await q.query("UPDATE requests SET ready = $2, ready_by = $3, ready_at = $4 WHERE id = $1", [
      id, p.data.ready, p.data.ready ? actor.id : null, p.data.ready ? ctx.now() : null,
    ]);
    await writeAudit(q, { actorId: actor.id, action: p.data.ready ? "request.ready" : "request.unready", entity: "request", entityId: id, ip });
  });
  return getRequest(ctx, actor, id);
}

// ---------- reject ----------

export async function rejectRequest(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null) {
  requirePermission(actor, "request.reject");
  if (!/^\d+$/.test(id)) throw notFound("Request");
  const p = z.object({ reason: z.string().trim().min(3, "Give a short reason.").max(300) }).safeParse(input);
  if (!p.success) throw validation(p.error);
  const now = ctx.now();
  const queued = await ctx.db.tx(async (q) => {
    const r = await lockPending(q, id);
    if (String(r.requester_id) === String(actor.id)) throw new AppError(403, "SELF_DECISION", "You cannot decide on your own request.");
    await q.query("UPDATE requests SET status = 'REJECTED', decided_by = $2, decided_at = $3, reject_reason = $4 WHERE id = $1", [id, actor.id, now, p.data.reason]);
    await writeAudit(q, { actorId: actor.id, action: "request.reject", entity: "request", entityId: id, after: { reason: p.data.reason }, ip });
    const requester = (await q.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [r.requester_id])).rows[0]!;
    const lines = (await q.query<{ name: string; qty: number }>(
      "SELECT it.name, l.qty_requested AS qty FROM request_lines l JOIN items it ON it.id = l.item_id WHERE l.request_id = $1 ORDER BY l.id",
      [id],
    )).rows;
    const mail = rejectionEmail({ requestRef: r.ref, reason: p.data.reason, decidedByName: actor.name ?? actor.email, lines, appOrigin: ctx.config.APP_ORIGIN });
    return [await enqueue(q, { dedupeKey: `reject:${id}`, kind: "request.rejected", to: requester.email, ...mail, entity: "request", entityId: id }, now)];
  });
  await dispatchSoon(ctx, queued);
  return getRequest(ctx, actor, id);
}

// ---------- approve & hand over ----------

const approveSchema = z.object({
  lines: z.array(z.object({ itemId: idStr, qty: z.number().int().min(0).max(1000) })).min(1),
  dueDate: dateStr,
  issuedById: idStr.optional(),
  idempotencyKey: z.string().optional(),
});

/** People who may be recorded as physically handing equipment over. */
export async function issuerOptions(ctx: AppContext, actor: User) {
  requirePermission(actor, "request.approveIssue");
  const res = await ctx.db.query<{ id: string; name: string | null; email: string; role: string }>(
    "SELECT id, name, email, role FROM users WHERE is_active AND role IN ('FR_SPORTS','ASO','STOREKEEPER') ORDER BY (id = $1) DESC, name",
    [actor.id],
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name ?? r.email, role: r.role }));
}

export interface IssueResult {
  requestId: string;
  issueId: string;
  issueRef: string;
  dueDate: string;
  lines: { itemId: string; code: string; qty: number; availableAfter: number }[];
  emailIds: (string | null)[];
}

export async function approveAndIssue(ctx: AppContext, actor: User, id: string, input: unknown, ip: string | null): Promise<IssueResult & { replayed: boolean }> {
  requirePermission(actor, "request.approveIssue");
  if (!/^\d+$/.test(id)) throw notFound("Request");
  const p = approveSchema.safeParse(input);
  if (!p.success) throw validation(p.error);
  const d = p.data;
  const now = ctx.now();
  checkDueDate(d.dueDate, now);

  const { result, replayed } = await ctx.db.tx((q) =>
    idempotent(q, d.idempotencyKey, actor.id, `request.issue:${id}`, async (): Promise<IssueResult> => {
      // 1. Request must still be pending (row lock: a second officer waits, then sees ISSUED and stops).
      const r = await lockPending(q, id);
      if (String(r.requester_id) === String(actor.id)) throw new AppError(403, "SELF_DECISION", "You cannot approve your own request. Ask another officer.");
      // Re-read the approver inside the transaction: they may have just been demoted or deactivated.
      const approver = (await q.query<{ role: string; is_active: boolean; name: string | null; email: string }>("SELECT role, is_active, name, email FROM users WHERE id = $1", [actor.id])).rows[0];
      if (!approver?.is_active || !["FR_SPORTS", "ASO"].includes(approver.role)) throw forbidden();

      // 2. Who physically hands over.
      const issuerId = d.issuedById ?? actor.id;
      const issuer = (await q.query<{ role: string; is_active: boolean; name: string | null; email: string }>("SELECT role, is_active, name, email FROM users WHERE id = $1", [issuerId])).rows[0];
      if (!issuer?.is_active || !["FR_SPORTS", "ASO", "STOREKEEPER"].includes(issuer.role)) {
        throw new AppError(400, "VALIDATION", "The person handing over must be active sports store staff.");
      }

      // 3. Lines: only items in the request, never more than requested; zero drops a line.
      const reqLines = (await q.query<{ item_id: string; qty_requested: number }>("SELECT item_id, qty_requested FROM request_lines WHERE request_id = $1", [id])).rows;
      const requested = new Map(reqLines.map((l) => [String(l.item_id), l.qty_requested]));
      const chosen = new Map<string, number>();
      for (const l of d.lines) {
        const max = requested.get(l.itemId);
        if (max === undefined) throw new AppError(400, "VALIDATION", "A line does not belong to this request.");
        if (l.qty > max) throw new AppError(400, "VALIDATION", "You cannot issue more than was requested.");
        if (chosen.has(l.itemId)) throw new AppError(400, "VALIDATION", "Each item may appear once.");
        chosen.set(l.itemId, l.qty);
      }
      const toIssue = [...chosen].filter(([, qty]) => qty > 0);
      if (!toIssue.length) throw new AppError(400, "NOTHING_TO_ISSUE", "Issue at least one item, or reject the request.");

      // 4. Lock stock (item-id order) and re-check availability for every line before moving anything.
      const locked = await lockStock(q, toIssue.map(([itemId]) => itemId));
      const items = new Map(
        (await q.query<{ id: string; code: string; name: string; unit: string; is_active: boolean }>(
          "SELECT id, code, name, unit, is_active FROM items WHERE id = ANY($1::bigint[])",
          [toIssue.map(([itemId]) => itemId)],
        )).rows.map((it) => [String(it.id), it]),
      );
      const short: string[] = [];
      for (const [itemId, qty] of toIssue) {
        const st = locked.get(itemId)!;
        const it = items.get(itemId)!;
        if (!it.is_active) short.push(`${it.name} has been deactivated.`);
        else if (availableToIssue(st) < qty) short.push(`${it.name}: only ${availableToIssue(st)} available now, not ${qty}.`);
      }
      if (short.length) throw new AppError(409, "INSUFFICIENT_STOCK", `Nothing was issued. ${short.join(" ")} Reduce the quantity or reject.`, { problems: short });

      // 5. Issue record, then the stock movements that reference it.
      const issueRef = await nextRef(q, "ISS", now);
      const issueId = (await q.query<{ id: string }>(
        `INSERT INTO issues (ref, request_id, recipient_id, approved_by, issued_by, issued_at, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [issueRef, id, r.requester_id, actor.id, issuerId, now, d.dueDate],
      )).rows[0]!.id;
      const out: IssueResult["lines"] = [];
      for (const [itemId, qty] of toIssue) {
        await q.query("INSERT INTO issue_lines (issue_id, item_id, qty) VALUES ($1, $2, $3)", [issueId, itemId, qty]);
        const m = await applyMovement(q, locked, {
          itemId, type: "ISSUE", qty, from: "AVAILABLE", to: "ISSUED", actorId: actor.id, approvedBy: actor.id,
          source: { table: "issues", id: issueId }, remarks: issueRef, now,
        });
        out.push({ itemId, code: items.get(itemId)!.code, qty, availableAfter: m.after.available });
      }
      for (const [itemId] of requested) {
        await q.query("UPDATE request_lines SET qty_issued = $3 WHERE request_id = $1 AND item_id = $2", [id, itemId, chosen.get(itemId) ?? 0]);
      }
      await q.query("UPDATE requests SET status = 'ISSUED', decided_by = $2, decided_at = $3 WHERE id = $1 AND status = 'PENDING'", [id, actor.id, now]);
      await writeAudit(q, {
        actorId: actor.id, action: "request.issue", entity: "request", entityId: id,
        after: { issueRef, issuedBy: issuerId, dueDate: d.dueDate, lines: toIssue.map(([itemId, qty]) => ({ itemId, qty })) }, ip,
      });

      // 6. Emails to the recipient and the issuing staff member, queued in this same transaction.
      const recipient = (await q.query<{ email: string; name: string | null }>("SELECT email, name FROM users WHERE id = $1", [r.requester_id])).rows[0]!;
      const groupName = (await q.query<{ group_name: string | null }>("SELECT group_name FROM requests WHERE id = $1", [id])).rows[0]!.group_name;
      const data = {
        ref: issueRef, requestRef: r.ref, recipientName: recipient.name ?? recipient.email, groupName, issuedAt: now, dueDate: d.dueDate,
        issuedByName: issuer.name ?? issuer.email, approvedByName: approver.name ?? approver.email, appOrigin: ctx.config.APP_ORIGIN,
        lines: toIssue.map(([itemId, qty]) => ({ code: items.get(itemId)!.code, name: items.get(itemId)!.name, qty, unit: items.get(itemId)!.unit })),
      };
      const emailIds = [
        await enqueue(q, { dedupeKey: `issue:${issueId}:recipient`, kind: "issue.recipient", to: recipient.email, ...issueEmail(data, "recipient"), entity: "issue", entityId: issueId }, now),
      ];
      if (issuer.email !== recipient.email) {
        emailIds.push(await enqueue(q, { dedupeKey: `issue:${issueId}:issuer`, kind: "issue.issuer", to: issuer.email, ...issueEmail(data, "issuer"), entity: "issue", entityId: issueId }, now));
      }
      return { requestId: id, issueId, issueRef, dueDate: d.dueDate, lines: out, emailIds };
    }),
  );
  if (!replayed) await dispatchSoon(ctx, result.emailIds);
  return { ...result, replayed };
}
