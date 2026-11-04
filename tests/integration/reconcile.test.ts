/**
 * Regression: reconciliation must not freeze on an unknown/stale inventory (fresh deployment),
 * but MUST freeze payouts when a fresh chain observation is below active allocations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcile, resetReadinessCache } from "@zeb/core";
import { Client, key, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
}, 60_000);
afterAll(async () => h?.close());

describe("reconciliation gates", () => {
  it("does not freeze when inventory was never observed", async () => {
    await h.db.query(`DELETE FROM treasury_inventory`);
    const r = await reconcile(h.ctx, "fresh");
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "allocations_within_inventory")?.status).toBe("BLOCKED");
    expect((await h.db.query(`SELECT 1 FROM feature_gates WHERE enabled = false`)).rowCount).toBe(0);
  });

  it("freezes Scan & Pay and withdrawals when allocations exceed a fresh inventory observation", async () => {
    await h.db.query(`INSERT INTO treasury_inventory(environment, asset, amount_minor, source) VALUES ('demo','USDC_BASE', 25000000000, 'test')`);
    const c = new Client(h.app);
    const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "50000", privacyPreference: "shielded" }, key: key() });
    const i = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "freeze.test@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
    expect(i.status).toBe(201);
    // Chain now reports far less USDC than is reserved.
    await h.db.query(`INSERT INTO treasury_inventory(environment, asset, amount_minor, source) VALUES ('demo','USDC_BASE', 1, 'test:shortfall')`);
    const r = await reconcile(h.ctx, "shortfall");
    expect(r.ok).toBe(false);
    const gates = await h.db.query(`SELECT feature FROM feature_gates WHERE enabled = false ORDER BY feature`);
    expect(gates.rows.map((g) => g.feature)).toEqual(["scanPay", "withdrawals"]);
    resetReadinessCache();
    const q2 = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "50000", privacyPreference: "shielded" }, key: key() });
    expect(q2.json.paymentEligible).toBe(false);
    expect(q2.json.disabledReason).toMatch(/Paused: Reconciliation discrepancy/);
    const exc = await h.db.query(`SELECT severity FROM exceptions WHERE kind='reconciliation_discrepancy'`);
    expect(exc.rows[0]?.severity).toBe("urgent");
  });
});
