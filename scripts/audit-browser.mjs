// Read-only public deployment inspection. No login, invoice creation, or payment actions.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const width of [360, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const route of ["/", "/scan", "/login", "/app/terminal", "/app/links"]) {
      const errors = [];
      const handler = e => errors.push(e.message.slice(0, 150));
      page.on("pageerror", handler);
      const response = await page.goto(`https://zebrascan.vercel.app${route}`, { waitUntil: "networkidle", timeout: 30000 });
      const text = await page.locator("body").innerText();
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth }));
      const file = `public-${route.replaceAll("/", "-") || "home"}-${width}.png`;
      await page.screenshot({ path: `docs/evidence/audit-2026-11-04/${file}`, fullPage: true });
      results.push({ route, width, status: response.status(), finalUrl: page.url(), headings: await page.locator("h1").allTextContents(), demo: /demo|simulation|simulated/i.test(text), dimensions, errors, screenshot: file });
      page.off("pageerror", handler);
    }
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync("docs/evidence/audit-2026-11-04/public-browser.json", JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
