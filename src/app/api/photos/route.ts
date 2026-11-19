import { uploadPhotoHandler } from "@/server/http/return-handlers";
import { getAppContext } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return uploadPhotoHandler(getAppContext(), req);
}
