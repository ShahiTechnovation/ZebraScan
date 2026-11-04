import { expect, type Page } from "@playwright/test";

export async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export async function signInSample(page: Page, next = "/app") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByRole("button", { name: "Explore demo merchant account" }).click();
  await page.waitForURL(`**${next}`);
}

export async function onboard(page: Page, name: string, handle: string) {
  await page.goto("/onboarding");
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("Merchant handle").fill(handle);
  await page.getByLabel("Business category").selectOption("Retail");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Payout UPI ID").fill(`${handle}@zebdemo`);
  await page.getByLabel("Beneficiary display name").fill(`${name} payouts`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create demo merchant" }).click();
  await page.waitForURL("**/app");
}

/** Simulate an exact deposit and drive it to accepted via the demo wallet simulator. */
export async function payExact(page: Page) {
  await page.getByRole("button", { name: /Simulate deposit detected/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Exact amount/ }).click();
  await expect(page.getByText("ZEC detected").first()).toBeVisible();
  await page.getByRole("button", { name: "Add confirmation" }).click();
  await page.getByRole("button", { name: "Reach required confirmations" }).click();
  await expect(page.getByText("ZEC payment verified").first()).toBeVisible();
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);
}
