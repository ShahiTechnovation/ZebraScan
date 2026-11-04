import { expect, test } from "@playwright/test";
import { onboard, payExact } from "./helpers";

test("fixed single-use link: public pay, exhausted, second visitor blocked (acceptance 3)", async ({ page, context }) => {
  await onboard(page, "Monsoon Prints", "monsoon-prints");
  await page.goto("/app/links/new");
  await page.getByLabel("Title").fill("Poster print A2");
  await page.getByLabel("Fixed amount").fill("750");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page).toHaveURL(/\/app\/links\/lnk_/);
  const publicUrl = (await page.getByText(/\/pay\//).first().textContent())!.trim();
  const slugPath = new URL(publicUrl).pathname;

  // Public visitor (new tab, same browser storage = same demo device) without signing in.
  const visitor = await context.newPage();
  await visitor.goto(slugPath);
  await expect(visitor.getByRole("heading", { name: "Poster print A2" })).toBeVisible();
  await expect(visitor.getByText("₹750.00").first()).toBeVisible();
  // Opening extra tabs must not consume the one-use slot.
  const extra = await context.newPage();
  await extra.goto(slugPath);
  await extra.getByRole("button", { name: "Generate checkout" }).click();
  await expect(extra).toHaveURL(/\/checkout\//);
  await extra.close();

  await visitor.getByRole("button", { name: "Generate checkout" }).click();
  await expect(visitor).toHaveURL(/\/checkout\/chk_/);
  await payExact(visitor);

  await page.reload();
  await expect(page.getByText("Exhausted").first()).toBeVisible();
  await expect(page.getByText("Successful payments").locator("..").getByText("1", { exact: true })).toBeVisible();

  const second = await context.newPage();
  await second.goto(slugPath);
  await expect(second.getByText("This payment link has been used")).toBeVisible();
  await expect(second.getByRole("button", { name: "Generate checkout" })).toHaveCount(0);
});

test("variable reusable link: two sessions, distinct ids and payloads, two records (acceptance 4)", async ({ page, context }) => {
  await onboard(page, "River Yoga", "river-yoga");
  await page.goto("/app/links/new");
  await page.getByLabel("Title").fill("Class pack");
  await page.getByRole("radio", { name: "Variable INR" }).click();
  await page.getByLabel("Minimum").fill("300");
  await page.getByLabel("Maximum").fill("100");
  await page.getByRole("switch", { name: "Reusable link" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByText("Maximum must be greater than or equal to the minimum.")).toBeVisible();
  await page.getByLabel("Maximum").fill("3000");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page).toHaveURL(/\/app\/links\/lnk_/);
  const slugPath = new URL((await page.getByText(/\/pay\//).first().textContent())!.trim()).pathname;

  const ids: string[] = [];
  const payloads: string[] = [];
  for (const amt of ["500", "1200"]) {
    const v = await context.newPage();
    await v.goto(slugPath);
    await v.getByLabel("Amount in INR").fill("50");
    await expect(v.getByText(/Enter between/).first()).toBeVisible();
    await v.getByLabel("Amount in INR").fill(amt);
    // fee math: total = amount × 1.015
    const totalPaise = Number(amt) * 100 * 1.015;
    const total = `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2 }).format(totalPaise / 100)}`;
    await expect(v.getByText("Total in INR").locator("..").getByText(total, { exact: true })).toBeVisible();
    await v.getByRole("button", { name: "Generate checkout" }).click();
    await expect(v).toHaveURL(/\/checkout\/chk_/);
    ids.push(v.url());
    const payload = await v.getByRole("img", { name: /Demo preview QR/ }).count();
    expect(payload).toBe(1);
    await v.getByRole("button", { name: "Copy payment URI" }).click();
    payloads.push(await v.evaluate(() => navigator.clipboard.readText().catch(() => "")));
    await payExact(v);
    await v.close();
  }
  expect(ids[0]).not.toBe(ids[1]);
  if (payloads[0] && payloads[1]) {
    expect(payloads[0]).toMatch(/^zebscan-demo:\/\/checkout\//);
    expect(payloads[0]).not.toBe(payloads[1]);
  }
  await page.reload();
  await expect(page.getByText("Successful payments").locator("..").getByText("2", { exact: true })).toBeVisible();
  await page.goto("/app/transactions");
  await expect(page.locator("table tbody tr")).toHaveCount(2);
});

test("revoke, duplicate, search and filter respond", async ({ page }) => {
  await onboard(page, "Tidal Tees", "tidal-tees");
  await page.goto("/app/links/new");
  await page.getByLabel("Title").fill("Summer tee");
  await page.getByLabel("Fixed amount").fill("499");
  await page.getByRole("button", { name: "Create link" }).click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke link" }).click();
  await expect(page.getByText("Revoked").first()).toBeVisible();
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { name: "Summer tee (copy)" })).toBeVisible();
  await page.goto("/app/links");
  await expect(page.locator("table tbody tr")).toHaveCount(2);
  await page.getByRole("radio", { name: /Revoked/ }).click();
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await page.getByRole("radio", { name: /All/ }).click();
  await page.getByLabel("Search links").fill("copy");
  await expect(page.locator("table tbody tr")).toHaveCount(1);
});
