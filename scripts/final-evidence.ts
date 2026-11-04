/** Read-only, redacted evidence. Never emits credentials, viewing keys, addresses or memos. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createPool} from "@zeb/db";
import {loadConfig,buildContext} from "@zeb/core";
const env:Record<string,string>={};
for(const file of ['.env','var/secrets/testnet.env','var/secrets/testnet-worker.env']){
 if(!existsSync(file))continue;
 for(const line of readFileSync(file,'utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line);if(m)env[m[1]!]=m[2]!.replace(/^"|"$/g,'');}
}
const db=createPool(env.DATABASE_URL!,{applicationName:'zeb-final-evidence'});
const report:Record<string,unknown>={at:new Date().toISOString(),sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
try{
 const c=await db.connect();await c.query('BEGIN READ ONLY');
 try{
  const id='pi_kddd0fe7xccewd6x2csrhykxdr';
  report.receipt=(await c.query(`SELECT pi.id,pi.status,pi.payout_status,pi.received_zatoshis,pi.receipt_id,
    (SELECT count(*)::int FROM receipts WHERE intent_id=pi.id) AS receipt_count,
    (SELECT count(*)::int FROM deposit_observations WHERE intent_id=pi.id) AS observation_count
    FROM payment_intents pi WHERE pi.id=$1`,[id])).rows;
  report.outputs=(await c.query(`SELECT network,pool,txid,value_zatoshis,block_height,confirmations,canonical,accepted FROM deposit_observations WHERE intent_id=$1`,[id])).rows;
  const receipt=(await c.query(`SELECT payload,validation_hash FROM receipts WHERE intent_id=$1`,[id])).rows[0];
  report.receiptDigest=receipt?createHash('sha256').update(JSON.stringify(receipt)).digest('hex'):null;
  report.journals=(await c.query(`SELECT j.id,j.event_id,j.kind,j.reversal_of,p.currency,sum(p.debit_minor)::text AS debits,sum(p.credit_minor)::text AS credits FROM ledger_journals j JOIN ledger_postings p ON p.journal_id=j.id WHERE j.event_id LIKE $1 OR j.reversal_of IN (SELECT id FROM ledger_journals WHERE event_id LIKE $1) GROUP BY j.id,p.currency ORDER BY j.event_id`,[`deposit_accepted:${id}:%`])).rows;
  report.migrations=(await c.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows;
  report.gates=(await c.query(`SELECT environment,feature,enabled,reason FROM feature_gates ORDER BY environment,feature`)).rows;
  report.walletState=(await c.query(`SELECT network,status,tip_height,tip_hash,scanned_height,consensus_branch,tip_observed_at,updated_at FROM scanner_state WHERE environment='testnet'`)).rows;
  report.provider=(await c.query(`SELECT status,reasons,created_at,expires_at FROM p2p_capability_reports WHERE environment='testnet' ORDER BY created_at DESC LIMIT 1`)).rows;
  report.payoutCommands=(await c.query(`SELECT environment,count(*)::int FROM payout_commands GROUP BY environment`)).rows;
 }finally{await c.query('ROLLBACK');c.release();}
 try{
  const ctx=buildContext(loadConfig(env),{db,log:{info(){},warn(){},error(){}}});
  if(ctx.zkool){const st=await ctx.zkool.status();report.chain={network:st.network,tip:st.tipHeight,scanned:st.scannedHeight,hash:st.tipHash,time:st.tipTime,branch:st.consensusBranchId,state:st.state,nu7:st.nu7Active};}
 }catch(e){report.walletCheck={status:'BLOCKED',code:(e as {code?:string}).code??'WALLET_UNAVAILABLE'};}
 for(const [name,url] of Object.entries({testnetApi:'http://localhost:4000/api/v1/public/config',mainnetApi:'http://localhost:4100/api/v1/public/config',web:'https://zebrascan.vercel.app'})){
  try{const r=await fetch(url,{signal:AbortSignal.timeout(12000)});report[name]={url,status:r.status,...(name.endsWith('Api')?{config:await r.json()}: {})};}catch{report[name]={url,status:'UNREACHABLE'};}
 }
 const dir='docs/evidence/final-production';mkdirSync(dir,{recursive:true});
 const label=process.argv[2]??'runtime';if(!/^[a-z0-9-]+$/.test(label))throw new Error('invalid evidence label');
 writeFileSync(`${dir}/${label}.json`,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({saved:`${dir}/${label}.json`,receipt:report.receipt,chain:report.chain??report.walletCheck}));
}finally{await db.end();}
