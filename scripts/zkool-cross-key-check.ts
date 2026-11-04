/** Isolation check: a token signed with one network's key must be refused by the other network's watcher. */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { signZkoolJwt } from "@zeb/providers";
const [from, url] = process.argv.slice(2);
const k = createPrivateKey(readFileSync(`var/secrets/zkool-${from}-jwt.key`, "utf8"));
const r = await fetch(url!, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signZkoolJwt(k, { sub: 0, write: true })}` }, body: JSON.stringify({ query: "{ accounts { id } }" }) });
const body = await r.text();
const refused = !body.includes('"accounts":[');
console.log(`${refused ? "PASS" : "FAIL"} ${from}-key token on ${url!.replace(/^https:\/\/([^.]+).*/, "$1")}: HTTP ${r.status} ${body.slice(0, 80)}`);
process.exit(refused ? 0 : 1);
