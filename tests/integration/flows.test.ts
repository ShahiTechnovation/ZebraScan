/**
 * End-to-end backend flows over real PostgreSQL + real HTTP stack (demo environment).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { reconcile, expireIntents } from "@zeb/core";
import { Client, key, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
}, 60_000);
afterAll(async () => h?.close());

async function quote(c: Client, mode: string, inrPaise: string, extra: Record<string, string> = {}) {
  const r = await c.req("POST", "/api/v1/quotes", { body: { mode, inrPaise, privacyPreference: "shielded", ...extra }, key: key() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json;
}

async function simulate(c: Client, id: string, token: string, kind = "exact", confirmations = 0) {
  return c.req("POST", `/api/v1/demo/checkout/${id}/simulate-deposit`, { body: { kind, confirmations }, key: key(), bearer: token });
}

async function confirm(c: Client, id: string, token: string, times: number) {
  let last: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < times; i++) last = await c.req("POST", `/api/v1/demo/checkout/${id}/advance`, { key: key(), bearer: token });
  return last;
}

async function merchantClient(handle: string): Promise<Client> {
  const m = new Client(h.app);
  const reg = await m.req("POST", "/api/v1/auth/register", { body: { email: `${handle}@example.test`, password: "correct horse battery staple" } });
  expect(reg.status, JSON.stringify(reg.json)).toBe(201);
  const cm = await m.req("POST", "/api/v1/merchants", { body: { displayName: `Shop ${handle}`, handle, category: "food" }, key: key() });
  expect(cm.status, JSON.stringify(cm.json)).toBe(201);
  return m;
}

describe("public", () => {
  it("serves config, health, openapi and honest demo labels", async () => {
    const c = new Client(h.app);
    const cfg = await c.req("GET", "/api/v1/public/config");
    expect(cfg.status).toBe(200);
    expect(cfg.json.environment).toBe("demo");
    expect(cfg.json.label).toBe("DEMO");
    expect(cfg.json.capabilities.realChainAddresses).toBe(false);
    const health = await c.req("GET", "/api/v1/public/health");
    expect(health.json.products.scanPay.available).toBe(true);
    const oa = await c.req("GET", "/api/v1/openapi.json");
    expect(oa.json.openapi).toBe("3.1.0");
    expect(Object.keys(oa.json.paths).length).toBeGreaterThan(60);
    expect((await c.req("GET", "/healthz")).status).toBe(200);
    expect((await c.req("GET", "/readyz")).json.db).toBe(true);
  });

  it("parses UPI QR server-side and rejects non-UPI payloads", async () => {
    const c = new Client(h.app);
    const ok = await c.req("POST", "/api/v1/upi/parse", { body: { payload: "upi://pay?pa=chai.stall@okaxis&pn=Chai%20Stall&am=125.50&cu=INR&mc=5411" } });
    expect(ok.status).toBe(200);
    expect(ok.json.amountInrPaise).toBe("12550");
    expect(ok.json.support).toBe("supported_with_notice");
    expect(ok.json.vpaMasked).not.toContain("chai.stall");
    const bad = await c.req("POST", "/api/v1/upi/parse", { body: { payload: "https://evil.example/pay" } });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("QR_NOT_UPI");
  });

  it("quotes with exact integer-string money and rejects out-of-policy amounts", async () => {
    const c = new Client(h.app);
    const q = await quote(c, "scan_pay", "50000");
    expect(q.inrPaise).toBe("50000");
    expect(q.zecZatoshis).toMatch(/^\d+$/);
    expect(q.paymentEligible).toBe(true);
    expect(q.priceSource).toContain("demo-constants");
    const big = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "99999999999", privacyPreference: "shielded" }, key: key() });
    expect(big.status).toBe(422);
    expect(big.json.code).toBe("QUOTE_AMOUNT_TOO_HIGH");
    const float = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "500.5", privacyPreference: "shielded" }, key: key() });
    expect(float.status).toBe(400);
  });

  it("requires Idempotency-Key, replays exactly, and rejects key reuse with a different body", async () => {
    const c = new Client(h.app);
    const no = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "10000", privacyPreference: "shielded" } });
    expect(no.status).toBe(400);
    const k = key();
    const a = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "10000", privacyPreference: "shielded" }, key: k });
    const b = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "10000", privacyPreference: "shielded" }, key: k });
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    const d = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "20000", privacyPreference: "shielded" }, key: k });
    expect(d.status).toBe(409);
    expect(d.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("Scan & Pay (PAY orderType 2)", () => {
  it("runs quote → intent → deposit → confirmations → accepted → P2P PAY → completed, with balanced ledger", async () => {
    const c = new Client(h.app);
    const q = await quote(c, "scan_pay", "25000");
    const created = await c.req("POST", "/api/v1/scan-pay/intents", {
      body: { quoteId: q.id, payee: { vpa: "chai.stall@okaxis", payeeName: "Chai Stall", source: "qr_paste" }, payeeConfirmed: true, refundPreference: "manual_review" },
      key: key(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const { checkout, accessToken } = created.json;
    expect(checkout.status).toBe("awaiting_zec");
    expect(checkout.zcash.payable).toBe(false);
    expect(checkout.zcash.address).toMatch(/^zebscan-demo-address-.*-not-payable$/);
    expect(checkout.recipient.vpaMasked).not.toContain("chai.stall");
    expect(JSON.stringify(checkout)).not.toContain("chai.stall@okaxis");

    // quote cannot back a second intent
    const again = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.id, payee: { vpa: "x.y@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    expect(again.status).toBe(409);

    // scoped access: no token → 404
    const anon = new Client(h.app);
    expect((await anon.req("GET", `/api/v1/checkout/${checkout.id}`)).status).toBe(404);

    let s = await simulate(c, checkout.id, accessToken, "exact", 0);
    expect(s.json.status).toBe("deposit_seen");
    s = await confirm(c, checkout.id, accessToken, 3);
    expect(s.json.status).toBe("deposit_accepted");
    expect(s.json.payout.status).toBe("payout_queued");
    expect(s.json.receiptId).toBeTruthy();

    await h.runJobs();
    const done = await c.req("GET", `/api/v1/scan-pay/intents/${checkout.id}`, { bearer: accessToken });
    expect(done.json.payout.status).toBe("completed");
    expect(done.json.payout.honestStatus).toContain("not a bank statement");
    expect(done.json.timeline.some((e: { type: string }) => e.type === "payout.usdc_escrowed")).toBe(true);

    const receipt = await c.req("GET", `/api/v1/receipts/${done.json.receiptId}`, { bearer: accessToken });
    expect(receipt.status).toBe(200);
    expect(receipt.json.status).toBe("completed");
    expect(receipt.json.verification).toBe("simulated");

    const rec = await reconcile(h.ctx, "test");
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("matches two same-amount concurrent invoices by address, never by amount", async () => {
    const c = new Client(h.app);
    const [q1, q2] = await Promise.all([quote(c, "scan_pay", "33300"), quote(c, "scan_pay", "33300")]);
    const mk = (q: { id: string }) =>
      c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.id, payee: { vpa: "same.amount@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    const [a, b] = await Promise.all([mk(q1), mk(q2)]);
    expect(a.json.checkout.zcash.address).not.toBe(b.json.checkout.zcash.address);
    // pay only B
    await simulate(c, b.json.checkout.id, b.json.accessToken, "exact", 3);
    const ra = await c.req("GET", `/api/v1/checkout/${a.json.checkout.id}`, { bearer: a.json.accessToken });
    const rb = await c.req("GET", `/api/v1/checkout/${b.json.checkout.id}`, { bearer: b.json.accessToken });
    expect(ra.json.status).toBe("awaiting_zec");
    expect(rb.json.status).toBe("deposit_accepted");
    // A's token cannot read B
    expect((await c.req("GET", `/api/v1/checkout/${b.json.checkout.id}`, { bearer: a.json.accessToken })).status).toBe(404);
  });

  it("routes underpayment to review without accepting it", async () => {
    const c = new Client(h.app);
    const q = await quote(c, "scan_pay", "15000");
    const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.id, payee: { vpa: "under.paid@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    const s = await simulate(c, r.json.checkout.id, r.json.accessToken, "underpaid", 3);
    expect(s.json.status).toBe("underpaid");
    expect(s.json.payout.status).toBe("not_started");
    expect(s.json.accessPolicy.canRequestRefund).toBe(true);
  });

  it("detects late deposits after expiry and never accepts them", async () => {
    const c = new Client(h.app);
    const q = await quote(c, "scan_pay", "12000");
    const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.id, payee: { vpa: "late.payer@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    const id = r.json.checkout.id;
    await h.db.query(`UPDATE payment_intents SET deposit_submission_deadline = now() - interval '1 minute' WHERE id=$1`, [id]);
    expect(await expireIntents(h.ctx)).toBeGreaterThanOrEqual(1);
    const expired = await c.req("GET", `/api/v1/checkout/${id}`, { bearer: r.json.accessToken });
    expect(expired.json.status).toBe("expired_without_funds");
    const s = await simulate(c, id, r.json.accessToken, "exact", 3);
    expect(s.json.status).toBe("late_deposit");
    const exc = await h.db.query(`SELECT kind FROM exceptions WHERE intent_id=$1`, [id]);
    expect(exc.rows.map((x) => x.kind)).toContain("late_deposit");
  });

  it("cancel is only allowed before any deposit", async () => {
    const c = new Client(h.app);
    const q = await quote(c, "scan_pay", "11000");
    const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.id, payee: { vpa: "cancel.me@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    const ok = await c.req("POST", `/api/v1/scan-pay/intents/${r.json.checkout.id}/cancel`, { key: key(), bearer: r.json.accessToken });
    expect(ok.json.status).toBe("cancelled");
    const q2 = await quote(c, "scan_pay", "11000");
    const r2 = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q2.id, payee: { vpa: "cancel.me@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    await simulate(c, r2.json.checkout.id, r2.json.accessToken, "exact", 0);
    const no = await c.req("POST", `/api/v1/scan-pay/intents/${r2.json.checkout.id}/cancel`, { key: key(), bearer: r2.json.accessToken });
    expect(no.status).toBe(409);
    expect(no.json.currentStatus).toBe("deposit_seen");
  });
});

describe("merchant terminal, credits and withdrawal (SELL orderType 1)", () => {
  it("credits locked → available → withdraw → completed; ledger reconciles", async () => {
    const m = await merchantClient("monsoon-chai");
    const sess = await m.req("GET", "/api/v1/merchants/session");
    expect(sess.json.authenticated).toBe(true);
    expect(sess.json.role).toBe("owner");

    // CSRF required on cookie-authenticated mutations
    const csrf = m.csrf;
    m.csrf = null;
    const noCsrf = await m.req("POST", "/api/v1/links", { body: { title: "x", amountMode: "fixed", fixedInrPaise: "10000" }, key: key() });
    expect(noCsrf.status).toBe(403);
    m.csrf = csrf;

    const q = await quote(m, "terminal", "80000");
    const t = await m.req("POST", "/api/v1/merchant-terminal/intents", { body: { quoteId: q.id }, key: key() });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    // merchant can read its own checkout via session (no token)
    expect((await m.req("GET", `/api/v1/checkout/${t.json.checkout.id}`)).status).toBe(200);
    await simulate(m, t.json.checkout.id, t.json.accessToken, "exact", 3);

    let bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.lockedInrPaise).toBe("80000");
    expect(bal.json.availableInrPaise).toBe("0");
    expect(bal.json.redeemable).toBe(false);

    await h.runJobs(); // credit.unlock (cooldown 0 in tests)
    bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.availableInrPaise).toBe("80000");

    // payout destination requires step-up; login/register grants a fresh step-up window
    const pd = await m.req("POST", "/api/v1/merchants/me/payout-destinations", { body: { vpa: "monsoon.chai@okhdfcbank", beneficiaryName: "Monsoon Chai" }, key: key() });
    expect(pd.status).toBe(403); // email not verified yet
    const tok = await h.db.query(`SELECT id FROM auth_tokens WHERE purpose='verify_email' ORDER BY created_at DESC LIMIT 1`);
    expect(tok.rowCount).toBe(1);
    await h.db.query(`UPDATE users SET email_verified_at=now()`); // token itself is only emailed; mark verified directly
    const pd2 = await m.req("POST", "/api/v1/merchants/me/payout-destinations", { body: { vpa: "monsoon.chai@okhdfcbank", beneficiaryName: "Monsoon Chai" }, key: key() });
    expect(pd2.status, JSON.stringify(pd2.json)).toBe(201);
    expect(pd2.json.vpaMasked).not.toContain("monsoon.chai");
    const stored = await h.db.query(`SELECT vpa_ct FROM payout_destinations WHERE id=$1`, [pd2.json.id]);
    expect(stored.rows[0].vpa_ct).not.toContain("monsoon");

    const wq = await m.req("POST", "/api/v1/withdrawals/quote", { body: { inrPaise: "50000" } });
    expect(wq.json.executable, JSON.stringify(wq.json)).toBe(true);
    const w = await m.req("POST", "/api/v1/withdrawals", { body: { inrPaise: "50000", payoutDestinationId: pd2.json.id }, key: key() });
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    expect(w.json.status).toBe("awaiting_provider");
    bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.availableInrPaise).toBe("30000");
    expect(bal.json.reservedInrPaise).toBe("50000");

    const second = await m.req("POST", "/api/v1/withdrawals", { body: { inrPaise: "10000", payoutDestinationId: pd2.json.id }, key: key() });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("WITHDRAWAL_ALREADY_ACTIVE");

    await h.runJobs();
    const wd = await m.req("GET", `/api/v1/withdrawals/${w.json.id}`);
    expect(wd.json.status).toBe("completed");
    bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.reservedInrPaise).toBe("0");
    expect(bal.json.withdrawnInrPaise).toBe("50000");
    expect(bal.json.availableInrPaise).toBe("30000");

    const settlements = await m.req("GET", "/api/v1/settlements");
    expect(settlements.json.items.some((x: { status: string }) => x.status === "split")).toBe(false);
    const entries = await m.req("GET", "/api/v1/balance/entries?limit=50");
    expect(entries.json.items.length).toBeGreaterThan(3);

    const rec = await reconcile(h.ctx, "test");
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it("cancels a withdrawal before provider commitment and restores credits exactly once", async () => {
    const m = await merchantClient("cancel-shop");
    await h.db.query(`UPDATE users SET email_verified_at=now() WHERE email_normalized='cancel-shop@example.test'`);
    const q = await quote(m, "terminal", "40000");
    const t = await m.req("POST", "/api/v1/merchant-terminal/intents", { body: { quoteId: q.id }, key: key() });
    await simulate(m, t.json.checkout.id, t.json.accessToken, "exact", 3);
    await h.runJobs();
    const pd = await m.req("POST", "/api/v1/merchants/me/payout-destinations", { body: { vpa: "cancel.shop@okicici" }, key: key() });
    const w = await m.req("POST", "/api/v1/withdrawals", { body: { inrPaise: "40000", payoutDestinationId: pd.json.id }, key: key() });
    expect(w.status).toBe(201);
    const c1 = await m.req("POST", `/api/v1/withdrawals/${w.json.id}/cancel`, { key: key() });
    expect(c1.json.status).toBe("cancelled");
    const c2 = await m.req("POST", `/api/v1/withdrawals/${w.json.id}/cancel`, { key: key() });
    expect(c2.status).toBe(409);
    const bal = await m.req("GET", "/api/v1/balance");
    expect(bal.json.availableInrPaise).toBe("40000");
    expect(bal.json.reservedInrPaise).toBe("0");
  });

  it("enforces RBAC and tenant isolation", async () => {
    const a = await merchantClient("tenant-a");
    const b = await merchantClient("tenant-b");
    const q = await quote(a, "terminal", "10000");
    const t = await a.req("POST", "/api/v1/merchant-terminal/intents", { body: { quoteId: q.id }, key: key() });
    expect((await b.req("GET", `/api/v1/checkout/${t.json.checkout.id}`)).status).toBe(404);
    expect((await b.req("GET", `/api/v1/transactions/${t.json.checkout.id}`)).status).toBe(404);
    const anon = new Client(h.app);
    expect((await anon.req("GET", "/api/v1/balance")).status).toBe(401);
  });
});

describe("payment links", () => {
  it("opening does not consume quota; a use-limit-1 link refunds a second paid checkout", async () => {
    const m = await merchantClient("link-shop");
    const l = await m.req("POST", "/api/v1/links", { body: { title: "Workshop ticket", amountMode: "fixed", fixedInrPaise: "20000", reusable: false }, key: key() });
    expect(l.status, JSON.stringify(l.json)).toBe(201);
    const payer = new Client(h.app);
    for (let i = 0; i < 3; i++) expect((await payer.req("GET", `/api/v1/pay/${l.json.slug}`)).json.status).toBe("active");
    const mk = async () => {
      const q = await quote(payer, "payment_link", "20000", { linkSlug: l.json.slug });
      return payer.req("POST", `/api/v1/pay/${l.json.slug}/checkouts`, { body: { quoteId: q.id }, key: key() });
    };
    const c1 = await mk();
    const c2 = await mk();
    expect(c1.status).toBe(201);
    expect(c2.status).toBe(201);
    await simulate(payer, c1.json.checkout.id, c1.json.accessToken, "exact", 3);
    const s2 = await simulate(payer, c2.json.checkout.id, c2.json.accessToken, "exact", 3);
    expect(s2.json.status).toBe("refund_queued");
    expect((await payer.req("GET", `/api/v1/pay/${l.json.slug}`)).json.status).toBe("exhausted");
    const wrong = await quote(payer, "payment_link", "19999", { linkSlug: l.json.slug });
    const c3 = await payer.req("POST", `/api/v1/pay/${l.json.slug}/checkouts`, { body: { quoteId: wrong.id }, key: key() });
    expect(c3.status).toBe(409);
    // public link data never exposes payout details
    const pub = await payer.req("GET", `/api/v1/pay/${l.json.slug}`);
    expect(JSON.stringify(pub.json)).not.toMatch(/vpa|payout/i);
  });

  it("revoke blocks new checkouts but keeps an in-flight one payable", async () => {
    const m = await merchantClient("revoke-shop");
    const l = await m.req("POST", "/api/v1/links", { body: { title: "Donation", amountMode: "variable", minInrPaise: "1000", maxInrPaise: "50000" }, key: key() });
    const payer = new Client(h.app);
    const q = await quote(payer, "payment_link", "5000", { linkSlug: l.json.slug });
    const c = await payer.req("POST", `/api/v1/pay/${l.json.slug}/checkouts`, { body: { quoteId: q.id }, key: key() });
    await m.req("POST", `/api/v1/links/${l.json.id}/revoke`, { key: key() });
    const s = await simulate(payer, c.json.checkout.id, c.json.accessToken, "exact", 3);
    expect(s.json.status).toBe("deposit_accepted");
    const q2 = await quote(payer, "payment_link", "5000", { linkSlug: l.json.slug });
    const c2 = await payer.req("POST", `/api/v1/pay/${l.json.slug}/checkouts`, { body: { quoteId: q2.id }, key: key() });
    expect(c2.status).toBe(409);
    expect(c2.json.code).toBe("STATE_LINK_REVOKED");
  });
});

describe("ledger and safety invariants", () => {
  it("ledger is append-only and rejects unbalanced journals at the database level", async () => {
    await expect(h.db.query(`UPDATE ledger_postings SET debit_minor = debit_minor + 1`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`DELETE FROM ledger_journals`)).rejects.toThrow(/append-only/);
    const c = await h.db.connect();
    try {
      await c.query("BEGIN");
      await c.query(`INSERT INTO ledger_journals(id, environment, event_id, kind, effective_at) VALUES ('jnl_bad','demo','bad','test',now())`);
      await c.query(`INSERT INTO ledger_postings(id, journal_id, account_id, currency, debit_minor) VALUES ('pst_bad','jnl_bad','acct_demo_zcash_asset','ZEC',5)`);
      await expect(c.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    await expect(h.db.query(`UPDATE quotes SET zec_zatoshis = 1`)).rejects.toThrow(/immutable/);
  });

  it("duplicate scanner events are harmless; reorg after acceptance freezes the credit", async () => {
    const m = await merchantClient("reorg-shop");
    const q = await quote(m, "terminal", "30000");
    const t = await m.req("POST", "/api/v1/merchant-terminal/intents", { body: { quoteId: q.id }, key: key() });
    const id = t.json.checkout.id;
    await simulate(m, id, t.json.accessToken, "exact", 3);
    const addr = (await h.db.query(`SELECT za.address FROM zcash_addresses za JOIN payment_intents pi ON pi.zcash_address_id=za.id WHERE pi.id=$1`, [id])).rows[0].address;
    const txid = createHash("sha256").update(`demo:${id}`).digest("hex");
    const ev = { eventId: `reorg-${id}`, kind: "note_reorged", network: "demo", pool: "demo", txid, outputRef: `${txid}:0`, valueZatoshis: q.zecZatoshis, address: addr, blockHeight: null, blockHash: null, confirmations: 0, scanVersion: "test" };
    const { ingestScannerEvent } = await import("@zeb/core");
    expect((await ingestScannerEvent(h.ctx, ev as never)).duplicate).toBe(false);
    expect((await ingestScannerEvent(h.ctx, ev as never)).duplicate).toBe(true);
    const credit = await h.db.query(`SELECT status FROM merchant_credits WHERE intent_id=$1`, [id]);
    expect(credit.rows[0].status).toBe("frozen");
    const status = await m.req("GET", `/api/v1/checkout/${id}`);
    expect(status.json.status).toBe("chain_reorg_review");
    const exc = await h.db.query(`SELECT severity FROM exceptions WHERE intent_id=$1 AND kind='reorg_after_acceptance'`, [id]);
    expect(exc.rows[0].severity).toBe("urgent");
  });

  it("internal endpoints require a valid HMAC signature", async () => {
    const c = new Client(h.app);
    const body = JSON.stringify({ eventId: "abcdefgh1", type: "placed", chainId: 84532, orderId: "1", txHash: `0x${"a".repeat(64)}`, blockNumber: "1" });
    const unsigned = await h.app.inject({ method: "POST", url: "/api/v1/internal/p2p/events", headers: { "content-type": "application/json" }, payload: body });
    expect(unsigned.statusCode).toBe(401);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "x".repeat(40)).update(`${t}.${body}`).digest("hex");
    const signed = await h.app.inject({ method: "POST", url: "/api/v1/internal/p2p/events", headers: { "content-type": "application/json", "x-zeb-signature": `t=${t},v1=${sig}` }, payload: body });
    // demo has no P2P chain configured → rejected after authentication, not before
    expect(signed.statusCode).toBe(400);
    expect(c).toBeTruthy();
  });

  it("final reconciliation across all flows is clean", async () => {
    const rec = await reconcile(h.ctx, "final");
    // reorg test froze a credit: the liability check tolerates frozen credits under review
    expect(rec.checks.filter((x) => !x.ok)).toEqual([]);
  });
});
