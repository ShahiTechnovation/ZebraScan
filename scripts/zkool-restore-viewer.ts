/** Non-destructive UFVK-only recovery, run on an isolated operator host. */
import {createPrivateKey,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {signZkoolJwt} from '@zeb/providers';
const args=process.argv.slice(2);const arg=(name:string)=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args[i+1];};
const url=arg('url');
if(arg('network')!=='testnet')throw new Error('Only testnet recovery is authorized here; mainnet requires separately reviewed offline custody.');
if(!url || new URL(url).protocol!=='https:')throw new Error('Explicit HTTPS wallet endpoint required');
if(args.includes('--faucet')||args.includes('--seed-file'))throw new Error('Funding and seed import are prohibited');
const backup=JSON.parse(readFileSync(arg('backup')??'var/secrets/testnet-receiver.json','utf8')) as {ufvk:string;birth:number};
if(typeof backup.ufvk!=='string'||!backup.ufvk.startsWith('uviewtest1')||!Number.isSafeInteger(backup.birth)||backup.birth<1)throw new Error('Securely provisioned testnet UFVK and exact birthday required');
const key=createPrivateKey(readFileSync('var/secrets/zkool-testnet-jwt.key','utf8'));
async function gql<T>(query:string,variables?:unknown):Promise<T>{
 const r=await fetch(url!,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${signZkoolJwt(key,{sub:0,write:true,ttlSeconds:300})}`},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(120000)});
 const body=await r.json() as {data?:T;errors?:unknown[]};
 if(!r.ok||body.errors?.length||!body.data)throw new Error(`Wallet operation failed (HTTP ${r.status}); inspect privately; do not blindly retry a mutation`);
 return body.data;
}
const name=arg('name')??'zebscan-receiver-watch';
const accounts=(await gql<{accounts:Array<{id:number;name:string;birth:number}>}>('{ accounts { id name birth } }')).accounts;
let account=accounts.find(a=>a.name===name);
if(account){
 const current=(await gql<{unifiedFullViewingKey:string}>(`{ unifiedFullViewingKey(idAccount: ${account.id}) }`)).unifiedFullViewingKey;
 if(current!==backup.ufvk||account.birth!==backup.birth)throw new Error('Existing account differs from backup; refusing overwrite or deletion');
}else{
 const id=(await gql<{createAccount:number}>('mutation($n: NewAccount!) { createAccount(newAccount: $n) }',{n:{name,key:backup.ufvk,aindex:0,birth:backup.birth,useInternal:false}})).createAccount;
 account={id,name,birth:backup.birth};
}
console.log(JSON.stringify({network:'testnet',accountId:account.id,birthday:backup.birth,viewingKeyFingerprint:createHash('sha256').update(backup.ufvk).digest('hex'),custody:'UFVK import verified; host-level key isolation requires independent audit',next:'Issue a scoped viewer token separately; retain monitoring of every existing receiver.'}));
