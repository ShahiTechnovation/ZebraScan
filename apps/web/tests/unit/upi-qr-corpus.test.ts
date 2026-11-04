import { describe, expect, it } from "vitest";
import { MAX_UPI_PAYLOAD, parseUpiPayload, validateVpa } from "@/lib/upi";
import { classifyCameraError, FALLBACK_CAMERA, openCameraStream, PREFERRED_CAMERA, stillImagePlan } from "@/lib/qr-decode";

/**
 * Payload shapes seen on real UPI QRs (GPay, PhonePe, Paytm, BHIM, BharatPe, bank merchant QRs).
 * The same images were rendered as PNG/JPEG, inverted, cropped, tiny, 12 MP photo and app
 * screenshot variants and decoded in Chrome with lib/qr-decode (see the PR notes).
 */
const PHONEPE_SIGN = "AAuN7izDWN5cb8A5scnUiNME+LkZqI2DWgkXlN1McoP6WZABa/KkFTiLvuPRP6/nWK8BPg/rPhb+u4QMrUEX10UsANTDbJaALcSM9b8Wk218X+55T/zOzb7xoiB+BcX8yYuYayELImXJHIgL/c7nkAnHrwUCmbM97nRbCVVRvU0ku3Tr";
const ECDSA_SIGN = "MEQCIDzlkTaZxBE2b+3ZlFrMHfFv5Cuul43sORlZPRF9ZH0mAiB5OS9mY+qp7P1tD8gaRyqJ5HAc43ms8gZ/VuPWdQZkTQ==";
const GST_INVOICE =
  "upi://pay?ver=01&mode=01&orgid=700004&tr=INV20261104000123&tn=GST%20Invoice%20123&pa=merchant.gst@icici&pn=GST%20Merchant%20Pvt%20Ltd&mc=5732&am=1180.00&mam=1180.00&cu=INR&qrMedium=03" +
  "&invoiceNo=INV-2026-000123&invoiceDate=2026-11-04T13:58:12+05:30&QRexpire=2026-11-04T14:28:12+05:30&QRts=2026-11-04T13:58:12+05:30&gstBrkUp=GST:180.00|CGST:90.00|SGST:90.00&gstIn=27AAPFU0939F1ZV&sign=" +
  "A".repeat(340);

type Expect = { vpa: string; payeeName?: string; amountMinor?: number; note?: string; merchant?: boolean };

