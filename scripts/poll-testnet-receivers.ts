/** One restart/replay verification using only configured viewer credentials. */
import {readFileSync,writeFileSync} from 'node:fs';
import {loadConfig,buildContext,pollScanner} from '@zeb/core';
const env:Record<string,string>={};for(const f of ['.env','var/secrets/testnet.env','var/secrets/testnet-worker.env'])for(const line of readFileSync(f,'utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line);if(m)env[m[1]!]=m[2]!.replace(/^"|"$/g,'');}
const ctx=buildContext(loadConfig(env));
if(ctx.env!=='testnet')throw new Error('Testnet only');
try {
 const before=(await ctx.db.query(`SELECT id,status FROM payment_intents WHERE id='pi_kddd0fe7xccewd6x2csrhykxdr'`)).rows;
 await pollScanner(ctx);await pollScanner(ctx);
 const after=(await ctx.db.query(`SELECT id,status,payout_status FROM payment_intents WHERE id='pi_kddd0fe7xccewd6x2csrhykxdr'`)).rows;
 const saved=(await ctx.db.query(`SELECT txid,output_ref,block_height,canonical,confirmations,wallet_id FROM deposit_observations WHERE txid='5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7'`)).rows;
 const counts=(await ctx.db.query(`SELECT (SELECT count(*) FROM receipts WHERE intent_id='pi_kddd0fe7xccewd6x2csrhykxdr')::text AS receipts,(SELECT count(*) FROM ledger_journals)::text AS journals,(SELECT count(*) FROM ledger_postings)::text AS postings,(SELECT count(*) FROM payout_commands)::text AS payouts`)).rows[0];
 const result={at:new Date().toISOString(),before,after,saved,counts,watchedAccounts:[ctx.zkool!.accountId,...(ctx.zkoolLegacy??[]).map(z=>z.accountId)]};
 writeFileSync('docs/evidence/final-production/replay-restoration.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await ctx.db.end();}
