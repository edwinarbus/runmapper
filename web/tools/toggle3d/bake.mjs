// Bake the switch (toggle3d.html) into public/toggle.png and public/toggle.webp:
// fifteen frames of the lever's lean, -35 to +35 degrees in steps of five,
// rendered by three.js in a headless Chromium and cut to one strip.
//
//   cd web/tools/toggle3d && npm init -y && npm i three@0.170.0
//   python3 -m http.server 3399 --bind 127.0.0.1 &
//   node bake.mjs            # needs playwright (the web app's own) and Pillow for the strip
//
import { mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const here = new URL(".", import.meta.url).pathname;
const frames = `${here}frames`;
mkdirSync(frames, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
await page.goto("http://127.0.0.1:3399/toggle3d.html?size=576", { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
let k = 0;
for (let a = -35; a <= 35; a += 5) {
  await page.evaluate((a) => window.setAngle(a), a);
  await page.waitForTimeout(60);
  await page.locator("canvas").screenshot({ path: `${frames}/f${String(k).padStart(2, "0")}.png`, omitBackground: true });
  k++;
}
await browser.close();
// one crop for every frame (the union of everything drawn, squared off), 156px a frame (3x of 52px)
execFileSync("python3", ["-c", `
import glob, numpy as np
from PIL import Image
files = sorted(glob.glob("${frames}/f*.png"))
ims = [Image.open(f).convert("RGBA") for f in files]
x0 = y0 = 10**9; x1 = y1 = -1
for im in ims:
    a = np.array(im)[..., 3]; ys, xs = np.where(a > 8)
    x0, y0, x1, y1 = min(x0, xs.min()), min(y0, ys.min()), max(x1, xs.max()), max(y1, ys.max())
x0, y0, x1, y1 = x0 - 12, y0 - 12, x1 + 12, y1 + 12
side = max(x1 - x0, y1 - y0); cx = (x0 + x1) // 2
box = (cx - side // 2, y1 - side, cx - side // 2 + side, y1)
OUT = 156
fr = [im.crop(box).resize((OUT, OUT), Image.LANCZOS) for im in ims]
strip = Image.new("RGBA", (OUT * len(fr), OUT), (0, 0, 0, 0))
for i, f in enumerate(fr): strip.paste(f, (i * OUT, 0))
strip.save("${here}../../public/toggle.png", optimize=True)
strip.save("${here}../../public/toggle.webp", quality=92, method=6)
print("baked", len(fr), "frames")
`], { stdio: "inherit" });
console.log("done:", readdirSync(frames).length, "frames");
