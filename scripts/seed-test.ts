/**
 * TEST/DEMO-ONLY seed: a merchant account with one payment link. Refuses mainnet environments.
 * It never creates deposits, credits or ledger entries — those only come from real flows.
 */
import { createPool } from "@zeb/db";
import { newId, newSlug, parseEnvironment } from "@zeb/domain";
import { hashPassword } from "@zeb/security";

const env = parseEnvironment(process.env.ZEB_ENVIRONMENT);
if (env !== "demo" && env !== "testnet") throw new Error(`refusing to seed ${env}`);
const db = createPool(process.env.DATABASE_URL!, { max: 1 });
const userId = newId("user");
const merchantId = newId("merchant");
const email = process.env.SEED_EMAIL ?? `seed-${Date.now()}@example.test`;
const password = process.env.SEED_PASSWORD ?? `seed-${newSlug(12)}-${newSlug(8)}`;
await db.query(`INSERT INTO users(id, environment, email, email_normalized, email_verified_at, password_hash) VALUES ($1,$2,$3,$4,now(),$5)`, [userId, env, email, email, await hashPassword(password)]);
const handle = `test-shop-${newSlug(5)}`;
await db.query(`INSERT INTO merchants(id, environment, handle, display_name, category, counter_slug, preferences, created_by) VALUES ($1,$2,$3,'TEST Shop','retail',$4,'{}',$5)`, [merchantId, env, handle, `${handle}-${newSlug(6)}`, userId]);
await db.query(`INSERT INTO merchant_members(id, merchant_id, user_id, role) VALUES ($1,$2,$3,'owner')`, [newId("member"), merchantId, userId]);
const slug = newSlug(10);
await db.query(`INSERT INTO payment_links(id, environment, merchant_id, slug, title, amount_mode, fixed_inr_paise) VALUES ($1,$2,$3,$4,'TEST link','fixed',25000)`, [newId("link"), env, merchantId, slug]);
await db.end();
console.log(JSON.stringify({ environment: env, email, password, merchantId, handle, linkSlug: slug, note: "TEST data — not redeemable" }, null, 2));
