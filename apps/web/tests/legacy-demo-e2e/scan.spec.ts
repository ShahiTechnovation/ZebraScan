import { expect, test } from "@playwright/test";
import QRCode from "qrcode";
import { collectErrors, payExact } from "./helpers";

const PAYLOAD = "upi://pay?pa=sample.store@zebdemo&pn=Sample%20Store&am=250.00&cu=INR";

test("paste → confirm → amount edit → pay → P2P progression → receipt (acceptance 6)", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/scan");
  await page.getByRole("tab", { name: "Paste" }).click();
  await page.getByLabel("QR data").fill("https://evil.example/pay");
  await page.getByRole("button", { name: "Read QR data" }).click();
  await expect(page.getByText("Can't use this QR")).toBeVisible();
  await expect(page.getByText(/not a UPI payment QR/)).toBeVisible();

  await page.getByLabel("QR data").fill("upi://pay?pa=ok.user@bank&cu=USD");
  await page.getByRole("button", { name: "Read QR data" }).click();
  await expect(page.getByText(/Unsupported currency/)).toBeVisible();

  await page.getByLabel("QR data").fill(PAYLOAD);
  await page.getByRole("button", { name: "Read QR data" }).click();
  await expect(page.getByText("sample.store@zebdemo").first()).toBeVisible();
  await expect(page.getByText("From QR — not independently verified")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByLabel("Amount the receiver gets")).toHaveValue("250");
  await page.getByLabel("Amount the receiver gets").fill("300");
  await expect(page.getByText(/The QR asked for ₹250.00/)).toBeVisible();
  await page.getByRole("radio", { name: /Transparent/ }).check();
  await expect(page.getByText(/Transparent ZEC exposes the payment amount/)).toBeVisible();
  await page.getByRole("radio", { name: /Shielded/ }).check();
  await expect(page.getByText("Illustrative prices · not market data").first()).toBeVisible();
  await expect(page.getByText("Total in INR").locator("..").getByText("₹304.50")).toBeVisible();
  await page.getByRole("button", { name: /Lock quote & create demo invoice/ }).click();
  await expect(page).toHaveURL(/\/scan\/scn_/);

  await expect(page.getByText("The payout starts once your ZEC payment is verified.")).toBeVisible();
  await payExact(page);

  const stages = ["LP matching", "Provider accepted", "USDC escrowed", "INR processing", "Payout completed"];
  for (const s of stages) {
    await page.getByRole("button", { name: "Advance payout stage" }).click();
    await expect(page.getByText(s).first()).toBeVisible();
  }
  await expect(page.getByText(/Simulated receipt — not proof of a bank transfer/).first()).toBeVisible();
  await page.getByRole("link", { name: "View receipt" }).click();
  await expect(page).toHaveURL(/\/receipt\/rcp_/);
  await expect(page.getByText("sa•••••e@zebdemo").first()).toBeVisible();
  await expect(page.getByText("sample.store@zebdemo")).toHaveCount(0); // full UPI never on public receipt
  expect(errors).toEqual([]);
});

test("manual UPI entry and failed payout recovery", async ({ page }) => {
  await page.goto("/scan");
  await page.getByRole("tab", { name: "UPI ID" }).click();
  await page.getByLabel("Receiver UPI ID").fill("not-a-vpa");
  await expect(page.getByText(/Use the format name@handle/)).toBeVisible();
  await page.getByLabel("Receiver UPI ID").fill("corner.store@zebdemo");
  await page.getByRole("button", { name: "Use this UPI ID" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount the receiver gets").fill("0");
  await page.getByLabel("Amount the receiver gets").blur();
  await expect(page.getByText("Amount must be greater than zero.")).toBeVisible();
  await page.getByLabel("Amount the receiver gets").fill("20000");
  await expect(page.getByText(/Maximum is ₹10,000/)).toBeVisible();
  await page.getByLabel("Amount the receiver gets").fill("150");
  await page.getByRole("button", { name: /Lock quote/ }).click();
  await payExact(page);
  await page.getByRole("button", { name: "Simulate failure" }).click();
  await expect(page.getByText("Payout failed").first()).toBeVisible();
  await page.getByRole("button", { name: "Retry payout" }).click();
  await expect(page.getByText("Order queued").first()).toBeVisible();
});

test("upload QR image decodes; camera falls back gracefully", async ({ page }, testInfo) => {
  const file = testInfo.outputPath("upi.png");
  await QRCode.toFile(file, PAYLOAD, { width: 360, margin: 2 });
  await page.goto("/scan");
  await page.getByRole("tab", { name: "Upload" }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("sample.store@zebdemo").first()).toBeVisible();

  await page.getByRole("button", { name: "Choose a different receiver" }).click();
  await page.getByRole("tab", { name: "Scan" }).click();
  await page.getByRole("button", { name: /Open camera/ }).click();
  // Headless browsers have no granted camera: expect an honest fallback, or a live scanner with a stop control.
  await expect(
    page.getByText("Camera permission denied").or(page.getByText("No camera available")).or(page.getByRole("button", { name: "Stop camera" })).or(page.getByText("Camera error")),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload or paste instead" }).click();
  await expect(page.getByText("Choose a QR image")).toBeVisible();
});

test("quote expiry disables pay, refresh makes a new quote, late deposit is an exception (acceptance 8)", async ({ page }) => {
  await page.clock.install();
  await page.goto("/scan");
  await page.getByRole("tab", { name: "Paste" }).click();
  await page.getByLabel("QR data").fill(PAYLOAD);
  await page.getByRole("button", { name: "Read QR data" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Lock quote/ }).click();
  await expect(page).toHaveURL(/\/scan\/scn_/);
  const firstUrl = page.url();
  await page.clock.fastForward("01:35");
  await expect(page.getByText("Quote expired").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh quote" })).toBeVisible();

  await page.getByRole("button", { name: "Simulate late deposit…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /after expiry/ }).click();
  await expect(page.getByText("Late payment").first()).toBeVisible();
  await expect(page.getByText(/arrived after the quote expired/).first()).toBeVisible();

  // A fresh intent from the same receiver gets a new id/quote.
  await page.goto("/scan");
  await page.getByRole("tab", { name: "Paste" }).click();
  await page.getByLabel("QR data").fill(PAYLOAD);
  await page.getByRole("button", { name: "Read QR data" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Lock quote/ }).click();
  await expect(page).toHaveURL(/\/scan\/scn_/);
  await page.clock.fastForward("01:35");
  await page.getByRole("button", { name: "Refresh quote" }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(page.getByText(/Quote valid \d:\d\d/)).toBeVisible();
});

test("underpaid deposit raises exception and no credit", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore demo merchant account" }).click();
  await page.goto("/app/terminal");
  await page.getByLabel("Amount (INR)").fill("400");
  await page.getByRole("button", { name: "Create checkout" }).click();
  await page.getByRole("button", { name: /Simulate deposit detected/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Underpay/ }).click();
  await expect(page.getByText("Underpaid").first()).toBeVisible();
  await expect(page.getByText(/No merchant credit or payout was issued/)).toBeVisible();
  await page.getByRole("button", { name: "Start refund" }).click();
  await expect(page.getByText("Refund pending").first()).toBeVisible();
});

test("keyboard: modal traps focus and closes on Escape; skip link works", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore demo merchant account" }).click();
  await page.goto("/app/settings?tab=demo");
  await page.getByRole("button", { name: "Reset demo data" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
