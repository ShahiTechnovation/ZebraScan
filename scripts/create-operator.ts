/**
 * Creates an operator-realm account with one role and a TOTP secret (printed ONCE as an otpauth
 * URI). Operators are a separate realm from merchants; dual-control actions need two of them.
 *   OPERATOR_EMAIL=… OPERATOR_PASSWORD=… OPERATOR_ROLE=operator pnpm exec tsx scripts/create-operator.ts
 */
import { createPool } from "@zeb/db";
import { newId, parseEnvironment } from "@zeb/domain";
import { Envelope, hashPassword, LocalKeyProvider, newTotpSecret, OPERATOR_ROLES, passwordProblem } from "@zeb/security";

const env = parseEnvironment(process.env.ZEB_ENVIRONMENT);
const email = process.env.OPERATOR_EMAIL?.trim();
const password = process.env.OPERATOR_PASSWORD ?? "";
const role = process.env.OPERATOR_ROLE ?? "operator";
if (!email || !(OPERATOR_ROLES as readonly string[]).includes(role)) throw new Error("OPERATOR_EMAIL and a valid OPERATOR_ROLE are required");
const problem = passwordProblem(password, email);
if (problem) throw new Error(problem);
const db = createPool(process.env.DATABASE_URL!, { max: 1 });
const envelope = new Envelope(LocalKeyProvider.fromEnv(process.env.ZEB_LOCAL_KEKS, process.env.ZEB_ACTIVE_KEK));
const id = newId("user");
const secret = newTotpSecret();
await db.query(`INSERT INTO users(id, environment, email, email_normalized, email_verified_at, password_hash, realm, totp_secret_ct) VALUES ($1,$2,$3,$4,now(),$5,'operator',$6)`, [
  id,
  env,
  email,
  email.toLowerCase(),
  await hashPassword(password),
  await envelope.seal(secret, `users:${id}:totp`),
]);
await db.query(`INSERT INTO operator_roles(user_id, role, granted_by) VALUES ($1,$2,'bootstrap-script')`, [id, role]);
await db.query(`INSERT INTO audit_log(environment, actor_type, action, target, details) VALUES ($1,'system','operator.create',$2,$3)`, [env, id, JSON.stringify({ role })]);
await db.end();
console.log(`operator ${id} (${role}) created in ${env}`);
console.log(`Enrol this TOTP secret now; it will not be shown again:\notpauth://totp/ZebScan:${encodeURIComponent(email)}?secret=${secret}&issuer=ZebScan`);
