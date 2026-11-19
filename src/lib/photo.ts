/** Shrinks a phone photo to at most 1600 px and JPEG quality 0.8 (~300 KB), then uploads it. Returns the photo id. */
export async function uploadPhoto(file: File): Promise<string> {
  let blob: Blob = file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", 0.8));
  } catch {
    // Browser could not decode it (e.g. HEIC on some devices): send the original; the server checks type and size.
  }
  const form = new FormData();
  form.append("photo", blob, "damage.jpg");
  const res = await fetch("/api/photos", { method: "POST", body: form, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? "Photo upload failed.");
  return data.photo.id as string;
}
