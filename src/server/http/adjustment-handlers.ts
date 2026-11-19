/** Discards, corrections, stock counts and reversals (Phase 6). */
import { cancelCorrection, decideCorrection, listCorrections, requestCorrection } from "../adjustments/corrections";
import { cancelDiscard, decideDiscard, listDiscards, requestDiscard } from "../adjustments/discards";
import { reverseReceipt } from "../adjustments/reversal";
import { abandonCount, getCount, listCounts, saveCounts, startCount, submitCount } from "../adjustments/verification";
import type { AppContext } from "../context";
import { clientIp, handle, json, readJson, requireUser } from "./handlers";

const params = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
const withId = (fn: (ctx: AppContext, req: Request, id: string) => Promise<Response>) => (ctx: AppContext, req: Request, id: string) =>
  handle((c, r) => fn(c, r, id))(ctx, req);

export const listDiscardsHandler = handle(async (ctx, req) => json({ discards: await listDiscards(ctx, await requireUser(ctx, req), params(req)) }));
export const requestDiscardHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ discard: await requestDiscard(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const decideDiscardHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ discard: await decideDiscard(ctx, user, id, await readJson(req), clientIp(req)) });
});
export const cancelDiscardHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ discard: await cancelDiscard(ctx, user, id, clientIp(req)) });
});

export const listCorrectionsHandler = handle(async (ctx, req) => json({ corrections: await listCorrections(ctx, await requireUser(ctx, req), params(req)) }));
export const requestCorrectionHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ correction: await requestCorrection(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const decideCorrectionHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ correction: await decideCorrection(ctx, user, id, await readJson(req), clientIp(req)) });
});
export const cancelCorrectionHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ correction: await cancelCorrection(ctx, user, id, clientIp(req)) });
});

export const listCountsHandler = handle(async (ctx, req) => json({ counts: await listCounts(ctx, await requireUser(ctx, req)) }));
export const startCountHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ count: await startCount(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const getCountHandler = withId(async (ctx, req, id) => json({ count: await getCount(ctx, await requireUser(ctx, req), id) }));
export const saveCountHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json(await saveCounts(ctx, user, id, await readJson(req)));
});
export const submitCountHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ result: await submitCount(ctx, user, id, clientIp(req)) });
});
export const abandonCountHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ result: await abandonCount(ctx, user, id, clientIp(req)) });
});

export const reverseMovementHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ reversal: await reverseReceipt(ctx, user, id, await readJson(req), clientIp(req)) }, 201);
});
