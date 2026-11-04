// Apply the independently rechecked late-arriving wallet evidence to the initial audit snapshot.
import { readFileSync, writeFileSync } from "node:fs";
const base = "docs/evidence/audit-2026-11-04";
const final = JSON.parse(readFileSync(`${base}/runtime-final.json`, "utf8"));
const mainnet = JSON.parse(readFileSync(`${base}/mainnet-readonly-final.json`, "utf8"));
const d = final.acceptedReceipts[0];
if (!d || d.txid !== final.receiverNotes.data.transactionsByAccount[0]?.txid || d.zec_journals !== 1) throw new Error("Final receipt evidence inconsistent");
const note = `**Final evidence update — ${final.checkedAt} (21:50 IST), SHA ${final.sha}.** A payment performed by concurrent work was independently rechecked read-only: Ironwood incoming note ${d.txid}, ${d.value_zatoshis} zatoshis, block ${d.block_height}, ${d.confirmations} confirmations in the DB, accepted invoice ${d.id}, exactly one ZEC journal, payout ${d.payout_status}. This supersedes the initial empty-receiver observation. Mainnet read-only local API was independently checked at ${mainnet.checkedAt}: synced ${mainnet.networks[0].chainTipHeight}, receiving=false, realMoney=false; full consensus/key-isolation certification remains blocked. See [final testnet evidence](evidence/audit-2026-11-04/runtime-final.json) and [mainnet status](evidence/audit-2026-11-04/mainnet-readonly-final.json). No transfer was submitted by this audit. Source snapshot/reproduction findings remain open.\n\n`;
const files = ["PRODUCTION_AUDIT_REPORT", "ISSUE_REGISTER", "PAYMENT_FLOW_TRACE", "EXTERNAL_DEPENDENCIES", "FINANCIAL_INVARIANTS", "PRODUCTION_READINESS_MATRIX", "REMEDIATION_PLAN", "OPERATOR_RUNBOOK"];
function edit(name, fn) {
 const p=`docs/${name}.md`; let s=readFileSync(p,"utf8"); s=fn(s); writeFileSync(p,s);
}
for(const name of files) edit(name,s=>s.replace(/^(# [^\n]+\n\n)/,`$1${note}`));
edit("PRODUCTION_AUDIT_REPORT",s=>s
 .replace("A real JWT-protected testnet wallet and a local API/worker/DB exist, but the snapshot contains no receiver note or accepted deposit.","A real JWT-protected testnet wallet and local API/worker/DB now have a verified Ironwood invoice receipt (final evidence above). The early snapshot had none; later evidence was independently rechecked.")
 .replace("No INR or ZEC was sent during this audit.","This audit submitted no INR or ZEC transfer; concurrent work supplied the new testnet transaction.")
 .replace("currentHeight=4582562 at the later snapshot, receiver transactions empty", "initial currentHeight=4582562 with no receiver transactions; final query matches the accepted Ironwood note above")
 .replace("DB has migrations 0001–0005, one intent, no deposits/credits/payout commands.", "DB has migrations 0001–0005; final query has one accepted intent/output, one ZEC journal, one testnet INR journal, no merchant credits or payout commands.")
 .replace("No production data was deliberately changed; isolated test schemas were reset by the existing harness.","The audit deliberately changed only isolated test schemas. Existing connected-test tooling exercised simulated services; read-only readiness endpoints can refresh rate snapshots. Production build commands also regenerated tracked API/worker dist artifacts; concurrent changes were preserved.")
 .replace("The required next business milestone is one genuine testnet invoice receipt after the P0 containment steps; live fiat remains a separate gate.","The genuine testnet receipt milestone is now evidenced. Next verify a connected public checkout and restart/replay safety after P0 containment; live fiat remains a separate gate.")
 .replace("Only the first two have substantial evidence here", "Implementation, automated tests and one real testnet receipt have evidence")
 .replace("PASS before audit tooling; final tooling check recorded separately", "PASS including audit TypeScript tooling (final-typecheck.log)")
 .replace("See final captured log; simulated backend only", "PASS: 2 scenarios; simulated chain/provider backend only")
 .replace("Auth/signature", "Auth/signature")
 .replace("Mainnet wallet endpoint GET returned 405. Authenticated account, consensus, balances, birth-height scan and secret isolation remain BLOCKED. No mainnet funds queried or moved.","Initial mainnet endpoint GET returned 405. Final local read-only API reports synced height 3541772 with receiving disabled; imported empty watch account and auth evidence appeared concurrently. Consensus/receiver decoding/key isolation and restart certification remain BLOCKED. This audit moved no mainnet funds.")
 .replaceAll("BLOCKED: no invoice note", "PASS: one Ironwood receipt; runtime-final.json")
 .replaceAll("BLOCKED: no accepted note", "PASS: one accepted receipt + one ZEC journal")
 .replaceAll("BLOCKED: no invoice receipt", "PASS: one local Scan & Pay receipt; public UI still demo")
 .replace("BLOCKED: complete real wallet journey absent", "PASS: quoted 836471 zatoshis received on invoice")
 .replaceAll("BLOCKED: no authenticated mainnet sync", "PASS: local read-only status; consensus certification blocked")
 .replaceAll("BLOCKED: GET 405 only", "PASS: local read-only sync only")
 .replace("BLOCKED: wallet HTTP presence only", "PASS: local read-only sync only")
 .replace("README still", "Historical README still")
 );
edit("ISSUE_REGISTER", s=>{
 const start=s.indexOf("## ZEB-008"); const end=s.indexOf("## ZEB-009");
 return s.slice(0,start)+`## ZEB-008 — Complete real receipt restart and concurrent-invoice proof\n\nSeverity: P1\nSystem: Zcash / Deployment\nEnvironment + network: public testnet wallet, local connected API/worker\nStatus: BLOCKED (remaining restart/public-UI proof; first receipt PASS)\nReproduction / observed: At 16:00 UTC no receiver note existed. At ${final.checkedAt}, independent read-only wallet and DB queries matched ${d.txid}, incoming pool 3/scope 0, ${d.value_zatoshis} zatoshis, block ${d.block_height}, ${d.confirmations} confirmations, accepted invoice and one ZEC journal. No payout command exists.\nExpected: Preserve this proof through scanner/DB restart and a connected public checkout; prove multiple invoices without cross-credit.\nEvidence: evidence/audit-2026-11-04/runtime-final.json; docs/evidence/testnet-checkout-pi_kddd0fe7.json; initial runtime.json retained as historical.\nRoot cause: First-receipt gap resolved by concurrent work. Remaining verification is blocked by no authorized service restart/production connected deployment during this audit; not evidence the successful receipt is broken.\nImpact: Cannot certify continuous public operation or generalize one receipt into full production readiness.\nSafe temporary mitigation: Preserve successful receipt; keep testnet nonredeemable and all live payouts disabled.\nMinimal fix: Apply P0 accounting/privilege fixes, deploy connected UI, then controlled restart/replay and multi-invoice tests.\nDependencies: Persistent service setup; any additional send needs existing or new explicit bounded authorization.\nOwner / next action: Zcash/operations owner to attach restart/public-UI evidence.\nRetest: E04–E08/E26/E27, one effect after replay and no skipped incoming outputs.\n\n`+s.slice(end);
});
edit("PAYMENT_FLOW_TRACE",s=>s
 .replace("Current DB contains one testnet intent, not created by this audit.","DB contains the testnet intent later accepted in the final evidence; it was not created by this audit.")
 .replace("Current runtime has no receiver notes.","Initial runtime had no receiver notes; final verification matched the real Ironwood note, invoice, quote and one ZEC journal.")
 .replace("Testnet deposit acceptance would record", "The verified testnet deposit acceptance recorded")
 .replace("emit payout disabled and issue receipt", "emitted payout disabled and issued a receipt")
 .replace("No real merchant note observed.","No merchant-terminal note observed; the real receipt is Scan & Pay only.")
 );
edit("EXTERNAL_DEPENDENCIES",s=>s
 .replace("PASS for tip connectivity; no invoice note yet", "PASS for tip and one real Ironwood invoice receipt")
 .replace("PASS connectivity; BLOCKED full Ironwood receipt/reorg proof", "PASS connectivity/one Ironwood receipt; reorg/restart certification FAIL/BLOCKED")
 .replace("empty current transactions", "one final incoming Ironwood note")
 .replace("BLOCKED receipt; least-privilege authority FAIL ZEB-006", "PASS receipt; least-privilege authority FAIL ZEB-006")
 .replace("BLOCKED A→invoice proof; no send authorized in this audit", "PASS receipt matched from concurrent send; audit did not submit it")
 .replace("BLOCKED authenticated account/network/birthday verification", "PASS local read-only sync; actual consensus/key isolation/restart verification BLOCKED")
 .replace("BLOCKED actual finalized submission status/video/feedback proof", "BLOCKED actual finalized submission status/video/feedback proof; testnet receipt now available")
 );
edit("FINANCIAL_INVARIANTS",s=>s
 .replace("real receipt/reorg safety separately blocked/failed", "one real receipt now verified; reorg/restart safety separately failed/blocked")
 .replace("The current tests prove isolated mechanics, not actual asset backing or bank delivery.","The automated tests prove isolated mechanics; the final wallet/DB probe additionally proves one real testnet receipt. Neither proves real INR backing or bank delivery.")
 );
edit("REMEDIATION_PLAN",s=>s
 .replace("The first business milestone is a genuine public testnet receipt. Security/financial containment below comes before that receipt; mainnet and INR execution remain disabled throughout.","The first business milestone—a genuine public testnet invoice receipt—was completed by concurrent work and independently verified. Preserve that evidence; P0 containment, connected public UI and restart/replay proof are next. Mainnet customer receiving and INR execution remain disabled.")
 .replace("prove ONE actual A→invoice-B shielded receipt", "preserve the verified receipt and prove restart/replay/public UI")
 .replace("The next receiving patch must fix unmatched/reorg accounting before accepting a test payment.","The next receiving patch must fix unmatched/reorg accounting before further test payments.")
 );
edit("PRODUCTION_READINESS_MATRIX",s=>{
 const replaceRow=(id,status,why)=>{s=s.replace(new RegExp(`^\\| E${id} \\| ([^|]+) \\|.*$`,"m"),`| E${id} | $1 | ${status} | ${why} |`);};
 replaceRow("04","PASS","Final real invoice: exact quote 836471 zatoshis, diversified UA and incoming Ironwood pool-3 note. Full generic decoder audit remains ZEB-013.");
 replaceRow("05","PASS","Real testnet TXID independently matched in wallet and DB; supplied by concurrent work, not sent by audit. Explorer scripted access unavailable.");
 replaceRow("06","PASS","Server automatic seen→confirming→accepted timeline; final scoped wallet query matches accepted output. No client TXID entered by audit.");
 replaceRow("07","PASS","Wallet mined height 4582568; DB 40 confirmations vs required 1 at final capture. Consensus/block-hash witness limitations remain ZEB-013.");
 replaceRow("08","BLOCKED","One accepted output/one ZEC journal observed across repeated worker polls; duplicate-event fixture PASS. Full replay/restart acceptance awaits controlled real-wallet restart drill.");
 for (const [n,status,why] of [
 [15,"PASS","Final independent wallet/DB query proves one Ironwood pool-3 receipt; generic receiver/consensus compatibility still ZEB-013."],
 [18,"BLOCKED","UFVK/birth and synced status now include real note; full birth-height rescan/restart proof absent."],
 [24,"BLOCKED","One diversified invoice received correctly; two concurrent real invoices and restore proof still absent."],
 [29,"PASS","Real server timeline and wallet note show seen→mined→accepted; final runtime-final.json has 40 confirmations."],
 [39,"BLOCKED","Real shielded invoice receipt PASS via wallet/DB/timeline; complete deployed UI journey remains blocked because public product is demo."],
 [40,"PASS","Final independent local mainnet-readonly API reports sync height 3541772, receiving=false and realMoney=false; no send performed."],
 ]) s=s.replace(new RegExp(`^\\| ${n} \\| ([^|]+) \\|.*$`,"m"),`| ${n} | $1 | ${status} | ${why} |`);
 return s;
});
writeFileSync("docs/SUBMISSION_EVIDENCE.md", `# Submission evidence — verified testnet receipt\n\n${note}## Verified receipt\n\n- TXID: ${d.txid}\n- [Public testnet explorer](https://zexplorer.app/testnet/tx/${d.txid})\n- Invoice: ${d.id}; mode Scan & Pay; network testnet.\n- Received/quoted: ${d.value_zatoshis} zatoshis (0.00836471 TAZ); incoming Ironwood pool 3, external scope 0, diversifier 1.\n- Mined block: ${d.block_height}; DB confirmations ${d.confirmations} at final capture; required 1.\n- Accepted observation and exactly one deposit ZEC journal verified directly. One testnet INR bookkeeping journal also exists (ZEB-014); it creates no real INR entitlement.\n- INR payout: not_started; no payout command; testnet nonredeemable.\n- Evidence: [independent final wallet/DB probe](evidence/audit-2026-11-04/runtime-final.json), [server checkout timeline](evidence/testnet-checkout-pi_kddd0fe7.json). The transaction was performed by concurrent work; this audit only queried its state.\n\nThe server timeline shows invoice creation, mempool detection, mining/acceptance and payout-disabled event. The historical timeline also contains spurious Additional ZEC events on confirmation updates; concurrent commit 7335aa7 fixes that behavior. Financial entries were not duplicated in the final query. Explicit restart/rescan and multiple real invoice proofs remain BLOCKED. Explorer scripted access was unavailable; the wallet and independent application DB are the captured receipt evidence.\n\nThe earlier faucet TXID b056fc3a752cc67edd6f212791846406985d387e09225cbcb3143ec8f7b0d9b2 is funding evidence for payer A, not this invoice. Use the receipt TXID above for the payment-core evidence. Never describe it as an INR payout.\n\n## Public app and README\n\n[Public app](https://zebrascan.vercel.app) is reachable but remains a labeled demo at the browser capture. It is not yet a real connected public checkout. README was updated concurrently during the final review; it should link this evidence and preserve the distinction between real local testnet receipt, public demo, mainnet read-only sync and unverified fiat settlement. No video/interview/submission-finalization evidence was independently captured.\n\n## Privacy/trust\n\nShielding hides payment details on the public chain; the platform/wallet host sees incoming amounts/memos through viewing access. Lightwallet service sees traffic metadata. TinyFish/P2P provider/banks see relevant fiat details if that rail is authorized. No seed, spending key or checkout bearer token is included here. TAZ is worthless and cannot back redeemable INR.\n\n## Stadium status\n\n[Official privacy track](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), version 2026-11-02, and [event index](https://stadium.joinwebzero.com/programs/free-society-hack-2026/llms.txt) were refetched. The index lists first-session finalization at 20:00 IST on 4 November and submission close at 00:00 IST on 5 November. Actual draft/finalized/feedback/video state is BLOCKED: no authenticated Stadium record was inspected and no submission was made by this audit.\n\nMilestones: implementation and automated fixture tests substantially evidenced; one actual public-testnet invoice receipt PASS; mainnet local read-only synchronization PASS with consensus/key-certification limits; live fiat pilot BLOCKED; full public production FAIL.\n`);
console.log("Updated all nine audit documents with independently verified final receipt and mainnet read-only status.");
