/** Operator-only read audit. No key material or addresses are emitted. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createPrivateKey} from 'node:crypto';
import {loadConfig,buildContext} from '@zeb/core';
import {signZkoolJwt,ZkoolWatcher} from '@zeb/providers';
const env:Record<string,string>={};
for(const f of ['.env','var/secrets/testnet.env','var/secrets/testnet-worker.env']) for(const line of readFileSync(f,'utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line);if(m)env[m[1]!]=m[2]!.replace(/^"|"$/g,'');}
const ctx=buildContext(loadConfig(env));
try {
 const saved=(await ctx.db.query(`SELECT d.output_ref,d.block_height,d.canonical,d.scan_version,d.updated_at,d.reorged_at,za.wallet_id,za.birthday_height FROM deposit_observations d LEFT JOIN zcash_addresses za ON za.id=d.zcash_address_id WHERE d.txid=$1`,['5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7'])).rows;
 console.log(JSON.stringify({saved}));
 const key=createPrivateKey(readFileSync('var/secrets/zkool-testnet-jwt.key','utf8'));
 const response=await fetch(ctx.cfg.zkool!.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${signZkoolJwt(key,{sub:0,write:false,ttlSeconds:300})}`},body:JSON.stringify({query:'{ accounts { id name birth height incomingOnly } }'}),signal:AbortSignal.timeout(120000)});
 const body=await response.json() as {data?:{accounts:Array<{id:number;name:string;birth:number;height:number;incomingOnly:boolean}>}};
 if(!response.ok||!body.data)throw new Error(`Account inventory unavailable (HTTP ${response.status})`);
 console.log(JSON.stringify({accounts:body.data.accounts}));
 const originalId=Number(String(saved[0]?.wallet_id).split(':')[2]);
 if(!body.data.accounts.some(a=>a.id===originalId))throw new Error('Original receiver account missing; require UFVK-only restore');
 const z=new ZkoolWatcher({...ctx.cfg.zkool!,accountId:originalId,jwtFile:undefined,jwt:signZkoolJwt(key,{sub:originalId,write:false,ttlSeconds:900}),birthHeight:saved[0]?.birthday_height});
 const st=await z.status();
 const rows=(await ctx.db.query(`SELECT diversifier_index::text,address FROM zcash_addresses WHERE environment='testnet' AND wallet_id=$1`,[`zkool:testnet:${originalId}`])).rows;
 const events=await z.snapshot(st.tipHeight,new Map(rows.map(r=>[r.diversifier_index,r.address])));
 const matching=events.filter(e=>e.txid==='5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7').map(({txid,outputRef,blockHeight,confirmations,pool,valueZatoshis})=>({txid,outputRef,blockHeight,confirmations,pool,valueZatoshis}));
 const result={at:new Date().toISOString(),saved,accounts:body.data.accounts,tip:st.tipHeight,scanned:st.scannedHeight,matching};
 writeFileSync('docs/evidence/final-production/receiver-accounts.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {await ctx.db.end();}
