// Shrink big raster uploads in the browser before they go to the engine.
// The engine works on a 512 px mask anyway, and Vercel functions refuse
// request bodies over 4.5 MB, so a 12-megapixel photo of a logo is downscaled
// to at most 1024 px on its longer side and re-encoded as PNG (alpha kept).
// SVGs are text and are sent untouched. An iPhone's HEIC photo is decoded
// here too (by the browser where it can, otherwise by a decoder fetched on
// demand) and always re-encoded, since the engine cannot read HEIC.

const MAX_SIDE = 1024;
const MAX_BYTES = 2.5 * 1024 * 1024;

const isHeic = (f: File) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    if (!isHeic(file)) throw err;
    // Not a browser that reads HEIC: convert it first (libheif, loaded now).
    const heic2any = (await import("heic2any")).default;
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    return createImageBitmap(Array.isArray(out) ? out[0] : out);
  }
}

export async function prepareUpload(file: File): Promise<File> {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) return file;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await decode(file);
    const side = Math.max(bmp.width, bmp.height);
    if (side <= MAX_SIDE && file.size <= MAX_BYTES && !isHeic(file)) return file;
    const s = Math.min(1, MAX_SIDE / side);
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".png";
    return new File([blob], name, { type: "image/png" });
  } catch {
    return file;
  } finally {
    bmp?.close();
  }
}
