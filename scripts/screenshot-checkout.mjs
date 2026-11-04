// Screenshot a real (connected-mode) checkout page. Usage:
//   node scripts/screenshot-checkout.mjs <checkoutId> <accessToken> <out.png> [baseUrl]
import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";

const [id, token, out, base = "http://localhost:3001"] = process.argv.slice(2);
if (!id || !token || !out) throw new Error("usage: <checkoutId> <accessToken> <out.png> [baseUrl]");
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 430, height: 1100 }, deviceScaleFactor: 2 });
await page.goto(`${base}/`);
await page.evaluate(
  ([cid, tok]) => localStorage.setItem("zebscan.checkoutAccess.v1", JSON.stringify({ [cid]: { token: tok, exp: Date.now() + 86_400_000 } })),
  [id, token],
);
await page.goto(`${base}/${process.env.ROUTE ?? "checkout"}/${id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
await page.screenshot({ path: out, fullPage: true });
console.log((await page.innerText("body")).replace(/\s+/g, " ").slice(0, 1500));
await browser.close();
