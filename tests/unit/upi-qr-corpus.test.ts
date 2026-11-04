import { describe, expect, it } from "vitest";
import { DomainError, MAX_UPI_PAYLOAD, parseUpiPayload, validateVpa } from "@zeb/domain";

/** Real-world UPI QR payload shapes; mirrors apps/web/tests/unit/upi-qr-corpus.test.ts (browser parser). */
const ECDSA_SIGN = "MEQCIDzlkTaZxBE2b+3ZlFrMHfFv5Cuul43sORlZPRF9ZH0mAiB5OS9mY+qp7P1tD8gaRyqJ5HAc43ms8gZ/VuPWdQZkTQ==";
const GST_INVOICE =
  "upi://pay?ver=01&mode=01&orgid=700004&tr=INV20261104000123&tn=GST%20Invoice%20123&pa=merchant.gst@icici&pn=GST%20Merchant%20Pvt%20Ltd&mc=5732&am=1180.00&mam=1180.00&cu=INR&qrMedium=03" +
  "&invoiceNo=INV-2026-000123&invoiceDate=2026-11-04T13:58:12+05:30&gstBrkUp=GST:180.00|CGST:90.00|SGST:90.00&gstIn=27AAPFU0939F1ZV&sign=" +
  "A".repeat(340);

const ACCEPTED: Array<[string, string, { vpa: string; payeeName?: string | null; paise?: bigint | null; note?: string | null; support?: string }]> = [
  ["GPay personal", "upi://pay?pa=merchant.name@okicici&pn=Merchant%20Name&aid=uGICAgICA0eH3AQ", { vpa: "merchant.name@okicici", payeeName: "Merchant Name", support: "supported" }],
  ["PhonePe personal (mc=0000)", "upi://pay?pa=8799792366@ybl&pn=RAHUL%20SHARMA&mc=0000&mode=02&purpose=00", { vpa: "8799792366@ybl", support: "supported" }],
  ["PhonePe wallet-style VPA", "upi://pay?pa=8799792366.wallet@phonepe&pn=Wallet%20User&cu=INR", { vpa: "8799792366.wallet@phonepe" }],
  ["Paytm merchant, signed", `upi://pay?pa=paytmqr281005050101abcd@paytm&pn=Paytm%20Merchant&mc=5499&mode=02&orgid=000000&sign=${ECDSA_SIGN}`, { vpa: "paytmqr281005050101abcd@paytm", support: "supported_with_notice" }],
  ["BharatPe", "upi://pay?pa=BHARATPE.9000000000@fbpe&pn=BharatPe%20Merchant&cu=INR&tn=Pay%20To%20BharatPe%20Merchant", { vpa: "BHARATPE.9000000000@fbpe", note: "Pay To BharatPe Merchant" }],
  ["uppercase scheme and keys", "UPI://PAY?PA=SHOP.KIRANA@OKAXIS&PN=KIRANA%20STORE&AM=10&CU=INR", { vpa: "SHOP.KIRANA@OKAXIS", payeeName: "KIRANA STORE", paise: 1000n }],
  ["'+' as space, cu=inr, am=10.0", "Upi://Pay?pa=abc-def_1@oksbi&pn=Abc+Def&am=10.0&cu=inr&tn=Tea+%26+snacks", { vpa: "abc-def_1@oksbi", payeeName: "Abc Def", paise: 1000n, note: "Tea & snacks" }],
  ["minimal", "upi://pay?pa=x@ybl", { vpa: "x@ybl", payeeName: null, paise: null }],
  ["percent-encoded @", "upi://pay?pa=merchant.name%40okicici", { vpa: "merchant.name@okicici" }],
  ["empty params", "upi://pay?pa=9876543210@ptyes&am=&tn=&cu=INR", { vpa: "9876543210@ptyes", paise: null, note: null }],
  ["amount 100.000", "upi://pay?pa=shop@okaxis&am=100.000", { vpa: "shop@okaxis", paise: 10_000n }],
  ["amount 10.00", "upi://pay?pa=shop@okaxis&am=10.00", { vpa: "shop@okaxis", paise: 1_000n }],
  ["identical repeat", "upi://pay?pa=shop@okaxis&pa=shop@okaxis&mode=01&mode=02", { vpa: "shop@okaxis" }],
  ["GST invoice QR over 512 chars", GST_INVOICE, { vpa: "merchant.gst@icici", paise: 118_000n, support: "supported_with_notice" }],
];

describe("UPI QR corpus (server parser)", () => {
  it.each(ACCEPTED)("accepts %s", (_n, payload, want) => {
    const p = parseUpiPayload(payload);
    expect(p.vpa).toBe(want.vpa);
    if ("payeeName" in want) expect(p.payeeName).toBe(want.payeeName);
    if ("paise" in want) expect(p.amountInrPaise).toBe(want.paise);
    if ("note" in want) expect(p.note).toBe(want.note);
    if (want.support) expect(p.support).toBe(want.support);
  });

  it.each([
    ["conflicting pa", "upi://pay?pa=good.shop@ybl&pa=evil.shop@ybl", "QR_DUPLICATE_PARAM"],
    ["conflicting pa across key case", "UPI://PAY?pa=good.shop@ybl&PA=evil.shop@ybl", "QR_DUPLICATE_PARAM"],
    ["conflicting am", "upi://pay?pa=good.shop@ybl&am=10&am=99", "QR_DUPLICATE_PARAM"],
    ["markup in VPA", "upi://pay?pa=<b>@ybl", "QR_VPA_INVALID"],
    ["sub-paise amount", "upi://pay?pa=good.shop@ybl&am=10.005", "QR_AMOUNT_INVALID"],
    ["exponent amount", "upi://pay?pa=good.shop@ybl&am=1e5", "QR_AMOUNT_INVALID"],
    ["zero amount", "upi://pay?pa=good.shop@ybl&am=0.00", "QR_AMOUNT_INVALID"],
    ["foreign currency", "upi://pay?pa=good.shop@ybl&cu=USD", "QR_CURRENCY"],
    ["BharatQR / EMV", "00020101021126410010A0000005240123000000000000000000000000520458125303356", "QR_NOT_UPI"],
    ["control character", "upi://pay?pa=good.shop@ybl\u007f", "QR_CONTROL_CHARS"],
    ["over the cap", `upi://pay?pa=x@ybl&pn=${"x".repeat(MAX_UPI_PAYLOAD)}`, "QR_TOO_LONG"],
  ])("rejects %s", (_n, payload, code) => {
    try {
      parseUpiPayload(payload);
      throw new Error("expected a DomainError");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(code);
    }
  });

  it("sanitises QR text shown to the payer (control, markup, bidi override)", () => {
    const p = parseUpiPayload("upi://pay?pa=x@ybl&pn=%E2%80%AEevil%3Cb%3E%0Ashop");
    expect(p.payeeName).toBe("evilbshop");
  });

  it("validates real-world handle shapes", () => {
    for (const v of ["Q123456789@ybl", "paytmqr281005050101abcd@paytm", "merchant.name@okicici", "BHARATPE.9000000000@fbpe", "9876543210@upi", "abc-def_1@oksbi", "x@ybl"]) expect(validateVpa(v)).toBe(v);
    for (const v of ["@ybl", "name@y", "na me@ybl", ".name@ybl", "name@1bank"]) expect(() => validateVpa(v)).toThrow(DomainError);
  });
});
