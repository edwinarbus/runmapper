// Render the start key in its four looks and cut each to a border image.
import pw from "/home/user/runmapper/web/node_modules/playwright/index.js";
const { chromium } = pw;
import { writeFileSync } from "node:fs";
const S = "/tmp/claude-0/-home-user-apt/7e8492f6-f7e1-5666-87c5-11105ed98b6c/scratchpad/three3d";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-proxy-server", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
for (const tone of ["orange", "dark"]) for (const state of ["up", "down"]) {
  await page.goto(`http://127.0.0.1:3399/key3d.html?state=${state}&tone=${tone}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(100);
  const data = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png"));
  writeFileSync(`${S}/key-${tone}-${state}.png`, Buffer.from(data.split(",")[1], "base64"));
}
console.log("errors:", errors.length ? errors : "none");
await browser.close();
