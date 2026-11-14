/**
 * Excuse photos (a doctor's note taken with a phone camera) are often bigger than the 4 MB upload
 * limit, and iPhones may save them as HEIC. In the browser, before uploading, this turns such a
 * photo into a JPG small enough to upload and still easy to read. PDFs and small JPG/PNG files are
 * left exactly as they are. The server still checks every file's contents.
 */

export const UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Photos above this get shrunk, so they upload quickly on a phone connection. */
const SHRINK_ABOVE = 1.5 * 1024 * 1024;
/** Longest side in pixels: plenty to read a doctor's note. */
const MAX_SIDE = 2200;

export const EXCUSE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif";

const isHeic = (f: File) => /^image\/hei[cf]$/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

export type Prepared = { file: File; note: string | null } | { error: string };

export async function prepareExcuseFile(f: File): Promise<Prepared> {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  if (isPdf) return f.size > UPLOAD_LIMIT ? { error: "That PDF is bigger than 4 MB. Take a photo of the note instead, or scan it smaller." } : { file: f, note: null };

  const image = /^image\//i.test(f.type) || isHeic(f) || /\.(jpe?g|png)$/i.test(f.name);
  if (!image) return { error: "Choose a photo (JPG or PNG) or a PDF." };
  const needsJpg = isHeic(f) || !/^image\/(jpeg|png)$/i.test(f.type);
  if (!needsJpg && f.size <= SHRINK_ABOVE) return { file: f, note: null };

  try {
    const img = await load(f);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff"; // a PNG with transparency gets a white page, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.source, 0, 0, w, h);
    img.close();
    let blob: Blob | null = null;
    for (const q of [0.85, 0.7, 0.55]) {
      blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
      if (blob && blob.size <= UPLOAD_LIMIT) break;
    }
    if (!blob || blob.size > UPLOAD_LIMIT) return { error: "That photo is still too big after shrinking. Try taking it again a little further away." };
    const name = `${f.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "excuse"}.jpg`;
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    return { file: new File([blob], name, { type: "image/jpeg" }), note: f.size > blob.size ? `Photo made smaller for upload (${mb(f.size)} → ${mb(blob.size)}).` : null };
  } catch {
    return {
      error: isHeic(f)
        ? "This browser can't open that iPhone photo (HEIC). Take a screenshot of it and upload the screenshot, or open this page in Safari."
        : "That photo couldn't be opened. Try another photo, or a PDF.",
    };
  }
}

/** Decodes the image the right way up (phone photos carry their rotation in EXIF). */
async function load(f: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall back to <img>, e.g. Safari with HEIC */ }
  }
  const url = URL.createObjectURL(f);
  try {
    const el = new Image();
    el.decoding = "async";
    el.src = url;
    await el.decode();
    return { source: el, width: el.naturalWidth, height: el.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}
