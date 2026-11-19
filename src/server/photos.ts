/** Damage photographs: uploaded by store staff, viewed by staff only, checked by file signature (not by name). */
import { can } from "./auth/permissions";
import type { User } from "./auth/users";
import type { AppContext } from "./context";
import type { Queryable } from "./db/types";
import { AppError, forbidden, notFound } from "./errors";

export const MAX_PHOTO_BYTES = 1_572_864; // 1.5 MB; the browser compresses to ~300 KB first

export function sniffImage(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export async function savePhoto(ctx: AppContext, actor: User, bytes: Uint8Array): Promise<{ id: string; size: number }> {
  if (!actor.is_active || !(can(actor.role, "return.record") || can(actor.role, "incident.report"))) throw forbidden();
  if (bytes.byteLength === 0) throw new AppError(400, "PHOTO_EMPTY", "The photo is empty.");
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new AppError(413, "PHOTO_TOO_LARGE", "Photo is larger than 1.5 MB.");
  const type = sniffImage(bytes);
  if (!type) throw new AppError(400, "PHOTO_TYPE", "Only JPEG, PNG or WebP photos can be uploaded.");
  const res = await ctx.db.query<{ id: string }>(
    "INSERT INTO photos (uploaded_by, content_type, bytes, size, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [actor.id, type, Buffer.from(bytes), bytes.byteLength, ctx.now()],
  );
  return { id: res.rows[0]!.id, size: bytes.byteLength };
}

export async function getPhoto(ctx: AppContext, actor: User, id: string): Promise<{ contentType: string; bytes: Uint8Array }> {
  if (!actor.is_active || !(can(actor.role, "incident.report") || can(actor.role, "reports.view"))) throw forbidden();
  if (!/^\d+$/.test(id)) throw notFound("Photo");
  const r = (await ctx.db.query<{ content_type: string; bytes: Uint8Array }>("SELECT content_type, bytes FROM photos WHERE id = $1", [id])).rows[0];
  if (!r) throw notFound("Photo");
  return { contentType: r.content_type, bytes: r.bytes };
}

/** Inside a transaction: confirms the photo exists and marks it as in use. */
export async function linkPhoto(q: Queryable, photoId: string | null | undefined): Promise<string | null> {
  if (!photoId) return null;
  if (!/^\d+$/.test(photoId)) throw new AppError(400, "VALIDATION", "Invalid photo.");
  const r = await q.query("UPDATE photos SET linked = true WHERE id = $1 RETURNING id", [photoId]);
  if (!r.rowCount) throw new AppError(400, "VALIDATION", "The photo was not found. Upload it again.");
  return photoId;
}

/** Daily: removes photos uploaded but never attached to a return or incident (e.g. form abandoned). */
export async function purgeUnlinkedPhotos(q: Queryable, now: Date): Promise<number> {
  const r = await q.query("DELETE FROM photos WHERE NOT linked AND created_at < $1", [new Date(now.getTime() - 24 * 3600_000)]);
  return r.rowCount;
}
