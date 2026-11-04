// Captures route screenshots for docs/UI_SIMPLIFICATION_AUDIT.md. Usage: node tests/shots.mjs <outDir> <baseUrl>
import { chromium } from "@playwright/test";
const [out, base] = process.argv.slice(2);
const routes = [["home", "/"], ["scan", "/scan"], ["login", "/login"], ["app", "/app"], ["terminal", "/app/terminal"], ["balance", "/app/balance"], ["links", "/app/links"]];
const browser = await chromium.launch({ channel: "chrome" });
for (const [w, h, tag] of [[375, 812, "m"], [1440, 900, "d"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(base + "/login");
  const sample = page.getByRole("button", { name: "Explore demo merchant account" });
  if (await sample.isVisible().catch(() => false)) { await sample.click(); await page.waitForURL("**/app"); }
  for (const [name, path] of routes) {
    await page.goto(base + path);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${name}-${tag}.png`, fullPage: false });
  }
  await page.goto(base + "/app"); const metrics = await page.evaluate(() => ({ sidebar: [...document.querySelectorAll("aside")].filter((a) => a.getBoundingClientRect().width > 0 && getComputedStyle(a).position === "fixed").map((a) => a.getBoundingClientRect().width), vw: window.innerWidth, primaryButtons: document.querySelectorAll("main a.bg-gold, main button.bg-gold").length }));
  console.log(tag, JSON.stringify(metrics));
  await ctx.close();
}
await browser.close();
