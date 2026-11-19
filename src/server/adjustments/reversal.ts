/**
 * FR Sports reverses a stock receipt (or opening stock) entered by mistake, e.g. 200 typed instead of 20.
 * A linked REVERSAL movement takes the units back out; the original stays in the history. Each movement can be
 * reversed once. Other mistakes are fixed through the normal flows (returns, damage records, corrections), which
 * keep issue and incident records consistent.
 */
import { z } from "zod";
import { writeAudit } from "../audit";
import { requirePermission } from "../auth/permissions";
import type { User } from "../auth/users";
import type { AppContext } from "../context";
import { PG, pgCode } from "../db/types";
import { AppError, notFound } from "../errors";
import { applyMovement, availableToIssue, lockStock } from "../inventory/ledger";

const schema = z.object({ reason: z.string().trim().min(5, "Explain what was wrong.").max(300) });

export async function reverseReceipt(ctx: AppContext, actor: User, movementId: string, input: unknown, ip: string | null) {
  requirePermission(actor, "movement.reverse");
  if (!/^\d+$/.test(movementId)) throw notFound("Movement");
  const p = schema.safeParse(input);
  if (!p.success) throw new AppError(400, "VALIDATION", p.error.issues[0]?.message ?? "Invalid input.");
  try {
    return await ctx.db.tx(async (q) => {
      const m = (await q.query<{ item_id: string; type: string; qty: number }>("SELECT item_id, type, qty FROM stock_movements WHERE id = $1", [movementId])).rows[0];
      if (!m) throw notFound("Movement");
      if (m.type !== "RECEIPT" && m.type !== "OPENING") {
        throw new AppError(400, "NOT_REVERSIBLE", "Only stock receipts and opening stock can be reversed. Use a return, damage record or correction for other changes.");
      }
      const already = await q.query("SELECT 1 FROM stock_movements WHERE reverses_id = $1", [movementId]);
      if (already.rowCount) throw new AppError(409, "ALREADY_REVERSED", "This entry has already been reversed.");
      const itemId = String(m.item_id);
      const locked = await lockStock(q, [itemId]);
      const free = availableToIssue(locked.get(itemId)!);
      if (free < m.qty) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${free} of the ${m.qty} units are still in the store and free; the rest have been issued or are held. Use a stock correction instead.`);
      }
      const r = await applyMovement(q, locked, {
        itemId, type: "REVERSAL", qty: m.qty, from: "AVAILABLE", to: null, actorId: actor.id, approvedBy: actor.id,
        reversesId: movementId, remarks: `Reversal of entry #${movementId}: ${p.data.reason}`, now: ctx.now(),
      });
      await writeAudit(q, { actorId: actor.id, action: "movement.reverse", entity: "stock_movement", entityId: movementId, before: r.before, after: r.after, ip });
      return { reversedId: movementId, movementId: r.movementId, stockAfter: r.after };
    });
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION) throw new AppError(409, "ALREADY_REVERSED", "This entry has already been reversed.");
    throw err;
  }
}
