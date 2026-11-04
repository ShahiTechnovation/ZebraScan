/** Encrypted pre-migration backup + isolated restore verification, then forward migration. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createPool,migrate} from '@zeb/db';
import {parseEnvironment} from '@zeb/domain';
const settings:Record<string,string>={};
for(const line of readFileSync('var/secrets/testnet.env','utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line);if(m)settings[m[1]!]=m[2]!.replace(/^"|"$/g,'');}
if(parseEnvironment(settings.ZEB_ENVIRONMENT)!=='testnet')throw new Error('Only the existing testnet database is permitted');
const uri=new URL(settings.DATABASE_URL!);
const pgEnv={...process.env,PGHOST:uri.hostname,PGPORT:uri.port||'5432',PGUSER:decodeURIComponent(uri.username),PGPASSWORD:decodeURIComponent(uri.password),PGDATABASE:uri.pathname.slice(1)};
const exe='C:/Program Files/PostgreSQL/18/bin/';
const db=createPool(uri.toString());
const stamp=new Date().toISOString().replace(/\D/g,'');
const restoreName=`zebscan_recovery_${stamp}_test`;
const adminUri=new URL(uri);adminUri.pathname='/postgres';const admin=createPool(adminUri.toString());
const restoreUri=new URL(uri);restoreUri.pathname='/'+restoreName;
let restored:ReturnType<typeof createPool>|undefined;
async function signature(pool:ReturnType<typeof createPool>){return (await pool.query(`SELECT (SELECT count(*) FROM deposit_observations WHERE txid='5c1f713d64e74a06352db9d75a1a5d988eeb8121c250bd010614e6c918dcd8f7')::text AS outputs,(SELECT count(*) FROM receipts WHERE intent_id='pi_kddd0fe7xccewd6x2csrhykxdr')::text AS receipts,(SELECT count(*) FROM ledger_postings)::text AS postings,(SELECT count(*) FROM ledger_journals)::text AS journals`)).rows[0];}
try {
 const dump=spawnSync(exe+'pg_dump.exe',['-Fc','--no-owner','--no-acl'],{env:pgEnv,windowsHide:true,maxBuffer:128*1024*1024});
 if(dump.status!==0)throw new Error('pg_dump failed; no migration attempted');
 mkdirSync('var/backups',{recursive:true});
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(dump.stdout),cipher.final()]);
 const backup=`var/backups/testnet-${stamp}.aesgcm`;const keyPath=`var/secrets/backup-${stamp}.key`;
 writeFileSync(backup,Buffer.concat([iv,cipher.getAuthTag(),encrypted]),{mode:0o600});writeFileSync(keyPath,key,{mode:0o600});
 await admin.query(`CREATE DATABASE "${restoreName}"`);
 const restore=spawnSync(exe+'pg_restore.exe',['--no-owner','--no-acl','--exit-on-error','-d',restoreName],{env:{...pgEnv,PGDATABASE:restoreName},input:dump.stdout,windowsHide:true,maxBuffer:128*1024*1024});
 if(restore.status!==0)throw new Error('Isolated restore failed; no migration attempted');
 restored=createPool(restoreUri.toString());const verified=await signature(restored);const before=await signature(db);
 if(JSON.stringify(before)!==JSON.stringify(verified))throw new Error('Restore differs from live baseline; no migration attempted');
 const migrations=await migrate(db);const after=await signature(db);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Preservation invariant changed');
 const evidence={at:new Date().toISOString(),backup,backupSha256:createHash('sha256').update(readFileSync(backup)).digest('hex'),keyLocation:keyPath,restoreDatabase:restoreName,before,restored:verified,after,migrations,offlineBackup:'BLOCKED: operator must escrow encrypted backup and key separately off-host'};
 writeFileSync('docs/evidence/final-production/backup-migration.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await restored?.end();await db.end();await admin.end();}
