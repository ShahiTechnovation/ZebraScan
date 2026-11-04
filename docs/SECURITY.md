# Security

## Isolation
* **Web**: no keys, seeds, RPC credentials or payout details; only masked VPAs, public addresses, quotes and status. Per-checkout bearer tokens (HMAC-signed, scoped to one checkout, generation-revocable) in localStorage; session is an HttpOnly cookie.
* **API**: never constructs a signer. Validates input and output against Zod contracts; 404 (not 403) on foreign resources.
* **Worker**: the only process that may build a Base signer — testnet key *file* (Base Sepolia only, permission-checked) or a remote isolated signer (mainnet). Guarded wallet: Diamond/USDC allowlist, zero value, chain check, explicit nonce, gas caps.
* **Zcash gateway**: UIVK only, mTLS with client-cert verification, no spend capability.

## Data protection
* Envelope encryption (AES-256-GCM DEK per value, KEK-wrapped, AAD bound to table:row:column) for payout VPAs, payer VPAs, refund addresses, TOTP secrets, emailed links. KEK rotation via `Envelope.rotate`.
* `LocalKeyProvider` is for demo/testnet only; mainnet needs a KMS `KeyProvider` (AWS KMS / GCP KMS / Vault Transit). `verify:prod-config` fails otherwise.
* Logs: Fastify redaction of cookies/auth/CSRF/signature headers; `redact()` strips VPAs, emails, Zcash addresses, 32-byte hex keys from audit details and errors.

## Authentication
Argon2id (m=64 MiB, t=3) with rehash-on-login; 12-char minimum; lockout after 10 failures (15 min); timing-equalised unknown-user path; non-enumerating reset; resets revoke all sessions and send a security notice; step-up (5 min) for payout destinations and withdrawals; per-session HMAC-derived CSRF token; SameSite=Lax (operator: Strict). Operator realm is separate, requires TOTP (interim — **passkeys required before mainnet**) and dual control for resume / exception decisions (approver ≠ requester, DB check constraint).

## Internal endpoints
mTLS at the internal ingress **and** `X-Zeb-Signature: t=…,v1=HMAC(t.rawBody)` with ±300 s tolerance; events deduplicated in `inbound_event_receipts`; P2P events are only wake-up hints — the worker re-reads the chain.

## Known gaps (must close before mainnet)
KMS adapter, passkeys, external pen-test/audit (**no audit has been performed — do not claim one**), WAF/bot challenge after suspicious auth activity (CAPTCHA not implemented), malware scanning for uploads (uploads are not accepted; logos are https URLs only), breach-password lookup.
