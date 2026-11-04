/**
 * Connected mode: browser → Next.js → Zeb Scan API → PostgreSQL ← worker.
 * The backend runs in the DEMO environment, so addresses are non-payable placeholders and every
 * record is labelled DEMO; all state transitions, ledger postings, sessions, CSRF, idempotency,
 * SSE and P2P job processing are the real backend code paths.
 */
import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAIL_DIR = path.resolve(__dirname, "../../../../var/e2e-mail");

async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", async (r) => {
    if (r.url().includes("/api/v1/") && r.status() >= 400 && r.status() !== 404) errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  });
  return errors;
}

/** Drive a DEMO-backend checkout to acceptance through the UI simulator (real API calls). */
async function payExactLive(page: Page) {
  await page.getByRole("button", { name: /Simulate deposit detected/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Exact amount/ }).click();
  await expect(page.getByText(/ZEC detected/).first()).toBeVisible();
  for (let i = 0; i < 6; i++) {
    if (await page.getByText("ZEC payment verified", { exact: true }).first().isVisible().catch(() => false)) break;
    const btn = page.getByRole("button", { name: /Add confirmation|Reach required confirmations/ });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    await page.waitForTimeout(400);
  }
  await expect(page.getByText("ZEC payment verified", { exact: true }).first(), (globalThis as { __errs?: string[] }).__errs?.join(" | ")).toBeVisible();
}

async function latestMailLink(kind: "verify-email" | "reset-password"): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const files = readdirSync(MAIL_DIR).sort().reverse();
    for (const f of files) {
      const body = readFileSync(path.join(MAIL_DIR, f), "utf8");
      const m = body.match(new RegExp(`(http://[^\\s]+/${kind}\\?token=[^\\s]+)`));
      if (m) return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no ${kind} email delivered`);
}

test("Scan & Pay end-to-end against the real backend (DEMO environment)", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/scan");
  await expect(page.getByText(/Demo backend — simulated payments only/)).toBeVisible();
  await page.getByRole("tab", { name: "UPI ID" }).click();
  await page.getByLabel("Receiver UPI ID").fill("corner.store@okaxis");
  await page.getByRole("button", { name: "Use this UPI ID" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount the receiver gets").fill("150");
  await page.getByRole("button", { name: /Lock quote/ }).click();
  await expect(page).toHaveURL(/\/scan\/pi_/, { timeout: 30_000 });

  // Non-payable placeholder, never a real Zcash address; full UPI ID is never shown back.
  await expect(page.getByText(/zebscan-demo-address-pi_/).first()).toBeVisible();
  await expect(page.getByText("Preview QR — cannot receive real ZEC").first()).toBeVisible();
  await expect(page.getByText("corner.store@okaxis")).toHaveCount(0);

  await payExactLive(page);
  // The worker places and tracks the (simulated) P2P PAY order; the UI follows via SSE/polling.
  await expect(page.getByText("Payout completed").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/not a bank statement/).first()).toBeVisible();
  await page.getByRole("link", { name: "View receipt" }).click();
  await expect(page).toHaveURL(/\/receipt\/rcp_/);
  await expect(page.getByText(/co•••••e@okaxis/).first()).toBeVisible();
  await expect(page.getByText("corner.store@okaxis")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("merchant: register → onboard → verify email → terminal payment → credit unlock → withdrawal", async ({ page }) => {
  const errors = await collectErrors(page);
  (globalThis as { __errs?: string[] }).__errs = errors;
  const handle = `e2e-shop-${Date.now().toString(36)}`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Email").fill(`${handle}@example.test`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");

  await page.getByLabel("Business name").fill("E2E Chai House");
  await page.getByLabel("Merchant handle").fill(handle);
  await page.getByLabel("Business category").selectOption("Retail");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Payout UPI ID").fill("e2e.chai@okhdfcbank");
  await page.getByLabel("Beneficiary display name").fill("E2E Chai House");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create merchant" }).click();
  await page.waitForURL("**/app");

  // Server-reported gate is visible, not a hidden button error.
  await expect(page.getByText(/Verify your email/).first()).toBeVisible();
  await page.goto(await latestMailLink("verify-email"));
  await expect(page.getByText("Your email is verified.")).toBeVisible();

  // Terminal invoice → simulated deposit → locked credit.
  await page.goto("/app/terminal");
  await page.getByLabel("Amount (INR)").fill("500");
  await page.getByRole("button", { name: "Create checkout" }).click();
  await expect(page.getByText(/zebscan-demo-address-pi_/).first()).toBeVisible({ timeout: 30_000 });
  await payExactLive(page);
  await expect(page.getByText(/Credit locked until/).first()).toBeVisible();

  // Cooldown (3s in this E2E config) → worker unlocks → available.
  await page.waitForTimeout(6_000);
  await page.goto("/app/settlements");
  await expect(page.locator("table").getByText("Available").first()).toBeVisible({ timeout: 30_000 });

  // Payout destination (encrypted; DEMO backend auto-verifies) then withdrawal via P2P SELL.
  await page.goto("/app/settings?tab=payout");
  await page.getByLabel("Payout UPI ID").fill("e2e.chai@okhdfcbank");
  await page.getByLabel("Beneficiary display name").fill("E2E Chai House");
  await page.getByRole("button", { name: "Save payout destination" }).click();
  const pw = page.getByLabel("Password");
  if (await pw.isVisible({ timeout: 1500 }).catch(() => false)) {
    await pw.fill("correct horse battery staple");
    await page.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(page.getByText(/Payout destination saved/).first()).toBeVisible();

  await page.goto("/app/withdrawals/new");
  await page.getByLabel("Withdrawal amount (INR)").fill("300");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Request withdrawal" }).click();
  const pw2 = page.getByLabel("Password");
  if (await pw2.isVisible({ timeout: 1500 }).catch(() => false)) {
    await pw2.fill("correct horse battery staple");
    await page.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(page).toHaveURL(/\/app\/withdrawals\/wd_/, { timeout: 30_000 });
  await expect(page.getByText("Payout completed").first()).toBeVisible({ timeout: 90_000 });
  expect(errors).toEqual([]);
});
