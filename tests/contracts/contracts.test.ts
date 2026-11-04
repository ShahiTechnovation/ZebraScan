/** Contract tests: route table ↔ handlers ↔ OpenAPI parity, wire-format guarantees. */
import { describe, expect, it } from "vitest";
import { ROUTES, MinorStr, QuoteZ, CheckoutPublicZ, createApiClient, ApiClientError } from "@zeb/contracts";
import { buildOpenApi } from "@zeb/contracts/openapi";
import { HANDLERS } from "../../apps/api/src/server";

describe("route table", () => {
  it("every route has a handler and vice versa", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(ROUTES).sort());
  });
  it("every public state-changing command requires an Idempotency-Key (except auth/session flows)", () => {
    const exempt = new Set(["walletChallenge", "walletVerify", "emailOtpRequest", "emailOtpVerify", "scanParse", "register", "login", "logout", "verifyEmail", "resendVerification", "forgotPassword", "resetPassword", "revokeSession", "stepUp", "opsLogin", "parseUpi", "quoteWithdrawal", "internalZcashEvents", "internalP2PEvents", "internalWebhook"]);
    for (const r of Object.values(ROUTES)) {
      if (r.method === "GET" || exempt.has(r.operationId)) continue;
      expect(r.idempotent, r.operationId).toBe(true);
    }
  });
  it("covers every normative path from the spec", () => {
    const paths = new Set(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const p of [
      "GET /api/v1/public/config",
      "POST /api/v1/scan-pay/intents",
      "POST /api/v1/merchant-terminal/intents",
      "GET /api/v1/m/:handle",
      "POST /api/v1/pay/:slug/checkouts",
      "POST /api/v1/checkout/:id/refresh",
      "GET /api/v1/balance/entries",
      "POST /api/v1/withdrawals/:id/cancel",
      "GET /api/v1/receipts/:id/download",
      "POST /api/v1/ops/exception/:id/decide",
      "POST /api/v1/internal/zcash/events",
    ]) expect(paths.has(p), p).toBe(true);
  });
});

describe("openapi", () => {
  it("is 3.1 with all non-demo operations and the SSE endpoint", () => {
    const doc = buildOpenApi();
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p as Record<string, { operationId: string }>).map((o) => o.operationId));
    const expected = Object.values(ROUTES).filter((r) => !("demoOnly" in r && r.demoOnly)).map((r) => r.operationId);
    for (const id of expected) expect(ops).toContain(id);
    expect(ops).toContain("streamEvents");
    expect(ops).not.toContain("demoSimulateDeposit");
  });
});

describe("wire money", () => {
  it("is integer strings only", () => {
    expect(MinorStr.safeParse("100").success).toBe(true);
    for (const bad of [100, "1.5", "01", "-1", "1e3"]) expect(MinorStr.safeParse(bad).success).toBe(false);
    expect(QuoteZ.shape.zecZatoshis).toBeDefined();
    expect(CheckoutPublicZ.shape.accessPolicy).toBeDefined();
  });
});

describe("typed client", () => {
  it("substitutes params, sends idempotency keys, and fails loudly on contract drift", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://api.test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ wrong: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(client.call("getCheckout", { params: { id: "pi_aaaaaaaaaaaaaaaaaaaaaaaaaa" }, accessToken: "tok" })).rejects.toBeInstanceOf(ApiClientError);
    expect(calls[0]!.url).toBe("http://api.test/api/v1/checkout/pi_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    await client.call("createQuote", { body: { mode: "scan_pay", inrPaise: "100" } }).catch(() => undefined);
    expect((calls[1]!.init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });
});
