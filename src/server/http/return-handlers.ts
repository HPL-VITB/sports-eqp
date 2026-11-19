/** Returns, incidents, photos, reminder settings and the daily job (Phase 5). */
import { purgeExpired } from "../auth/otp";
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { ledgerMismatches } from "../inventory/ledger";
import { getPhoto, MAX_PHOTO_BYTES, purgeUnlinkedPhotos, savePhoto } from "../photos";
import { listIncidents, reportStoreDamage, resolveIncident } from "../returns/incidents";
import { getReminderSettings, runOverdueReminders, updateReminderSettings } from "../returns/reminders";
import { getIssue, recordReturn } from "../returns/returns";
import { requirePermission } from "../auth/permissions";
import { assertCronSecret, clientIp, handle, json, readJson, requireUser } from "./handlers";

const params = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
const withId = (fn: (ctx: AppContext, req: Request, id: string) => Promise<Response>) => (ctx: AppContext, req: Request, id: string) =>
  handle((c, r) => fn(c, r, id))(ctx, req);

export const getIssueHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ issue: await getIssue(ctx, user, id) });
});

export const returnIssueHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  const r = await recordReturn(ctx, user, id, await readJson(req), clientIp(req));
  return json({ return: r }, r.replayed ? 200 : 201);
});

export const listIncidentsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ incidents: await listIncidents(ctx, user, params(req)) });
});

export const storeDamageHandler = withId(async (ctx, req, itemId) => {
  const user = await requireUser(ctx, req);
  return json({ result: await reportStoreDamage(ctx, user, itemId, await readJson(req), clientIp(req)) }, 201);
});

export const resolveIncidentHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ result: await resolveIncident(ctx, user, id, await readJson(req), clientIp(req)) });
});

export const uploadPhotoHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  if (Number(req.headers.get("content-length") ?? "0") > MAX_PHOTO_BYTES + 64_000) throw new AppError(413, "PHOTO_TOO_LARGE", "Photo is larger than 1.5 MB.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError(400, "BAD_UPLOAD", "Upload the photo using the form.");
  }
  const file = form.get("photo");
  if (!file || typeof file === "string") throw new AppError(400, "BAD_UPLOAD", "Choose a photo.");
  return json({ photo: await savePhoto(ctx, user, new Uint8Array(await file.arrayBuffer())) }, 201);
});

export const getPhotoHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  const p = await getPhoto(ctx, user, id);
  return new Response(new Blob([p.bytes as Uint8Array<ArrayBuffer>]), {
    headers: {
      "content-type": p.contentType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'",
    },
  });
});

export const getReminderSettingsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  requirePermission(user, "masterdata.manage");
  return json({ settings: await getReminderSettings(ctx.db) });
});

export const updateReminderSettingsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ settings: await updateReminderSettings(ctx, user, await readJson(req), clientIp(req)) });
});

/**
 * Daily job (Vercel Cron 09:00 IST): overdue reminders, housekeeping, unattached photos, ledger check.
 * Each part runs even if another fails; a failed part is reported, never hidden.
 */
export const dailyHandler = handle(async (ctx, req) => {
  assertCronSecret(ctx, req);
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      console.error(`Daily job step ${name} failed`, err);
      out[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  };
  await step("reminders", () => runOverdueReminders(ctx));
  await step("purge", () => purgeExpired(ctx));
  await step("photos", () => purgeUnlinkedPhotos(ctx.db, ctx.now()));
  await step("ledger", async () => {
    const m = await ledgerMismatches(ctx.db);
    if (m.length) console.error("STOCK LEDGER MISMATCH", JSON.stringify(m));
    return { mismatches: m.length };
  });
  const failed = Object.values(out).some((v) => typeof v === "object" && v !== null && "error" in v);
  return json(out, failed ? 500 : 200);
});
