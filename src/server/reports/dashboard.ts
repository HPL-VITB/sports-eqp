/** Dashboard: stock totals, items needing action for this role, recent activity, sport- and location-wise summaries. */
import { can, requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { todayIST } from "../time";

export async function getDashboard(ctx: AppContext, actor: User) {
  requirePermission(actor, "dashboard.view");
  const db = ctx.db;
  const today = todayIST(ctx.now());

  const [totals, counts, overdue, pending, recentIssues, recentReturns, lowStock, bySport, byLocation] = await Promise.all([
    db.query<{ items: number; available: number; reserved: number; issued: number; damaged: number; missing: number }>(
      `SELECT count(*)::int AS items, coalesce(sum(st.available),0)::int AS available, coalesce(sum(st.reserved),0)::int AS reserved,
              coalesce(sum(st.issued),0)::int AS issued, coalesce(sum(st.damaged),0)::int AS damaged, coalesce(sum(st.missing),0)::int AS missing
         FROM items i JOIN item_stock st ON st.item_id = i.id WHERE i.is_active`,
    ),
    db.query<{ pending_requests: number; ready_requests: number; open_issues: number; overdue_issues: number; pending_discards: number; pending_corrections: number; open_counts: number; failed_emails: number; low_stock: number; open_incidents: number }>(
      `SELECT (SELECT count(*)::int FROM requests WHERE status = 'PENDING') AS pending_requests,
              (SELECT count(*)::int FROM requests WHERE status = 'PENDING' AND ready) AS ready_requests,
              (SELECT count(*)::int FROM issues WHERE status = 'ISSUED') AS open_issues,
              (SELECT count(*)::int FROM issues WHERE status = 'ISSUED' AND due_date < $1::date) AS overdue_issues,
              (SELECT count(*)::int FROM discard_requests WHERE status = 'PENDING') AS pending_discards,
              (SELECT count(*)::int FROM adjustments WHERE status = 'PENDING') AS pending_corrections,
              (SELECT count(*)::int FROM verification_sessions WHERE status = 'OPEN') AS open_counts,
              (SELECT count(*)::int FROM notifications WHERE status = 'FAILED') AS failed_emails,
              (SELECT count(*)::int FROM items i JOIN item_stock st ON st.item_id = i.id
                WHERE i.is_active AND i.min_stock IS NOT NULL AND st.available - st.reserved < i.min_stock) AS low_stock,
              (SELECT count(*)::int FROM incidents WHERE qty_resolved < qty) AS open_incidents`,
      [today],
    ),
    db.query<{ issue_id: string; request_id: string; ref: string; recipient: string; univ_id: string | null; due_date: string; days: number; items: string }>(
      `SELECT i.id AS issue_id, i.request_id, i.ref, coalesce(u.name, u.email) AS recipient, u.univ_id, i.due_date::text AS due_date, ($1::date - i.due_date) AS days,
              (SELECT string_agg(l.qty || ' × ' || it.name, ', ' ORDER BY l.id) FROM issue_lines l JOIN items it ON it.id = l.item_id WHERE l.issue_id = i.id) AS items
         FROM issues i JOIN users u ON u.id = i.recipient_id WHERE i.status = 'ISSUED' AND i.due_date < $1::date ORDER BY i.due_date LIMIT 8`,
      [today],
    ),
    db.query<{ id: string; ref: string; requester: string; created_at: Date; ready: boolean; items: string }>(
      `SELECT r.id, r.ref, coalesce(u.name, u.email) AS requester, r.created_at, r.ready,
              (SELECT string_agg(l.qty_requested || ' × ' || it.name, ', ' ORDER BY l.id) FROM request_lines l JOIN items it ON it.id = l.item_id WHERE l.request_id = r.id) AS items
         FROM requests r JOIN users u ON u.id = r.requester_id WHERE r.status = 'PENDING' ORDER BY r.ready DESC, r.created_at LIMIT 8`,
    ),
    db.query<{ request_id: string; ref: string; recipient: string; at: Date; due_date: string }>(
      `SELECT i.request_id, i.ref, coalesce(u.name, u.email) AS recipient, i.issued_at AS at, i.due_date::text AS due_date
         FROM issues i JOIN users u ON u.id = i.recipient_id ORDER BY i.issued_at DESC LIMIT 6`,
    ),
    db.query<{ issue_id: string; ref: string; recipient: string; at: Date; problems: boolean }>(
      `SELECT i.id AS issue_id, i.ref, coalesce(u.name, u.email) AS recipient, i.returned_at AS at,
              EXISTS (SELECT 1 FROM return_lines rl WHERE rl.issue_id = i.id AND rl.qty_damaged + rl.qty_missing + rl.qty_consumed > 0) AS problems
         FROM issues i JOIN users u ON u.id = i.recipient_id WHERE i.status = 'RETURNED' ORDER BY i.returned_at DESC LIMIT 6`,
    ),
    db.query<{ id: string; code: string; name: string; available: number; min_stock: number }>(
      `SELECT i.id, i.code, i.name, st.available - st.reserved AS available, i.min_stock
         FROM items i JOIN item_stock st ON st.item_id = i.id
        WHERE i.is_active AND i.min_stock IS NOT NULL AND st.available - st.reserved < i.min_stock
        ORDER BY (st.available - st.reserved)::float / greatest(i.min_stock, 1), i.name LIMIT 10`,
    ),
    db.query<{ id: string; name: string; items: number; available: number; issued: number; damaged: number; missing: number }>(
      `SELECT s.id, s.name, count(i.id)::int AS items, coalesce(sum(st.available),0)::int AS available, coalesce(sum(st.issued),0)::int AS issued,
              coalesce(sum(st.damaged),0)::int AS damaged, coalesce(sum(st.missing),0)::int AS missing
         FROM sports s JOIN items i ON i.sport_id = s.id AND i.is_active JOIN item_stock st ON st.item_id = i.id
        GROUP BY s.id, s.name ORDER BY s.name`,
    ),
    db.query<{ id: string; name: string; items: number; available: number; damaged: number }>(
      `SELECT l.id, CASE WHEN p.id IS NULL THEN l.name ELSE p.name || ' › ' || l.name END AS name, count(i.id)::int AS items,
              coalesce(sum(st.available),0)::int AS available, coalesce(sum(st.damaged),0)::int AS damaged
         FROM locations l LEFT JOIN locations p ON p.id = l.parent_id JOIN items i ON i.location_id = l.id AND i.is_active JOIN item_stock st ON st.item_id = i.id
        GROUP BY l.id, l.name, p.id, p.name ORDER BY 2`,
    ),
  ]);

  const t = totals.rows[0]!;
  const c = counts.rows[0]!;
  // "Needs action" lists only what this role can act on.
  const actions: { label: string; count: number; href: string }[] = [];
  const add = (cond: boolean, label: string, count: number, href: string) => {
    if (cond && count > 0) actions.push({ label, count, href });
  };
  add(can(actor.role, "request.approveIssue"), "Requests waiting for approval", c.pending_requests, "/requests?tab=PENDING");
  add(!can(actor.role, "request.approveIssue") && can(actor.role, "request.markReady"), "Requests to prepare", c.pending_requests - c.ready_requests, "/requests?tab=PENDING");
  add(can(actor.role, "return.record"), "Overdue equipment", c.overdue_issues, "/requests?tab=OVERDUE");
  add(can(actor.role, "discard.approve"), "Discards waiting for your approval", c.pending_discards, "/adjustments/discards");
  add(can(actor.role, "adjustment.approve"), "Corrections waiting for your approval", c.pending_corrections, "/adjustments/corrections");
  add(can(actor.role, "verification.count"), "Stock counts in progress", c.open_counts, "/adjustments/counts");
  add(can(actor.role, "damaged.markUsable") || can(actor.role, "return.record"), "Open damage / missing records", c.open_incidents, "/adjustments");
  add(can(actor.role, "stock.receive"), "Items below minimum stock", c.low_stock, "/inventory?lowStock=1");
  add(can(actor.role, "users.manage"), "Emails that could not be delivered", c.failed_emails, "/admin/emails?status=FAILED");

  return {
    today,
    stock: { items: t.items, available: t.available - t.reserved, held: t.reserved, issued: t.issued, damaged: t.damaged, missing: t.missing, accountable: t.available + t.issued + t.damaged + t.missing },
    counts: {
      pendingRequests: c.pending_requests, openIssues: c.open_issues, overdueIssues: c.overdue_issues, pendingDiscards: c.pending_discards,
      pendingCorrections: c.pending_corrections, lowStock: c.low_stock, failedEmails: c.failed_emails, openIncidents: c.open_incidents,
    },
    actions,
    overdue: overdue.rows,
    pending: pending.rows,
    recentIssues: recentIssues.rows,
    recentReturns: recentReturns.rows,
    lowStock: lowStock.rows,
    bySport: bySport.rows,
    byLocation: byLocation.rows,
  };
}
export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;
