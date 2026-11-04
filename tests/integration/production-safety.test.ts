import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ingestScannerEvent, expireIntents, quoteInputsHash, buildHandlers, claim, runJob, type ScannerEvent, type CoreContext, type QuoteRow } from "@zeb/core";
import { environmentCapabilities } from "@zeb/domain";
import { Client, key, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => { h = await makeHarness(); }, 60_000);
afterAll(async () => h?.close());

async function invoice() {
  const c = new Client(h.app);
  const q = await c.req("POST", "/api/v1/quotes", { body: { mode: "scan_pay", inrPaise: "25000", privacyPreference: "shielded" }, key: key() });
  const r = await c.req("POST", "/api/v1/scan-pay/intents", { body: { quoteId: q.json.id, payee: { vpa: "test.recipient@okaxis", source: "manual" }, payeeConfirmed: true }, key: key() });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.checkout.id as string;
  const address = (await h.db.query(`SELECT address FROM zcash_addresses WHERE intent_id=$1`, [id])).rows[0].address as string;
  return { id, address, zat: q.json.zecZatoshis as string };
}
function event(address: string, zat: string, tag: string, conf=3): ScannerEvent {
  const txid = createHash("sha256").update(tag).digest("hex");
  return { eventId: `${tag}:${conf}`, kind: conf ? "note_confirmed" : "note_seen", network: "demo", pool: "demo", txid, outputRef: `${txid}:0`, valueZatoshis: zat, address, blockHeight: conf ? 100 : null, blockHash: null, confirmations: conf, scanVersion: "isolated-regression" };
}

it("persists distinct unmatched outputs and per-output exceptions; replays and reorg/remine book custody once", async () => {
  const a=event("owned-unmatched", "12345", "unmatched-a");
  const b=event("owned-unmatched", "67890", "unmatched-b");
  await Promise.all([ingestScannerEvent(h.ctx,a),ingestScannerEvent(h.ctx,b)]);
  await ingestScannerEvent(h.ctx,a);
  const rows = (await h.db.query(`SELECT * FROM deposit_observations WHERE intent_id IS NULL`)).rows;
  expect(rows).toHaveLength(2);
  expect((await h.db.query(`SELECT deposit_id FROM exceptions WHERE kind='unattributed_deposit'`)).rows).toHaveLength(2);
  expect((await h.db.query(`SELECT 1 FROM ledger_journals WHERE event_id LIKE 'custody:%'`)).rowCount).toBe(2);
  await ingestScannerEvent(h.ctx,{...a,eventId:"reorg-a",kind:"note_reorged",blockHeight:null,confirmations:0,memo:null});
  await ingestScannerEvent(h.ctx,{...a,eventId:"remine-a",blockHeight:101});
  const p=(await h.db.query(`SELECT custody_booked,custody_revision FROM deposit_observations WHERE txid=$1`,[a.txid])).rows[0];
  expect(p).toEqual({custody_booked:true,custody_revision:1});
  const sums=await h.db.query(`SELECT sum(p.debit_minor)-sum(p.credit_minor) AS net FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id JOIN ledger_journals j ON j.id=p.journal_id WHERE a.code='zcash_asset' AND j.event_id LIKE 'custody:%'`);
  expect(sums.rows[0].net).toBe("80235");
});

it("late zero-confirmation and second payments remain observations until final, with no duplicate custody", async () => {
  const i=await invoice();
  await h.db.query(`UPDATE payment_intents SET deposit_submission_deadline=now()-interval '1 minute' WHERE id=$1`,[i.id]);
  await expireIntents(h.ctx);
  const e=event(i.address,i.zat,"late-pending",0);
  await ingestScannerEvent(h.ctx,e);
  const deposit=(await h.db.query(`SELECT id,custody_booked FROM deposit_observations WHERE txid=$1`,[e.txid])).rows[0];
  expect(deposit.custody_booked).toBe(false);
  expect((await h.db.query(`SELECT 1 FROM ledger_journals WHERE event_id LIKE $1`,[`custody:${deposit.id}:%`])).rowCount).toBe(0);
  await ingestScannerEvent(h.ctx,{...e,eventId:"late-final",kind:"note_confirmed",blockHeight:100,confirmations:3});
  await ingestScannerEvent(h.ctx,{...e,eventId:"late-more",kind:"note_confirmed",blockHeight:100,confirmations:4});
  expect((await h.db.query(`SELECT 1 FROM ledger_journals WHERE event_id LIKE $1`,[`custody:${deposit.id}:%`])).rowCount).toBe(1);
  expect((await h.db.query(`SELECT payout_status FROM payment_intents WHERE id=$1`,[i.id])).rows[0].payout_status).toBe("not_started");
});

it("null-memo reorg resolves a persisted memo-matched accepted output", async () => {
  const i=await invoice(); const memo="ZEB-CCCCCCCCCCCCCCCC";
  await h.db.query(`UPDATE zcash_addresses SET memo_code=$2 WHERE intent_id=$1`,[i.id,memo]);
  const e={...event(i.address,i.zat,"memo-reorg"),memo};
  await ingestScannerEvent(h.ctx,e);
  await ingestScannerEvent(h.ctx,{...e,eventId:"memo-reorg-removed",kind:"note_reorged",blockHeight:null,confirmations:0,memo:null});
  expect((await h.db.query(`SELECT canonical FROM deposit_observations WHERE txid=$1`,[e.txid])).rows[0].canonical).toBe(false);
  expect((await h.db.query(`SELECT status,payout_status FROM payment_intents WHERE id=$1`,[i.id])).rows[0]).toEqual({status:"chain_reorg_review",payout_status:"manual_review"});
});

