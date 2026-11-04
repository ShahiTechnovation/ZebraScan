-- TinyFish P2P web-automation payouts (P2P_TINYFISH_WEB) + Noir wallet login + email OTP.

-- ------------------------------------------------------------------ capability (read-only preflight)
CREATE TABLE p2p_capability_reports (
  id                    text PRIMARY KEY,
  environment           zeb_environment NOT NULL,
  account_fingerprint   text,
  run_id                text,
  status                text NOT NULL CHECK (status IN ('PASS', 'BLOCKED')),
  reasons               text[] NOT NULL DEFAULT '{}',
  observation           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- redacted
  observed_url          text,
  visible_usdc_micros   numeric(38,0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL
);
CREATE INDEX p2p_capability_recent ON p2p_capability_reports(environment, created_at DESC);

-- ------------------------------------------------------------------ payer consent (immutable snapshot)
CREATE TABLE payout_authorizations (
  id               text PRIMARY KEY,
  environment      zeb_environment NOT NULL,
  intent_id        text REFERENCES payment_intents(id),
  withdrawal_id    text REFERENCES withdrawals(id),
  terms            jsonb NOT NULL,        -- masked recipient, INR, quote id, fee, policy text versions
  terms_hash       text NOT NULL,
  actor            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payout_authorizations_immutable BEFORE UPDATE OR DELETE ON payout_authorizations FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- ------------------------------------------------------------------ payout commands
CREATE TABLE payout_commands (
  id                        text PRIMARY KEY,           -- payoutId (idempotency key)
  environment               zeb_environment NOT NULL,
  rail                      text NOT NULL DEFAULT 'P2P_TINYFISH_WEB' CHECK (rail IN ('P2P_TINYFISH_WEB')),
  flow                      text NOT NULL CHECK (flow IN ('SCAN_PAY', 'MERCHANT_WITHDRAWAL')),
  mode                      text NOT NULL CHECK (mode IN ('READ_ONLY', 'PREPARE_ONLY', 'EXECUTE_AFTER_APPROVAL')),
  recipient_vpa_ct          text NOT NULL,
  recipient_vpa_masked      text NOT NULL,
  requested_inr_paise       numeric(38,0) NOT NULL CHECK (requested_inr_paise > 0),
  max_usdc_debit_micros     numeric(38,0) NOT NULL CHECK (max_usdc_debit_micros > 0),
  max_fiat_variance_paise   numeric(38,0) NOT NULL DEFAULT 0 CHECK (max_fiat_variance_paise >= 0),
  quote_id                  text,
  source_intent_id          text REFERENCES payment_intents(id),
  withdrawal_id             text REFERENCES withdrawals(id),
  authorization_id          text NOT NULL REFERENCES payout_authorizations(id),
  reserved_treasury_id      text,
  command_hash              text NOT NULL,
  state                     text NOT NULL DEFAULT 'CREATED',
  state_reason              text,
  state_version             integer NOT NULL DEFAULT 1,
  account_fingerprint       text,
  approved_by               text,
  approved_at               timestamptz,
  approval_expires_at       timestamptz,
  held                      boolean NOT NULL DEFAULT false,
  hold_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_intent_id),
  UNIQUE (withdrawal_id),
  CHECK ((flow = 'SCAN_PAY' AND source_intent_id IS NOT NULL) OR (flow = 'MERCHANT_WITHDRAWAL' AND withdrawal_id IS NOT NULL))
);
CREATE INDEX payout_commands_active ON payout_commands(environment, state) WHERE state NOT IN ('RECONCILED', 'REFUNDED');

-- Authorized terms are immutable: any change requires a NEW command and a NEW authorization.
CREATE FUNCTION payout_commands_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payout commands cannot be deleted' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.recipient_vpa_ct <> OLD.recipient_vpa_ct OR NEW.requested_inr_paise <> OLD.requested_inr_paise
     OR NEW.max_usdc_debit_micros <> OLD.max_usdc_debit_micros OR NEW.max_fiat_variance_paise <> OLD.max_fiat_variance_paise
     OR NEW.command_hash <> OLD.command_hash OR NEW.flow <> OLD.flow OR NEW.authorization_id <> OLD.authorization_id
     OR NEW.environment <> OLD.environment OR NEW.mode <> OLD.mode THEN
    RAISE EXCEPTION 'authorized payout terms are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_commands_immutable BEFORE UPDATE OR DELETE ON payout_commands FOR EACH ROW EXECUTE FUNCTION payout_commands_guard();

CREATE TABLE payout_attempts (
  id               text PRIMARY KEY,
  payout_id        text NOT NULL REFERENCES payout_commands(id),
  kind             text NOT NULL CHECK (kind IN ('preflight', 'execute', 'reconcile')),
  command_hash     text NOT NULL,
  run_id           text UNIQUE,
  status           text NOT NULL DEFAULT 'persisted' CHECK (status IN ('persisted', 'queued', 'running', 'completed', 'failed', 'queue_rejected', 'queue_error')),
  observation      jsonb,
  outcome          text,
  fencing_token    bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- One payout ↔ at most ONE live provider debit attempt, across workers and restarts. Only an
-- operator-verified "never submitted" (or API-rejected) attempt frees the slot.
CREATE UNIQUE INDEX payout_attempts_one_execute ON payout_attempts(payout_id)
  WHERE kind = 'execute' AND outcome IS DISTINCT FROM 'verified_not_submitted' AND outcome IS DISTINCT FROM 'queue_rejected';

CREATE TABLE provider_orders (
  payout_id               text PRIMARY KEY REFERENCES payout_commands(id),
  provider_order_id       text NOT NULL,
  provider_status         text NOT NULL,
  visible_recipient_masked text,
  visible_inr_paise       numeric(38,0),
  visible_usdc_micros     numeric(38,0),
  provider_reference      text,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  verified_at             timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_orders_unique ON provider_orders(provider_order_id);

-- Serialize money-changing runs per operational P2P account (fencing token increases monotonically).
CREATE TABLE p2p_account_leases (
  environment         zeb_environment NOT NULL,
  account_fingerprint text NOT NULL,
  payout_id           text,
  fencing_token       bigint NOT NULL DEFAULT 0,
  expires_at          timestamptz,
  PRIMARY KEY (environment, account_fingerprint)
);

-- ------------------------------------------------------------------ wallet login + email OTP
CREATE TABLE login_challenges (
  id           text PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  nonce_hash   text NOT NULL UNIQUE,
  message      text NOT NULL,
  origin       text NOT NULL,
  network      text NOT NULL,
  action       text NOT NULL CHECK (action IN ('login', 'link_wallet')),
  user_id      text REFERENCES users(id),   -- set for link_wallet
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_identities (
  id                     text PRIMARY KEY,
  environment            zeb_environment NOT NULL,
  user_id                text NOT NULL REFERENCES users(id),
  provider               text NOT NULL CHECK (provider IN ('noir')),
  network                text NOT NULL,
  identity_fingerprint   text NOT NULL,       -- HMAC of derived pubkey; the address itself is not stored
  signing_mode           text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  UNIQUE (environment, provider, network, identity_fingerprint)
);

ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (purpose IN ('verify_email', 'reset_password', 'login_otp'));
ALTER TABLE auth_tokens ADD COLUMN attempts integer NOT NULL DEFAULT 0;
-- Wallet-only users have no password; password login is refused for them.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
