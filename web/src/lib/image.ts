// Shrink big raster uploads in the browser before they go to the engine.
// The engine works on a 512 px mask anyway, and Vercel functions refuse
// request bodies over 4.5 MB, so a 12-megapixel photo of a logo is downscaled
// to at most 1024 px on its longer side and re-encoded as PNG (alpha kept).
// SVGs are text and are sent untouched.

const MAX_SIDE = 1024;
const MAX_BYTES = 2.5 * 1024 * 1024;

export async function prepareUpload(file: File): Promise<File> {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) return file;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file);
    const side = Math.max(bmp.width, bmp.height);
    if (side <= MAX_SIDE && file.size <= MAX_BYTES) return file;
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
