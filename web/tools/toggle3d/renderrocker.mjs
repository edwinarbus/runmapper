// Bake the rocker into two strips of seven frames of the paddle's lean:
// public/rocker.* (the units switch) and public/rocker-lamp.* (loop's, its lamp
// lit once the paddle is past centre).
import pw from "/home/user/runmapper/web/node_modules/playwright/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { chromium } = pw;
const S = "/tmp/claude-0/-home-user-apt/7e8492f6-f7e1-5666-87c5-11105ed98b6c/scratchpad/three3d";
mkdirSync(`${S}/rframes`, { recursive: true });
// The lean, from the left end pressed (off, or the left legend) to the right end
// pressed (on, or the right legend); the middle frames carry the snap between them.
const ANGLES = [16, 8, 0, -8, -16];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-proxy-server", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
for (const [kind, lamp] of [["rocker", 0], ["rocker-lamp", 1]]) {
  for (let i = 0; i < ANGLES.length; i++) {
    const lit = lamp && i >= 3 ? 1 : 0;      // the contact closes as it passes centre
    await page.goto(`http://127.0.0.1:3399/rocker3d.html?angle=${ANGLES[i]}&lamp=${lamp}&lit=${lit}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await page.waitForTimeout(60);
    const data = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
    writeFileSync(`${S}/rframes/${kind}-${i}.png`, Buffer.from(data.split(",")[1], "base64"));
  }
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
// the frames of each kind, cut into one strip
execFileSync("python3", ["-c", `
import os
from PIL import Image
for kind in ("rocker", "rocker-lamp"):
    fr = [Image.open(f"${S}/rframes/{kind}-{i}.png").convert("RGBA") for i in range(${ANGLES.length})]
    w, h = fr[0].size
    strip = Image.new("RGBA", (w * len(fr), h), (0, 0, 0, 0))
    for i, f in enumerate(fr): strip.paste(f, (i * w, 0))
    strip.save(f"${S}/../../../../../../../home/user/runmapper/web/public/{kind}.png", optimize=True)
    strip.save(f"${S}/../../../../../../../home/user/runmapper/web/public/{kind}.webp", quality=92, method=6)
    print(kind, strip.size)
`], { stdio: "inherit" });
