import { expect, test } from "@playwright/test";
import { collectErrors, onboard, payExact } from "./helpers";

test("onboarding → shop name everywhere → terminal payment credited exactly once (acceptance 1, 2)", async ({ page }) => {
  const errors = await collectErrors(page);
  await onboard(page, "Kite Street Books", "kite-books");
  await expect(page.getByRole("heading", { name: /Kite Street Books/ })).toBeVisible();

  for (const r of ["/app/terminal", "/app/links", "/app/balance", "/app/settings"]) {
    await page.goto(r);
    await expect(page.getByRole("button", { name: /Kite Street Books/ })).toBeVisible();
  }

  await page.goto("/app/terminal");
  await page.getByRole("button", { name: "₹500" }).click();
  await expect(page.getByLabel("Amount (INR)")).toHaveValue("500");
  await page.getByRole("button", { name: "Create checkout" }).click();
  await expect(page).toHaveURL(/\/app\/terminal\?c=chk_/);
  const checkoutId = new URL(page.url()).searchParams.get("c")!;
  await expect(page.getByRole("img", { name: /Demo preview QR/ })).toBeVisible();
  await expect(page.getByText("Preview QR — cannot receive real ZEC")).toBeVisible();
  await expect(page.getByText("₹500.00 · Kite Street Books")).toBeVisible();
  await expect(page.getByText(`Checkout ${checkoutId}`)).toBeVisible();
  await expect(page.getByText(/Quote valid \d:\d\d/)).toBeVisible();

  await payExact(page);
  await expect(page.getByText(/Credit locked until/).first()).toBeVisible();

  // Credit appears once, consistently across pages.
  await page.goto("/app");
  await expect(page.getByText("Locked INR credit").locator("..").getByText("₹500.00")).toBeVisible();
  await page.goto("/app/transactions");
  await expect(page.getByRole("link", { name: new RegExp(checkoutId) })).toHaveCount(1);
  await page.goto("/app/balance");
  await expect(page.locator("table").getByText("+₹500.00")).toHaveCount(1);
  await page.goto("/app/settlements");
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await page.goto("/app/receipts");
  await expect(page.locator("table tbody tr")).toHaveCount(1);

  // Persists across reload.
  await page.reload();
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("counter QR opens an independent checkout, never a permanent ZEC address (acceptance 5)", async ({ page }) => {
  await onboard(page, "Lantern Cafe", "lantern-cafe");
  await page.goto("/app/counter-qr");
  await expect(page.getByText("Opens your checkout page — not a ZEC address")).toBeVisible();
  await page.goto("/m/lantern-cafe");
  await expect(page.getByRole("heading", { name: "Pay Lantern Cafe" })).toBeVisible();
  await page.getByLabel("Amount in INR").fill("120");
  await page.getByRole("button", { name: "Generate checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\/chk_/);
  const first = page.url();
  const addr1 = await page.getByText(/zebscan-demo-address-/).first().textContent();
  await page.goto("/m/lantern-cafe");
  await page.getByLabel("Amount in INR").fill("120");
  await page.getByRole("button", { name: "Generate checkout" }).click();
  await expect(page).toHaveURL(/\/checkout\/chk_/);
  expect(page.url()).not.toBe(first);
  const addr2 = await page.getByText(/zebscan-demo-address-/).first().textContent();
  expect(addr2).not.toBe(addr1);

  // Regenerating retires the old slug.
  await page.goto("/app/counter-qr");
  await page.getByRole("button", { name: "Regenerate counter link" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Regenerate" }).click();
  await page.goto("/m/lantern-cafe");
  await expect(page.getByRole("heading", { name: "This counter QR was replaced" })).toBeVisible();
});

test("cooldown, withdrawal reservation, failure and explicit recovery (acceptance 7)", async ({ page }) => {
  await onboard(page, "Saffron Tailors", "saffron-tailors");
  await page.goto("/app/terminal");
  await page.getByLabel("Amount (INR)").fill("2000");
  await page.getByRole("button", { name: "Create checkout" }).click();
  await payExact(page);

  await page.goto("/app/withdrawals/new");
  await expect(page.getByText(/still locked in cooldown/)).toBeVisible();

  await page.goto("/app/settlements");
  await page.getByRole("button", { name: /Advance cooldown/ }).click();
  await expect(page.locator("table").getByText("Available")).toBeVisible();

  await page.goto("/app/withdrawals/new");
  await page.getByLabel("Withdrawal amount (INR)").fill("5000");
  await expect(page.getByText(/exceeds your available balance/)).toBeVisible();
  await page.getByLabel("Withdrawal amount (INR)").fill("1500");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Request demo withdrawal" }).click();
  await expect(page).toHaveURL(/\/app\/withdrawals\/wdr_/);
  const wUrl = page.url();

  await page.goto("/app/balance");
  await expect(page.getByText("Available INR").locator("..").getByText("₹500.00")).toBeVisible();
  await expect(page.getByText("Withdrawal processing").locator("..").getByText("₹1,500.00")).toBeVisible();

  await page.goto(wUrl);
  await page.getByRole("button", { name: "Advance stage" }).click();
  await page.getByRole("button", { name: "Simulate failure" }).click();
  await expect(page.getByText("Payout failed · recovery needed")).toBeVisible();
  await page.goto("/app/balance");
  await expect(page.getByText("Available INR").locator("..").getByText("₹500.00")).toBeVisible();

  await page.goto(wUrl);
  await page.getByRole("button", { name: "Restore funds to available balance" }).click();
  await expect(page.getByText("Payout failed · funds restored")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore funds to available balance" })).toHaveCount(0);
  await page.goto("/app/balance");
  await expect(page.getByText("Available INR").locator("..").getByText("₹2,000.00")).toBeVisible();

  // Successful withdrawal reduces liability.
  await page.goto("/app/withdrawals/new");
  await page.getByLabel("Withdrawal amount (INR)").fill("1000");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Request demo withdrawal" }).click();
  await expect(page).toHaveURL(/\/app\/withdrawals\/wdr_/);
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Advance stage" }).click();
  await expect(page.getByText("Payout completed only when provider confirmed.")).toBeVisible();
  await page.goto("/app/balance");
  await expect(page.getByText("Outstanding liability").locator("..").getByText("₹1,000.00")).toBeVisible();
});
