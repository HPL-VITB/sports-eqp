/** Inventory API handlers (Phase 3). Same conventions as handlers.ts. */
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { buildTemplate, commitImport, previewImport } from "../inventory/import";
import { createItem, getItem, listItems, receiveStock, updateItem } from "../inventory/items";
import {
  createCategory,
  createLocation,
  createSport,
  listCategories,
  listLocations,
  listSports,
  updateCategory,
  updateLocation,
  updateSport,
} from "../inventory/masterdata";
import { MAX_UPLOAD_BYTES } from "../inventory/spreadsheet";
import { clientIp, handle, json, readJson, requireUser } from "./handlers";

const params = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
const withId = (fn: (ctx: AppContext, req: Request, id: string) => Promise<Response>) => (ctx: AppContext, req: Request, id: string) =>
  handle((c, r) => fn(c, r, id))(ctx, req);

// ---------- master data ----------

export const listSportsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ sports: await listSports(ctx, user, { includeInactive: params(req).all === "1" }) });
});
export const createSportHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ sport: await createSport(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const updateSportHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ sport: await updateSport(ctx, user, id, await readJson(req), clientIp(req)) });
});

export const listCategoriesHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  const p = params(req);
  return json({ categories: await listCategories(ctx, user, { sportId: p.sportId, includeInactive: p.all === "1" }) });
});
export const createCategoryHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ category: await createCategory(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const updateCategoryHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ category: await updateCategory(ctx, user, id, await readJson(req), clientIp(req)) });
});

export const listLocationsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ locations: await listLocations(ctx, user, { includeInactive: params(req).all === "1" }) });
});
export const createLocationHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ location: await createLocation(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const updateLocationHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ location: await updateLocation(ctx, user, id, await readJson(req), clientIp(req)) });
});

// ---------- items and stock ----------

export const listItemsHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json(await listItems(ctx, user, params(req)));
});
export const createItemHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  return json({ item: await createItem(ctx, user, await readJson(req), clientIp(req)) }, 201);
});
export const getItemHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json(await getItem(ctx, user, id, { movementsBefore: params(req).before }));
});
export const updateItemHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json({ item: await updateItem(ctx, user, id, await readJson(req), clientIp(req)) });
});
export const receiveStockHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  const r = await receiveStock(ctx, user, id, await readJson(req));
  return json({ receipt: r }, r.replayed ? 200 : 201);
});

// ---------- Excel import ----------

export const importTemplateHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  const bytes = await buildTemplate(ctx, user);
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="stock-import-template.xlsx"',
      "cache-control": "no-store",
    },
  });
});

export const importPreviewHandler = handle(async (ctx, req) => {
  const user = await requireUser(ctx, req);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_UPLOAD_BYTES + 64_000) throw new AppError(413, "FILE_TOO_LARGE", "File is larger than 2 MB.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError(400, "BAD_UPLOAD", "Upload a file using the form.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new AppError(400, "BAD_UPLOAD", "Choose an .xlsx or .csv file.");
  if (!/\.(xlsx|csv|xls)$/i.test(file.name)) throw new AppError(400, "BAD_UPLOAD", "Only .xlsx and .csv files can be imported.");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(413, "FILE_TOO_LARGE", "File is larger than 2 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return json(await previewImport(ctx, user, { name: file.name, bytes }));
});

export const importCommitHandler = withId(async (ctx, req, id) => {
  const user = await requireUser(ctx, req);
  return json(await commitImport(ctx, user, id, clientIp(req)));
});
