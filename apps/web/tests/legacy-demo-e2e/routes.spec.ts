import { expect, test } from "@playwright/test";
import { collectErrors, noHorizontalOverflow, signInSample } from "./helpers";

const PUBLIC = ["/", "/how-it-works", "/faq", "/login", "/onboarding", "/scan", "/privacy", "/terms", "/m/monsoon-chai"];
const APP = [
  "/app",
  "/app/terminal",
  "/app/counter-qr",
  "/app/links",
  "/app/links/new",
  "/app/transactions",
  "/app/balance",
  "/app/settlements",
  "/app/withdrawals",
  "/app/withdrawals/new",
  "/app/receipts",
  "/app/settings",
  "/app/help",
  "/app/ops",
];
const VIEWPORTS = [
  { width: 360, height: 760 },
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test(`public routes render without overflow or errors @${vp.width}`, async ({ page }) => {
    await page.setViewportSize(vp);
    const errors = await collectErrors(page);
    for (const r of PUBLIC) {
      const res = await page.goto(r);
      expect(res?.status(), r).toBe(200);
      await expect(page.getByRole("link", { name: "Zeb Scan home" }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noHorizontalOverflow(page);
    }
    expect(errors).toEqual([]);
  });

  test(`merchant routes render without overflow or errors @${vp.width}`, async ({ page }) => {
    await page.setViewportSize(vp);
    const errors = await collectErrors(page);
    await signInSample(page);
    for (const r of APP) {
      const res = await page.goto(r);
      expect(res?.status(), r).toBe(200);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByText("Merchant console")).toHaveCount(0); // not gated
      await noHorizontalOverflow(page);
    }
    expect(errors).toEqual([]);
  });
}

test("seeded detail pages are reachable by clicking through", async ({ page }) => {
  const errors = await collectErrors(page);
  await signInSample(page, "/app/transactions");
  await page.getByRole("link", { name: /Masala chai tasting box/ }).first().click();
  await expect(page).toHaveURL(/\/app\/transactions\/chk_/);
  await expect(page.getByText("Zcash verification & accounting")).toBeVisible();

  await page.goto("/app/links");
  await page.getByRole("link", { name: "Masala chai tasting box" }).click();
  await expect(page).toHaveURL(/\/app\/links\/lnk_/);

  await page.goto("/app/withdrawals");
  await page.getByRole("link", { name: /wdr_/ }).first().click();
  await expect(page.getByText("SELL payout path")).toBeVisible();

  await page.goto("/app/receipts");
  await page.getByRole("link", { name: /rcp_/ }).first().click();
  await expect(page.getByText("Simulated receipt — not proof of a bank transfer.").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("unknown routes and ids show branded not-found", async ({ page }) => {
  const errors = await collectErrors(page);
  const res = await page.goto("/definitely-not-a-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/checkout/chk_unknown");
  await expect(page.getByRole("heading", { name: "Checkout not found" })).toBeVisible();
  await page.goto("/pay/nope");
  await expect(page.getByRole("heading", { name: "Payment link not found" })).toBeVisible();
  await page.goto("/receipt/rcp_nope");
  await expect(page.getByRole("heading", { name: "Receipt not found" })).toBeVisible();
  await page.goto("/scan/scn_nope");
  await expect(page.getByRole("heading", { name: "Payment not found" })).toBeVisible();
  await signInSample(page);
  await page.goto("/app/transactions/nope");
  await expect(page.getByRole("heading", { name: "Transaction not found" })).toBeVisible();
  expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
});

test("merchant console is gated without a session", async ({ page }) => {
  await page.goto("/app/balance");
  await expect(page.getByRole("heading", { name: "Merchant console" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explore demo merchant account" })).toBeVisible();
  await page.goto("/app/help");
  await expect(page.getByRole("heading", { name: "Help center" })).toBeVisible();
});
