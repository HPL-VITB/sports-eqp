/**
 * THE ONLY CODE THAT CHANGES STOCK BALANCES.
 * Every change updates item_stock and appends a stock_movements row in the same transaction.
 * Callers must lock the stock rows first with lockStock() (always in item-id order, which prevents deadlocks).
 */
import type { Queryable } from "../db/types";
import { AppError } from "../errors";

export const STATES = ["AVAILABLE", "ISSUED", "DAMAGED", "MISSING", "DISCARDED"] as const;
export type StockState = (typeof STATES)[number];

export type MovementType =
  | "OPENING"
  | "RECEIPT"
  | "ISSUE"
  | "RETURN_USABLE"
  | "RETURN_DAMAGED"
  | "RETURN_MISSING"
  | "STORE_DAMAGE"
  | "MARK_USABLE"
  | "RECOVERED"
  | "DISCARD"
  | "CORRECTION"
  | "REVERSAL";

export interface StockRow {
  item_id: string;
  available: number;
  issued: number;
  damaged: number;
  missing: number;
  discarded: number;
  reserved: number;
}

const COLUMN: Record<StockState, keyof Omit<StockRow, "item_id" | "reserved">> = {
  AVAILABLE: "available",
  ISSUED: "issued",
  DAMAGED: "damaged",
  MISSING: "missing",
  DISCARDED: "discarded",
};

export function snapshot(s: StockRow) {
  return { available: s.available, issued: s.issued, damaged: s.damaged, missing: s.missing, discarded: s.discarded };
}

/** Total accountable stock = available + issued + damaged + missing (discarded is history only). */
export function accountable(s: Pick<StockRow, "available" | "issued" | "damaged" | "missing">): number {
  return s.available + s.issued + s.damaged + s.missing;
}

/** Units that can be issued now: available minus any held by pending discards. */
export function availableToIssue(s: Pick<StockRow, "available" | "reserved">): number {
  return Math.max(0, s.available - s.reserved);
}

export type LockedStock = Map<string, StockRow>;

/** SELECT … FOR UPDATE on the stock rows, in item-id order. Missing ids raise 404. */
export async function lockStock(q: Queryable, itemIds: readonly string[]): Promise<LockedStock> {
  const ids = [...new Set(itemIds)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const res = await q.query<StockRow>(
    `SELECT item_id, available, issued, damaged, missing, discarded, reserved
       FROM item_stock WHERE item_id = ANY($1::bigint[]) ORDER BY item_id FOR UPDATE`,
    [ids],
  );
  const map: LockedStock = new Map(res.rows.map((r) => [String(r.item_id), r]));
  for (const id of ids) if (!map.has(id)) throw new AppError(404, "NOT_FOUND", `Item ${id} not found.`);
  return map;
}

export interface MovementInput {
  itemId: string;
  type: MovementType;
  qty: number;
  from: StockState | null;
  to: StockState | null;
  actorId: string | null;
  approvedBy?: string | null;
  source?: { table: string; id: string };
  reversesId?: string | null;
  remarks?: string | null;
  now: Date;
}

export interface AppliedMovement {
  movementId: string;
  before: ReturnType<typeof snapshot>;
  after: ReturnType<typeof snapshot>;
}

/**
 * Moves `qty` units from one state to another (null = outside accountable stock).
 * Refuses to take a state below zero. Updates the locked row in `locked` so several movements in one
 * transaction see each other.
 */
export async function applyMovement(q: Queryable, locked: LockedStock, m: MovementInput): Promise<AppliedMovement> {
  if (!Number.isInteger(m.qty) || m.qty <= 0) throw new AppError(400, "QTY_INVALID", "Quantity must be a whole number above zero.");
  if (m.from === m.to) throw new Error("Movement must change state");
  const row = locked.get(String(m.itemId));
  if (!row) throw new Error(`applyMovement: item ${m.itemId} was not locked first`);

  const before = snapshot(row);
  const next = { ...row };
  if (m.from) {
    const col = COLUMN[m.from];
    if (next[col] < m.qty) {
      throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${next[col]} ${m.from.toLowerCase()} — cannot move ${m.qty}.`, {
        itemId: m.itemId,
        state: m.from,
        have: next[col],
        want: m.qty,
      });
    }
    next[col] -= m.qty;
  }
  if (m.to) next[COLUMN[m.to]] += m.qty;

  await q.query(
    `UPDATE item_stock SET available = $2, issued = $3, damaged = $4, missing = $5, discarded = $6, updated_at = $7
      WHERE item_id = $1`,
    [m.itemId, next.available, next.issued, next.damaged, next.missing, next.discarded, m.now],
  );
  const after = snapshot(next);
  const ins = await q.query<{ id: string }>(
    `INSERT INTO stock_movements
       (item_id, type, qty, from_state, to_state, before, after, source_table, source_id, actor_id, approved_by, reverses_id, remarks, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      m.itemId,
      m.type,
      m.qty,
      m.from,
      m.to,
      JSON.stringify(before),
      JSON.stringify(after),
      m.source?.table ?? null,
      m.source?.id ?? null,
      m.actorId,
      m.approvedBy ?? null,
      m.reversesId ?? null,
      m.remarks ?? null,
      m.now,
    ],
  );
  locked.set(String(m.itemId), next);
  return { movementId: ins.rows[0]!.id, before, after };
}

/** Rows where the stored balance disagrees with the ledger. Should always be empty. */
export async function ledgerMismatches(q: Queryable): Promise<Record<string, unknown>[]> {
  const res = await q.query("SELECT * FROM stock_ledger_mismatches");
  return res.rows;
}