const ACCEPTED: Array<[string, string, Expect]> = [
  ["GPay personal", "upi://pay?pa=merchant.name@okicici&pn=Merchant%20Name&aid=uGICAgICA0eH3AQ", { vpa: "merchant.name@okicici", payeeName: "Merchant Name", merchant: false }],
  ["GPay business", "upi://pay?pa=gpay-11236547890@okbizaxis&pn=Chai%20Point&mc=5814&aid=uGICAgMDYs8zEKA&ver=01&mode=01&tr=BCR2DN4T7XYZ1234", { vpa: "gpay-11236547890@okbizaxis", payeeName: "Chai Point", merchant: true }],
  ["PhonePe personal (mc=0000 is a person)", "upi://pay?pa=8799792366@ybl&pn=RAHUL%20SHARMA&mc=0000&mode=02&purpose=00", { vpa: "8799792366@ybl", payeeName: "RAHUL SHARMA", merchant: false }],
  ["PhonePe wallet-style VPA", "upi://pay?pa=8799792366.wallet@phonepe&pn=Wallet%20User&cu=INR", { vpa: "8799792366.wallet@phonepe", payeeName: "Wallet User", merchant: false }],
  ["PhonePe merchant, signed", `upi://pay?pa=Q123456789@ybl&pn=PhonePeMerchant&mc=5411&mode=02&purpose=00&sign=${PHONEPE_SIGN}`, { vpa: "Q123456789@ybl", payeeName: "PhonePeMerchant", merchant: true }],
  ["Paytm personal", "upi://pay?pa=9876543210@paytm&pn=Anita%20Verma&tn=Send%20money", { vpa: "9876543210@paytm", payeeName: "Anita Verma", note: "Send money", merchant: false }],
  ["Paytm merchant, signed", `upi://pay?pa=paytmqr281005050101abcd@paytm&pn=Paytm%20Merchant&mc=5499&mode=02&orgid=000000&paytmqr=281005050101ABCD&sign=${ECDSA_SIGN}`, { vpa: "paytmqr281005050101abcd@paytm", payeeName: "Paytm Merchant", merchant: true }],
  ["BHIM personal", "upi://pay?pa=9876543210@upi&pn=Suresh&mc=0000&mode=02&purpose=00", { vpa: "9876543210@upi", payeeName: "Suresh", merchant: false }],
  ["BharatPe", "upi://pay?pa=BHARATPE.9000000000@fbpe&pn=BharatPe%20Merchant&cu=INR&tn=Pay%20To%20BharatPe%20Merchant", { vpa: "BHARATPE.9000000000@fbpe", note: "Pay To BharatPe Merchant", merchant: false }],
  [
    "bank merchant with BharatQR-style params",
    `upi://pay?pa=merchant.store@hdfcbank&pn=Store%20Name&mc=5411&tid=TID12345678&tr=TR20261104123456&tn=Order%20123&am=499.00&mam=null&cu=INR&url=https://merchant.example/order?id=123&mode=01&purpose=00&orgid=159002&mid=MID001&msid=STORE01&mtid=TERM01&qrMedium=02&sign=${ECDSA_SIGN}`,
    { vpa: "merchant.store@hdfcbank", payeeName: "Store Name", amountMinor: 49_900, note: "Order 123", merchant: true },
  ],
  ["uppercase scheme and keys", "UPI://PAY?PA=SHOP.KIRANA@OKAXIS&PN=KIRANA%20STORE&AM=10&CU=INR", { vpa: "SHOP.KIRANA@OKAXIS", payeeName: "KIRANA STORE", amountMinor: 1_000 }],
  ["mixed case, '+' as space, cu=inr", "Upi://Pay?pa=abc-def_1@oksbi&pn=Abc+Def&am=10.0&cu=inr", { vpa: "abc-def_1@oksbi", payeeName: "Abc Def", amountMinor: 1_000 }],
  ["'+' and %26 in text", "upi://pay?pa=abc-def_1@oksbi&pn=Ramesh+Kumar+Stores&am=10.00&cu=INR&tn=Tea+%26+snacks", { vpa: "abc-def_1@oksbi", payeeName: "Ramesh Kumar Stores", note: "Tea & snacks", amountMinor: 1_000 }],
  ["minimal", "upi://pay?pa=x@ybl", { vpa: "x@ybl" }],
  ["purpose / qrMedium ignored", "upi://pay?pa=merchant.name@okicici&pn=Merchant&purpose=00&qrMedium=02&cu=INR", { vpa: "merchant.name@okicici", merchant: false }],
  ["percent-encoded @", "upi://pay?pa=merchant.name%40okicici&pn=M", { vpa: "merchant.name@okicici", payeeName: "M" }],
  ["Hindi payee name", "upi://pay?pa=dukaan@ybl&pn=%E0%A4%A6%E0%A5%81%E0%A4%95%E0%A4%BE%E0%A4%A8&cu=INR", { vpa: "dukaan@ybl", payeeName: "दुकान" }],
  ["empty params", "upi://pay?pa=9876543210@ptyes&pn=Name&am=&tn=&cu=INR", { vpa: "9876543210@ptyes", payeeName: "Name" }],
  ["amount 100.000", "upi://pay?pa=shop@okaxis&pn=Shop&am=100.000&cu=INR", { vpa: "shop@okaxis", amountMinor: 10_000 }],
  ["amount '10.'", "upi://pay?pa=shop@okaxis&am=10.", { vpa: "shop@okaxis", amountMinor: 1_000 }],
  ["amount '.5'", "upi://pay?pa=shop@okaxis&am=.5", { vpa: "shop@okaxis", amountMinor: 50 }],
  ["trailing newline from a scanner", "upi://pay?pa=9876543210@upi&pn=Test\n", { vpa: "9876543210@upi", payeeName: "Test" }],
  ["identical repeat is not ambiguous", "upi://pay?pa=shop@okaxis&pa=shop@okaxis&mode=02&mode=01", { vpa: "shop@okaxis" }],
  ["GST invoice QR over 512 chars", GST_INVOICE, { vpa: "merchant.gst@icici", payeeName: "GST Merchant Pvt Ltd", amountMinor: 118_000, merchant: true }],
];