it("testnet receipts create only ZEC books, no INR credit or payout, and survive replay", async () => {
  const source=await invoice();
  const pi=(await h.db.query(`SELECT * FROM payment_intents WHERE id=$1`,[source.id])).rows[0];
  const qr=(await h.db.query(`SELECT * FROM quotes WHERE id=$1`,[pi.quote_id])).rows[0] as QuoteRow;
  const za=(await h.db.query(`SELECT * FROM zcash_addresses WHERE intent_id=$1`,[source.id])).rows[0];
  // Real schema + testnet domain path; fixtures stay entirely within the isolated _test DB.
  const q={...qr,id:`${qr.id}_testnet`,environment:"testnet",consumed_by:null}; q.inputs_hash=quoteInputsHash(q);
  const id=`${pi.id}_testnet`;const zid=`${za.id}_testnet`;const address="utest1"+"q".repeat(120);
  await h.db.query(`INSERT INTO quotes SELECT * FROM json_populate_record(NULL::quotes,$1::json)`,[JSON.stringify(q)]);
  await h.db.query(`INSERT INTO payment_intents SELECT * FROM json_populate_record(NULL::payment_intents,$1::json)`,[JSON.stringify({...pi,id,environment:"testnet",quote_id:q.id,zcash_address_id:null})]);
  await h.db.query(`INSERT INTO zcash_addresses SELECT * FROM json_populate_record(NULL::zcash_addresses,$1::json)`,[JSON.stringify({...za,id:zid,intent_id:id,environment:"testnet",network:"testnet",address})]);
  await h.db.query(`UPDATE payment_intents SET zcash_address_id=$2 WHERE id=$1`,[id,zid]);
  const ctx:CoreContext={...h.ctx,env:"testnet",caps:environmentCapabilities("testnet"),cfg:{...h.ctx.cfg,environment:"testnet",zcashNetwork:"testnet"}};
  const e:ScannerEvent={...event(address,source.zat,"testnet-final"),network:"testnet",pool:"ironwood"};
  await ingestScannerEvent(ctx,e);await ingestScannerEvent(ctx,{...e,eventId:"testnet-replay",confirmations:4});
  expect((await h.db.query(`SELECT 1 FROM receipts WHERE intent_id=$1`,[id])).rowCount).toBe(1);
  expect((await h.db.query(`SELECT 1 FROM merchant_credits WHERE environment='testnet'`)).rowCount).toBe(0);
  expect((await h.db.query(`SELECT 1 FROM payout_commands WHERE environment='testnet'`)).rowCount).toBe(0);
  expect((await h.db.query(`SELECT p.currency FROM ledger_postings p JOIN ledger_journals j ON j.id=p.journal_id WHERE j.environment='testnet'`)).rows.map(r=>r.currency)).toEqual(["ZEC","ZEC"]);
});

it("early credit unlock claim remains durably queued, then unlocks exactly once when due",async()=>{
  const c=new Client(h.app);
  await c.req("POST","/api/v1/auth/register",{body:{email:"unlock-regression@example.test",password:"correct horse battery staple"}});
  await c.req("POST","/api/v1/merchants",{body:{displayName:"Unlock test",handle:"unlock-regression",category:"food"},key:key()});
  const q=await c.req("POST","/api/v1/quotes",{body:{mode:"terminal",inrPaise:"50000",privacyPreference:"shielded"},key:key()});
  const i=await c.req("POST","/api/v1/merchant-terminal/intents",{body:{quoteId:q.json.id},key:key()});
  await c.req("POST",`/api/v1/demo/checkout/${i.json.checkout.id}/simulate-deposit`,{body:{kind:"exact",confirmations:3},key:key(),bearer:i.json.accessToken});
  const credit=(await h.db.query(`SELECT id FROM merchant_credits WHERE intent_id=$1`,[i.json.checkout.id])).rows[0].id;
  await h.db.query(`UPDATE merchant_credits SET unlocks_at=now()+interval '1 hour' WHERE id=$1`,[credit]);
  const job=(await claim(h.ctx,"unlock-regression",100)).find(j=>j.kind==="credit.unlock"&&j.payload.creditId===credit)!;
  expect(job).toBeTruthy();
  await runJob(h.ctx,buildHandlers(null),job,"unlock-regression");
  expect((await h.db.query(`SELECT state,run_at>now() AS future FROM jobs WHERE id=$1`,[job.id])).rows[0]).toEqual({state:"queued",future:true});
  const future={...h.ctx,now:()=>new Date(Date.now()+7_200_000)};
  await h.db.query(`UPDATE jobs SET run_at=now() WHERE id=$1`,[job.id]);
  const due=(await claim(future,"unlock-regression",100)).find(j=>j.id===job.id)!;
  await runJob(future,buildHandlers(null),due,"unlock-regression");
  expect((await h.db.query(`SELECT status FROM merchant_credits WHERE id=$1`,[credit])).rows[0].status).toBe("credit_available");
  expect((await h.db.query(`SELECT 1 FROM ledger_journals WHERE event_id=$1`,[`credit_unlock:${credit}`])).rowCount).toBe(1);
});
