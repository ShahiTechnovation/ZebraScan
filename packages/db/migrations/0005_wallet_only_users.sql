-- Wallet-only merchants (Noir sign-in) may exist without an email until they add one.
-- Payout features stay gated on a verified email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email_normalized DROP NOT NULL;
