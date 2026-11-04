import {readFileSync,writeFileSync} from 'node:fs';
import {loadConfig,buildContext} from '@zeb/core';
const env:Record<string,string>={};for(const f of ['.env','var/secrets/testnet.env','var/secrets/testnet-worker.env'])for(const line of readFileSync(f,'utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line);if(m)env[m[1]!]=m[2]!.replace(/^"|"$/g,'');}
const ctx=buildContext(loadConfig(env));
try{
 const z=ctx.zkool!; const st=await z.status();
 const rows=(await ctx.db.query(`SELECT diversifier_index::text,address FROM zcash_addresses WHERE environment='testnet' AND wallet_id=$1`,[`zkool:testnet:${z.accountId}`])).rows;
 const events=await z.snapshot(st.tipHeight,new Map(rows.map(r=>[r.diversifier_index,r.address])));
 const txid='5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7';
 const saved=(await ctx.db.query(`SELECT d.output_ref,d.block_height,d.canonical,d.scan_version,d.updated_at,d.reorged_at,za.wallet_id,za.birthday_height FROM deposit_observations d LEFT JOIN zcash_addresses za ON za.id=d.zcash_address_id WHERE d.txid=$1`,[txid])).rows;
 const matching=events.filter(e=>e.txid===txid).map(({outputRef,blockHeight,confirmations,pool,valueZatoshis})=>({outputRef,blockHeight,confirmations,pool,valueZatoshis}));
 const audit=(await ctx.db.query(`SELECT action,details,created_at FROM audit_log WHERE target='pi_kddd0fe7xccewd6x2csrhykxdr' ORDER BY id DESC LIMIT 10`)).rows;
 const result={at:new Date().toISOString(),tip:st.tipHeight,scanned:st.scannedHeight,knownAddressCount:rows.length,totalEvents:events.length,saved,matching,audit};
 writeFileSync('docs/evidence/final-production/preserved-output-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await ctx.db.end();}
