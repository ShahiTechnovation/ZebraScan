/** Prints fresh random secrets for a LOCAL .env (demo/testnet). Never use these for mainnet KMS. */
import { randomBytes } from "node:crypto";

console.log(`ZEB_TOKEN_SECRET=${randomBytes(32).toString("hex")}`);
console.log(`ZEB_LOCAL_KEKS=k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}:${randomBytes(32).toString("base64")}`);
console.log(`ZEB_ACTIVE_KEK=k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
console.log(`INTERNAL_HMAC_SECRET=${randomBytes(32).toString("hex")}`);
