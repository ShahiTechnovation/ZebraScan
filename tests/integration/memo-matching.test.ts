/** Memo-matched invoices (zkool watcher pattern): shared address, unique memo, never match by amount. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ingestScannerEvent } from "@zeb/core";
import { Client, key, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
}, 60_000);
afterAll(async () => h?.close());

async function intent(c: Client, inr: string) {
  const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: inr, privacyPreference: "shielded" }, key: key() });
  const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "memo.shop@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
  return { id: r.json.checkout.id as string, zat: q.json.zecZatoshis as string, token: r.json.accessToken as string };
}

it("two same-amount invoices on ONE shared address are told apart only by memo", async () => {
  const c = new Client(h.app);
  const a = await intent(c, "20000");
  const b = await intent(c, "20000");
  // Simulate the zkool layout: both invoices share one address and carry distinct memo codes.
  const shared = "zebscan-demo-address-shared-not-payable";
  await h.db.query(`UPDATE zcash_addresses SET address=$1, memo_code='ZEB-AAAAAAAAAAAAAAAA' WHERE intent_id=$2`, [shared, a.id]);
  await h.db.query(`UPDATE zcash_addresses SET address=$1, memo_code='ZEB-BBBBBBBBBBBBBBBB' WHERE intent_id=$2`, [shared, b.id]);
  const ev = (txid: string, memo: string | null, zat: string) => ({ eventId: `t:${txid}`, kind: "note_confirmed" as const, network: "demo", pool: "demo" as const, txid, outputRef: `${txid}:note0`, valueZatoshis: zat, address: shared, blockHeight: 10, blockHash: null, confirmations: 3, scanVersion: "test", memo });
  const tx1 = createHash("sha256").update("1").digest("hex");
  await ingestScannerEvent(h.ctx, ev(tx1, "ZEB-BBBBBBBBBBBBBBBB", b.zat));
  const sa = await c.req("GET", `/api/v1/checkout/${a.id}`, { bearer: a.token });
  const sb = await c.req("GET", `/api/v1/checkout/${b.id}`, { bearer: b.token });
  expect(sa.json.status).toBe("awaiting_zec");
  expect(sb.json.status).toBe("deposit_accepted");
  // Same amount, no memo → never guessed: urgent unattributed deposit.
  const tx2 = createHash("sha256").update("2").digest("hex");
  await ingestScannerEvent(h.ctx, ev(tx2, null, a.zat));
  expect((await c.req("GET", `/api/v1/checkout/${a.id}`, { bearer: a.token })).json.status).toBe("awaiting_zec");
  const exc = await h.db.query(`SELECT severity, details FROM exceptions WHERE kind='unattributed_deposit'`);
  expect(exc.rows[0].severity).toBe("urgent");
  expect(JSON.stringify(exc.rows[0].details)).not.toContain("ZEB-");
});

it("unique-address invoice: the SAME accepted note seen again with more confirmations is bookkeeping, not an extra deposit (found live on testnet)", async () => {
  const c = new Client(h.app);
  const a = await intent(c, "20000");
  const addr = (await h.db.query(`SELECT address FROM zcash_addresses WHERE intent_id=$1`, [a.id])).rows[0].address as string;
  const txid = createHash("sha256").update("live-regression").digest("hex");
  const ev = (conf: number, height: number | null) => ({ eventId: `t:${txid}:${height}:${conf}`, kind: height ? ("note_confirmed" as const) : ("note_seen" as const), network: "demo", pool: "demo" as const, txid, outputRef: `${txid}:p3:d1:${a.zat}:0`, valueZatoshis: a.zat, address: addr, blockHeight: height, blockHash: null, confirmations: conf, scanVersion: "test", memo: null });
  await ingestScannerEvent(h.ctx, ev(0, null)); // mempool
  await ingestScannerEvent(h.ctx, ev(3, 10)); // mined, accepted
  for (const conf of [4, 5, 6]) await ingestScannerEvent(h.ctx, ev(conf, 10)); // later polls
  await ingestScannerEvent(h.ctx, ev(6, 10)); // exact replay (restart)
  const s = await c.req("GET", `/api/v1/checkout/${a.id}`, { bearer: a.token });
  expect(s.json.status).toBe("deposit_accepted");
  expect(s.json.receivedZatoshis).toBe(a.zat);
  expect(s.json.timeline.filter((t: { label: string }) => /Additional ZEC/.test(t.label))).toHaveLength(0);
  const obs = await h.db.query(`SELECT confirmations FROM deposit_observations WHERE txid=$1`, [txid]);
  expect(obs.rows).toHaveLength(1);
  expect(Number(obs.rows[0].confirmations)).toBe(6);
  const credits = await h.db.query(`SELECT count(*)::int AS n FROM receipts WHERE intent_id=$1`, [a.id]);
  expect(credits.rows[0].n).toBe(1);
});