describe("UPI QR corpus (browser parser)", () => {
  it.each(ACCEPTED)("accepts %s", (_name, payload, want) => {
    const r = parseUpiPayload(payload);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.vpa).toBe(want.vpa);
    if ("payeeName" in want) expect(r.value.payeeName).toBe(want.payeeName);
    expect(r.value.amountMinor).toBe(want.amountMinor);
    if ("note" in want) expect(r.value.note).toBe(want.note);
    if ("merchant" in want) expect(r.value.hasMerchantParams).toBe(want.merchant);
  });

  it.each([
    ["conflicting pa", "upi://pay?pa=good.shop@ybl&pa=evil.shop@ybl", /repeats "pa"/],
    ["conflicting pa across key case", "UPI://PAY?pa=good.shop@ybl&PA=evil.shop@ybl", /repeats "pa"/],
    ["conflicting am", "upi://pay?pa=good.shop@ybl&am=10&am=1000", /repeats "am"/],
    ["markup in VPA", "upi://pay?pa=<script>@ybl", /malformed/],
    ["space in VPA", "upi://pay?pa=good+shop@ybl", /malformed/],
    ["sub-paise amount", "upi://pay?pa=good.shop@ybl&am=10.005", /invalid/],
    ["grouped amount", "upi://pay?pa=good.shop@ybl&am=1,000", /invalid/],
    ["bare dot amount", "upi://pay?pa=good.shop@ybl&am=.", /invalid/],
    ["zero amount", "upi://pay?pa=good.shop@ybl&am=0.00", /greater than zero/],
    ["foreign currency", "upi://pay?pa=good.shop@ybl&cu=USD", /Unsupported currency/],
    ["BharatQR / EMV card code", "00020101021126410010A00000052401230000000000000000000000005204581253033565802IN6304ABCD", /BharatQR/],
    ["raw control character", "upi://pay?pa=good.shop@ybl\u0007&pn=x", /control characters/],
    ["over the length cap", "upi://pay?pa=x@ybl&pn=" + "x".repeat(MAX_UPI_PAYLOAD), /unusually long/],
    ["collect / mandate action", "UPI://MANDATE?pa=good.shop@ybl", /Only upi:\/\/pay/],
  ])("rejects %s", (_name, payload, err) => {
    const r = parseUpiPayload(payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(err);
  });

  it("strips control, markup and bidi-override characters from QR text", () => {
    const r = parseUpiPayload("upi://pay?pa=x@ybl&pn=%E2%80%AEevil%3Cb%3E%0Ashop&tn=%22hi%22");
    expect(r.ok && r.value.payeeName).toBe("evilbshop");
    expect(r.ok && r.value.note).toBe("hi");
  });

  it("accepts real-world handle shapes and rejects junk", () => {
    for (const v of ["Q123456789@ybl", "paytmqr281005050101abcd@paytm", "merchant.name@okicici", "BHARATPE.9000000000@fbpe", "9876543210@upi", "abc-def_1@oksbi", "8799792366.wallet@phonepe", "x@ybl"]) {
      expect(validateVpa(v)).toBeNull();
    }
    for (const v of ["@ybl", "name@", "name@y", "na me@ybl", "name@@ybl", ".name@ybl", "name@1bank", "name@ybl<script>"]) {
      expect(validateVpa(v)).not.toBeNull();
    }
  });
});

describe("QR camera helpers", () => {
  const fakeMedia = (failFirstWith?: string) => {
    const calls: MediaStreamConstraints[] = [];
    const stream = { id: "s" } as unknown as MediaStream;
    return {
      calls,
      stream,
      media: {
        getUserMedia: async (c?: MediaStreamConstraints) => {
          calls.push(c!);
          if (failFirstWith && calls.length === 1) throw new DOMException("camera says no", failFirstWith);
          return stream;
        },
      },
    };
  };

  it.each(["OverconstrainedError", "NotReadableError", "NotFoundError", "AbortError"])("retries with { video: true } after %s", async (name) => {
    const f = fakeMedia(name);
    await expect(openCameraStream(f.media)).resolves.toBe(f.stream);
    expect(f.calls).toEqual([PREFERRED_CAMERA, FALLBACK_CAMERA]);
  });

  it("asks for the rear camera at 720p first and does not retry a permission denial", async () => {
    const ok = fakeMedia();
    await openCameraStream(ok.media);
    expect(ok.calls).toEqual([PREFERRED_CAMERA]);
    expect(PREFERRED_CAMERA.video).toMatchObject({ facingMode: { ideal: "environment" }, width: { ideal: 1280 } });
    const denied = fakeMedia("NotAllowedError");
    await expect(openCameraStream(denied.media)).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(denied.calls).toHaveLength(1);
  });

  it("maps camera errors to user-facing problems", () => {
    const err = (name: string) => new DOMException("x", name);
    expect(classifyCameraError(err("NotAllowedError"))).toBe("denied");
    expect(classifyCameraError(err("SecurityError"), false)).toBe("insecure");
    expect(classifyCameraError(err("NotFoundError"))).toBe("unavailable");
    expect(classifyCameraError(err("NotReadableError"))).toBe("busy");
    expect(classifyCameraError(new Error("boom"))).toBe("error");
  });

  it("plans still-image passes: native size first, then inverted, turned and rescaled", () => {
    const shot = stillImagePlan(1080, 2340);
    expect(shot[0]).toMatchObject({ size: 1600 });
    expect(shot[0]!.attempts[0]).toEqual({ diagonal: true });
    expect(shot.some((s) => s.invert)).toBe(true);
    expect(shot.some((s) => s.rotate === 90)).toBe(true);
    expect(shot.at(-1)).toMatchObject({ size: 2340 }); // full detail last for big images
    const tiny = stillImagePlan(150, 150);
    expect(tiny[0]!.size).toBe(150);
    expect(tiny.map((s) => s.size)).toContain(900); // tiny thumbnails are upscaled
    expect(Math.max(...stillImagePlan(4000, 3000).map((s) => s.size))).toBe(2800);
  });
});
