/** Requests, issues and email delivery API handlers (Phase 4). */
import type { AppContext } from "../context";
import { dispatch, listNotifications, notificationCounts, resendNotification } from "../notify/outbox";
import {
  approveAndIssue,
  cancelRequest,
  catalog,
  createRequest,
  getRequest,
  issuerOptions,
  listRequests,
  rejectRequest,
  setReady,
} from "../requests/requests";
import { assertCronSecret, clientIp, handle, json, readJson, requireUser } from "./handlers";

const params = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
const withId = (fn: (ctx: AppContext, req: Request, id: string) => Promise<Response>) => (ctx: AppContext, req: Request, id: string) =>
  handle((c, r) => fn(c, r, id))(ctx, req);

export const catalogHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ items: await catalog(ctx, user, params(req)) });
});

export const listRequestsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ requests: await listRequests(ctx, user, params(req)) });
});

export const createRequestHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ request: await createRequest(ctx, user, await readJson(req), clientIp(req)) }, 201);
});

export const getRequestHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ request: await getRequest(ctx, user, id) });
});

export const cancelRequestHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ request: await cancelRequest(ctx, user, id, clientIp(req)) });
});

export const readyRequestHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ request: await setReady(ctx, user, id, await readJson(req), clientIp(req)) });
});

export const rejectRequestHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ request: await rejectRequest(ctx, user, id, await readJson(req), clientIp(req)) });
});

export const issueRequestHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  const result = await approveAndIssue(ctx, user, id, await readJson(req), clientIp(req));
  return json({ issue: result }, result.replayed ? 200 : 201);
});

export const issuersHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ issuers: await issuerOptions(ctx, user) });
});

export const listEmailsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  const p = params(req);
  const emails = await listNotifications(ctx, user, { status: p.status, limit: Number(p.limit ?? 100) || 100 });
  return json({ emails, counts: await notificationCounts(ctx.db) });
});

export const resendEmailHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ email: await resendNotification(ctx, user, id, clientIp(req)) });
});

/** Called every 15 minutes by .github/workflows/email-retry.yml with "Authorization: Bearer $CRON_SECRET". */
export const dispatchCronHandler = handle(async (ctx, req) => {
  assertCronSecret(ctx, req);
  return json(await dispatch(ctx, { limit: 200 }));
});
