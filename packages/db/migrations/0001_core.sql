-- Zeb Scan core schema. PostgreSQL 16+.
-- Conventions: every economically relevant row carries `environment`; money is NUMERIC(38,0)
-- integer minor units (paise / zatoshis / USDC micros); timestamps are timestamptz (UTC).

CREATE TYPE zeb_environment AS ENUM ('demo', 'testnet', 'mainnet-readonly', 'mainnet-enabled');

-- ------------------------------------------------------------------ identity & auth
CREATE TABLE users (
  id                 text PRIMARY KEY,
  environment        zeb_environment NOT NULL,
  email              text NOT NULL,
  email_normalized   text NOT NULL,
  email_verified_at  timestamptz,
  password_hash      text NOT NULL,
  realm              text NOT NULL DEFAULT 'merchant' CHECK (realm IN ('merchant', 'operator')),
  totp_secret_ct     text,               -- envelope-encrypted; operator realm MFA
  failed_logins      integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, realm, email_normalized)
);

CREATE TABLE sessions (
  id            text PRIMARY KEY,
  environment   zeb_environment NOT NULL,
  user_id       text NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,
  csrf_hash     text NOT NULL,
  realm         text NOT NULL CHECK (realm IN ('merchant', 'operator')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  step_up_at    timestamptz,
  mfa_at        timestamptz,
  revoked_at    timestamptz,
  ip_hash       text,
  user_agent    text
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id          text PRIMARY KEY,
  environment zeb_environment NOT NULL,
  user_id     text NOT NULL REFERENCES users(id),
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operator_roles (
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('operator', 'risk_reviewer', 'treasury_approver', 'auditor')),
  granted_by  text,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Outbound email (verification, reset, security notices). Delivered by the worker via the
-- configured provider; while no provider is configured the row stays 'undeliverable'.
CREATE TABLE email_outbox (
  id           bigserial PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  to_hash      text NOT NULL,
  to_ct        text NOT NULL,           -- envelope-encrypted address
  template     text NOT NULL,
  params_ct    text NOT NULL,           -- envelope-encrypted params (may contain one-time links)
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sent', 'undeliverable', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);

-- ------------------------------------------------------------------ merchants
CREATE TABLE merchants (
  id                     text PRIMARY KEY,
  environment            zeb_environment NOT NULL,
  handle                 text NOT NULL,
  display_name           text NOT NULL,
  legal_name             text,
  business_type          text,
  category               text NOT NULL DEFAULT 'other',
  country                text NOT NULL DEFAULT 'IN',
  contact_email          text,
  status                 text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'pending_review', 'verified', 'restricted', 'suspended', 'closed')),
  kyb_provider           text,
  kyb_reference          text,
  kyb_details_ct         text,          -- envelope-encrypted KYB payload (fields decided by counsel)
  risk_flags             text[] NOT NULL DEFAULT '{}',
  logo_url               text,
  preferences            jsonb NOT NULL DEFAULT '{}'::jsonb,
  counter_slug           text NOT NULL,
  retired_counter_slugs  text[] NOT NULL DEFAULT '{}',
  receiving_enabled      boolean NOT NULL DEFAULT true,
  created_by             text NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1,
  UNIQUE (environment, handle),
  UNIQUE (environment, counter_slug)
);

CREATE TABLE merchant_members (
  id          text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner', 'finance', 'viewer', 'support')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  UNIQUE (merchant_id, user_id)
);

CREATE TABLE payout_destinations (
  id               text PRIMARY KEY,
  environment      zeb_environment NOT NULL,
  merchant_id      text NOT NULL REFERENCES merchants(id),
  kind             text NOT NULL DEFAULT 'upi_vpa' CHECK (kind IN ('upi_vpa')),
  vpa_ct           text NOT NULL,       -- envelope-encrypted, AAD bound to row id
  vpa_masked       text NOT NULL,
  vpa_fingerprint  text NOT NULL,       -- HMAC for duplicate detection without plaintext
  beneficiary_name text,
  status           text NOT NULL DEFAULT 'pending_verification'
                     CHECK (status IN ('pending_verification', 'cooling_off', 'verified', 'rejected', 'removed')),
  usable_after     timestamptz,
  verified_at      timestamptz,
  verified_by      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX payout_destinations_one_active ON payout_destinations(merchant_id)
  WHERE status IN ('pending_verification', 'cooling_off', 'verified');

-- ------------------------------------------------------------------ payment links
CREATE TABLE payment_links (
  id               text PRIMARY KEY,
  environment      zeb_environment NOT NULL,
  merchant_id      text NOT NULL REFERENCES merchants(id),
  slug             text NOT NULL,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  reference        text NOT NULL DEFAULT '',
  amount_mode      text NOT NULL CHECK (amount_mode IN ('fixed', 'variable')),
  fixed_inr_paise  numeric(38,0) CHECK (fixed_inr_paise IS NULL OR fixed_inr_paise > 0),
  min_inr_paise    numeric(38,0),
  max_inr_paise    numeric(38,0),
  reusable         boolean NOT NULL DEFAULT true,
  use_limit        integer CHECK (use_limit IS NULL OR use_limit > 0),
  successful_uses  integer NOT NULL DEFAULT 0,
  expires_at       timestamptz,
  allow_note       boolean NOT NULL DEFAULT false,
  revoked_at       timestamptz,
  duplicated_from  text REFERENCES payment_links(id),
  views            bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (environment, slug),
  CHECK ((amount_mode = 'fixed' AND fixed_inr_paise IS NOT NULL) OR (amount_mode = 'variable' AND fixed_inr_paise IS NULL)),
  CHECK (min_inr_paise IS NULL OR max_inr_paise IS NULL OR min_inr_paise <= max_inr_paise)
);

-- ------------------------------------------------------------------ rates & quotes
CREATE TABLE rate_snapshots (
  id           text PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('zec_usd', 'p2p_price', 'p2p_fee')),
  source       text NOT NULL,
  value        text NOT NULL,          -- exact decimal / integer string
  payload      jsonb NOT NULL,
  observed_at  timestamptz NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  payload_hash text NOT NULL
);
CREATE INDEX rate_snapshots_recent ON rate_snapshots(environment, kind, fetched_at DESC);

CREATE TABLE quotes (
  id                         text PRIMARY KEY,
  environment                zeb_environment NOT NULL,
  payment_mode               text NOT NULL CHECK (payment_mode IN ('scan_pay', 'terminal', 'counter_qr', 'payment_link', 'withdrawal')),
  privacy_mode               text NOT NULL CHECK (privacy_mode IN ('shielded', 'transparent')),
  inr_paise                  numeric(38,0) NOT NULL CHECK (inr_paise > 0),
  zec_zatoshis               numeric(38,0) NOT NULL CHECK (zec_zatoshis >= 0),
  required_usdc_micros       numeric(38,0) NOT NULL CHECK (required_usdc_micros >= 0),
  platform_fee_inr_paise     numeric(38,0) NOT NULL,
  p2p_fee_usdc_micros        numeric(38,0) NOT NULL,
  p2p_fee_inr_paise          numeric(38,0) NOT NULL,
  zec_usd_rate               text NOT NULL,
  inr_per_usdc_rate6         numeric(38,0) NOT NULL,
  price_source               text NOT NULL,
  p2p_source                 text NOT NULL,
  formula_version            text NOT NULL,
  policy                     jsonb NOT NULL,
  breakdown                  jsonb NOT NULL,
  inputs_hash                text NOT NULL,  -- sha256 over canonical inputs; validated at financial transitions
  rate_snapshot_ids          text[] NOT NULL,
  observed_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  expires_at                 timestamptz NOT NULL,
  funding_deadline           timestamptz NOT NULL,
  finality_deadline          timestamptz NOT NULL,
  payment_eligible           boolean NOT NULL,
  disabled_reason            text,
  execution_not_guaranteed   boolean NOT NULL DEFAULT true,
  consumed_by                text UNIQUE,   -- intent id; a quote backs at most one intent
  CHECK (funding_deadline <= finality_deadline)
);
-- Quotes are immutable once written (except the one-time consumed_by binding).
CREATE FUNCTION quotes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consumed_by IS DISTINCT FROM OLD.consumed_by AND OLD.consumed_by IS NULL THEN
    IF (to_jsonb(NEW) - 'consumed_by') = (to_jsonb(OLD) - 'consumed_by') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'quotes are immutable' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER quotes_no_update BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_immutable();
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION quotes_immutable();

-- ------------------------------------------------------------------ zcash receiving
CREATE TABLE address_allocation_cursor (
  environment  zeb_environment NOT NULL,
  network      text NOT NULL,
  account_id   text NOT NULL,
  next_index   numeric(38,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (environment, network, account_id)
);

CREATE TABLE zcash_addresses (
  id                 text PRIMARY KEY,
  environment        zeb_environment NOT NULL,
  network            text NOT NULL,
  account_id         text NOT NULL,
  diversifier_index  numeric(38,0) NOT NULL,
  address            text NOT NULL,
  address_type       text NOT NULL CHECK (address_type IN ('unified', 'sapling', 'transparent', 'demo')),
  receivers          text[] NOT NULL,
  birthday_height    bigint,
  intent_id          text NOT NULL UNIQUE,
  wallet_id          text NOT NULL,
  allocated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, network, address),
  UNIQUE (environment, network, account_id, diversifier_index)
);

-- ------------------------------------------------------------------ payment intents
CREATE TABLE payment_intents (
  id                           text PRIMARY KEY,
  environment                  zeb_environment NOT NULL,
  mode                         text NOT NULL CHECK (mode IN ('scan_pay', 'terminal', 'counter_qr', 'payment_link')),
  merchant_id                  text REFERENCES merchants(id),
  link_id                      text REFERENCES payment_links(id),
  quote_id                     text NOT NULL UNIQUE REFERENCES quotes(id),
  status                       text NOT NULL,
  payout_status                text NOT NULL DEFAULT 'not_started',
  privacy_mode                 text NOT NULL CHECK (privacy_mode IN ('shielded', 'transparent')),
  refund_preference            text NOT NULL DEFAULT 'manual_review' CHECK (refund_preference IN ('manual_review', 'return_address')),
  refund_address_ct            text,
  zcash_address_id             text UNIQUE REFERENCES zcash_addresses(id),
  recipient_vpa_ct             text,
  recipient_vpa_masked         text,
  recipient_payee_name         text,
  recipient_source             text,
  customer_note                text NOT NULL DEFAULT '',
  access_subject               text NOT NULL,           -- anonymous session id or user id
  access_generation            integer NOT NULL DEFAULT 1,
  expires_at                   timestamptz NOT NULL,
  deposit_submission_deadline  timestamptz NOT NULL,
  finality_deadline            timestamptz NOT NULL,
  received_zatoshis            numeric(38,0) NOT NULL DEFAULT 0,
  accepted_at                  timestamptz,
  exception_reason             text,
  risk_decision_id             text,
  receipt_id                   text,
  refreshed_from               text REFERENCES payment_intents(id),
  refreshed_to                 text REFERENCES payment_intents(id),
  status_version               integer NOT NULL DEFAULT 1,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (mode <> 'scan_pay' OR (recipient_vpa_ct IS NOT NULL AND merchant_id IS NULL)),
  CHECK (mode = 'scan_pay' OR merchant_id IS NOT NULL),
  CHECK (mode <> 'payment_link' OR link_id IS NOT NULL)
);
CREATE INDEX payment_intents_merchant ON payment_intents(merchant_id, created_at DESC);
CREATE INDEX payment_intents_open ON payment_intents(environment, status) WHERE status IN ('awaiting_zec', 'deposit_seen', 'confirming');

CREATE TABLE deposit_observations (
  id                text PRIMARY KEY,
  environment       zeb_environment NOT NULL,
  network           text NOT NULL,
  pool              text NOT NULL CHECK (pool IN ('orchard', 'sapling', 'transparent', 'ironwood', 'demo')),
  txid              text NOT NULL,
  output_ref        text NOT NULL,     -- stable wallet-provided output/note identity
  value_zatoshis    numeric(38,0) NOT NULL CHECK (value_zatoshis > 0),
  zcash_address_id  text NOT NULL REFERENCES zcash_addresses(id),
  intent_id         text NOT NULL REFERENCES payment_intents(id),
  block_height      bigint,
  block_hash        text,
  mined             boolean NOT NULL DEFAULT false,
  confirmations     integer NOT NULL DEFAULT 0,
  canonical         boolean NOT NULL DEFAULT true,
  accepted          boolean NOT NULL DEFAULT false,
  scan_version      text NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  reorged_at        timestamptz,
  UNIQUE (environment, network, pool, txid, output_ref)
);
CREATE INDEX deposit_observations_intent ON deposit_observations(intent_id);

CREATE TABLE scanner_state (
  environment          zeb_environment NOT NULL,
  network              text NOT NULL,
  tip_height           bigint,
  tip_hash             text,
  scanned_height       bigint,
  tip_observed_at      timestamptz,
  consensus_branch     text,
  ironwood_supported   boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'unknown',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, network)
);

-- Inbound internal/external event dedupe (scanner events, P2P events, webhooks).
CREATE TABLE inbound_event_receipts (
  source       text NOT NULL,
  event_id     text NOT NULL,
  environment  zeb_environment NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload_hash text NOT NULL,
  PRIMARY KEY (source, event_id)
);

-- ------------------------------------------------------------------ P2P orders (PAY / SELL)
CREATE TABLE p2p_orders (
  id                   text PRIMARY KEY,
  environment          zeb_environment NOT NULL,
  purpose              text NOT NULL CHECK (purpose IN ('scan_pay', 'withdrawal')),
  intent_id            text REFERENCES payment_intents(id),
  withdrawal_id        text,
  attempt              integer NOT NULL DEFAULT 1,
  order_type_code      smallint NOT NULL CHECK (order_type_code IN (1, 2)),
  chain_id             integer NOT NULL,
  diamond_address      text NOT NULL,
  usdc_address         text NOT NULL,
  onchain_order_id     numeric(78,0),
  status               text NOT NULL,
  fiat_amount6         numeric(38,0) NOT NULL,
  usdc_amount_micros   numeric(38,0) NOT NULL,
  actual_usdc_micros   numeric(38,0),
  fixed_fee_paid       numeric(38,0),
  approved_micros      numeric(38,0),
  accepted_merchant    text,
  circle_id            numeric(78,0),
  place_tx_hash        text,
  approve_tx_hash      text,
  set_upi_tx_hash      text,
  submit_nonce         bigint,
  relay_identity_ct    text,
  recipient_vpa_ct     text NOT NULL,
  last_onchain         jsonb,
  last_read_at         timestamptz,
  provider_proof       jsonb,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1,
  CHECK ((purpose = 'scan_pay' AND intent_id IS NOT NULL AND order_type_code = 2)
      OR (purpose = 'withdrawal' AND withdrawal_id IS NOT NULL AND order_type_code = 1))
);
CREATE UNIQUE INDEX p2p_orders_intent_attempt ON p2p_orders(intent_id, attempt) WHERE intent_id IS NOT NULL;
CREATE UNIQUE INDEX p2p_orders_withdrawal_attempt ON p2p_orders(withdrawal_id, attempt) WHERE withdrawal_id IS NOT NULL;
CREATE UNIQUE INDEX p2p_orders_onchain ON p2p_orders(environment, chain_id, diamond_address, onchain_order_id) WHERE onchain_order_id IS NOT NULL;

-- ------------------------------------------------------------------ merchant credits & withdrawals
CREATE TABLE withdrawals (
  id                     text PRIMARY KEY,
  environment            zeb_environment NOT NULL,
  merchant_id            text NOT NULL REFERENCES merchants(id),
  payout_destination_id  text NOT NULL REFERENCES payout_destinations(id),
  inr_paise              numeric(38,0) NOT NULL CHECK (inr_paise > 0),
  fee_inr_paise          numeric(38,0) NOT NULL CHECK (fee_inr_paise >= 0),
  payout_inr_paise       numeric(38,0) NOT NULL CHECK (payout_inr_paise > 0),
  required_usdc_micros   numeric(38,0) NOT NULL,
  quote_snapshot         jsonb NOT NULL,
  status                 text NOT NULL,
  requested_by           text NOT NULL REFERENCES users(id),
  step_up_at             timestamptz NOT NULL,
  failure_reason         text,
  recovered_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1,
  CHECK (payout_inr_paise + fee_inr_paise = inr_paise)
);
CREATE UNIQUE INDEX withdrawals_one_active ON withdrawals(merchant_id)
  WHERE status NOT IN ('completed', 'cancelled');
ALTER TABLE p2p_orders ADD CONSTRAINT p2p_orders_withdrawal_fk FOREIGN KEY (withdrawal_id) REFERENCES withdrawals(id);

CREATE TABLE merchant_credits (
  id                     text PRIMARY KEY,
  environment            zeb_environment NOT NULL,
  merchant_id            text NOT NULL REFERENCES merchants(id),
  intent_id              text REFERENCES payment_intents(id),
  deposit_id             text REFERENCES deposit_observations(id),
  amount_inr_paise       numeric(38,0) NOT NULL CHECK (amount_inr_paise > 0),
  backing_allocation_id  text,
  status                 text NOT NULL,
  policy_version         text NOT NULL,
  locked_at              timestamptz,
  unlocks_at             timestamptz,
  available_at           timestamptz,
  withdrawal_id          text REFERENCES withdrawals(id),
  parent_credit_id       text REFERENCES merchant_credits(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer NOT NULL DEFAULT 1
);
-- One original credit per accepted intent (splits reference a parent and carry no intent).
CREATE UNIQUE INDEX merchant_credits_one_per_intent ON merchant_credits(intent_id) WHERE parent_credit_id IS NULL;
CREATE INDEX merchant_credits_unlock ON merchant_credits(environment, unlocks_at) WHERE status = 'credit_locked';
-- unlocks_at may only move later, never earlier, without going through ops approval (enforced in trigger).
CREATE FUNCTION credits_unlock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unlocks_at IS NOT NULL AND NEW.unlocks_at < OLD.unlocks_at
     AND current_setting('zeb.approved_acceleration', true) IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'credit unlock may not be accelerated without approval' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.amount_inr_paise <> OLD.amount_inr_paise OR NEW.merchant_id <> OLD.merchant_id THEN
    RAISE EXCEPTION 'credit amount/merchant are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credits_guard BEFORE UPDATE ON merchant_credits FOR EACH ROW EXECUTE FUNCTION credits_unlock_guard();

-- ------------------------------------------------------------------ double-entry ledger
CREATE TABLE ledger_accounts (
  id           text PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  code         text NOT NULL,
  currency     text NOT NULL CHECK (currency IN ('INR', 'ZEC', 'USDC_BASE')),
  merchant_id  text REFERENCES merchants(id),
  normal_side  text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_accounts_key ON ledger_accounts(environment, code, currency, coalesce(merchant_id, ''));

CREATE TABLE ledger_journals (
  id                    text PRIMARY KEY,
  environment           zeb_environment NOT NULL,
  event_id              text NOT NULL,
  kind                  text NOT NULL,
  memo                  text NOT NULL DEFAULT '',
  effective_at          timestamptz NOT NULL,
  reversal_of           text REFERENCES ledger_journals(id),
  operator_approval_id  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, event_id)
);

CREATE TABLE ledger_postings (
  id            text PRIMARY KEY,
  journal_id    text NOT NULL REFERENCES ledger_journals(id),
  account_id    text NOT NULL REFERENCES ledger_accounts(id),
  currency      text NOT NULL CHECK (currency IN ('INR', 'ZEC', 'USDC_BASE')),
  debit_minor   numeric(38,0) NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor  numeric(38,0) NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  merchant_id   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
CREATE INDEX ledger_postings_account ON ledger_postings(account_id);
CREATE INDEX ledger_postings_journal ON ledger_postings(journal_id);
CREATE INDEX ledger_postings_merchant ON ledger_postings(merchant_id, created_at) WHERE merchant_id IS NOT NULL;

-- Append-only enforcement.
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only; post a compensating journal instead' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER ledger_journals_immutable BEFORE UPDATE OR DELETE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_postings_immutable BEFORE UPDATE OR DELETE ON ledger_postings FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Posting currency must match its account's currency.
CREATE FUNCTION ledger_posting_currency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acct_currency text;
BEGIN
  SELECT currency INTO acct_currency FROM ledger_accounts WHERE id = NEW.account_id;
  IF acct_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'posting currency % does not match account currency %', NEW.currency, acct_currency USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_postings_currency BEFORE INSERT ON ledger_postings FOR EACH ROW EXECUTE FUNCTION ledger_posting_currency();

-- Balanced per journal per currency, checked at COMMIT (deferred) so multi-row inserts work.
CREATE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(debit_minor) AS d, sum(credit_minor) AS c INTO bad
    FROM ledger_postings WHERE journal_id = NEW.journal_id
    GROUP BY currency HAVING sum(debit_minor) <> sum(credit_minor) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % unbalanced in %: debit % credit %', NEW.journal_id, bad.currency, bad.d, bad.c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

-- A journal must not be empty (checked at commit).
CREATE FUNCTION ledger_journal_nonempty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_postings WHERE journal_id = NEW.id) THEN
    RAISE EXCEPTION 'journal % has no postings', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_journals_nonempty AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_nonempty();

-- ------------------------------------------------------------------ treasury
CREATE TABLE treasury_allocations (
  id             text PRIMARY KEY,
  environment    zeb_environment NOT NULL,
  asset          text NOT NULL DEFAULT 'USDC_BASE' CHECK (asset IN ('USDC_BASE')),
  purpose        text NOT NULL CHECK (purpose IN ('quote_hold', 'deposit_hold', 'merchant_credit_backing', 'direct_payout', 'withdrawal', 'refund', 'risk_buffer')),
  obligation_id  text NOT NULL,          -- intent / credit / withdrawal id
  amount_micros  numeric(38,0) NOT NULL CHECK (amount_micros > 0),
  state          text NOT NULL CHECK (state IN ('held', 'in_flight', 'consumed', 'released')),
  converted_to   text REFERENCES treasury_allocations(id),
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1
);
-- One active allocation per economic obligation: never reserve the same obligation twice.
CREATE UNIQUE INDEX treasury_allocations_one_active ON treasury_allocations(environment, obligation_id)
  WHERE state IN ('held', 'in_flight');

CREATE TABLE treasury_inventory (
  id            bigserial PRIMARY KEY,
  environment   zeb_environment NOT NULL,
  asset         text NOT NULL CHECK (asset IN ('USDC_BASE', 'ZEC', 'ETH_BASE_GAS')),
  amount_minor  numeric(38,0) NOT NULL,
  source        text NOT NULL,           -- 'base_rpc:balanceOf', 'zcash_gateway:wallet_summary', ...
  block_ref     text,
  observed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX treasury_inventory_recent ON treasury_inventory(environment, asset, observed_at DESC);

-- ------------------------------------------------------------------ receipts / support / exceptions
CREATE TABLE receipts (
  id               text PRIMARY KEY,
  environment      zeb_environment NOT NULL,
  intent_id        text REFERENCES payment_intents(id),
  withdrawal_id    text REFERENCES withdrawals(id),
  merchant_id      text REFERENCES merchants(id),
  kind             text NOT NULL CHECK (kind IN ('payment', 'withdrawal')),
  payload          jsonb NOT NULL,       -- immutable historical display amounts
  validation_hash  text NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id),
  UNIQUE (withdrawal_id)
);
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE TABLE support_cases (
  id              text PRIMARY KEY,
  environment     zeb_environment NOT NULL,
  merchant_id     text REFERENCES merchants(id),
  intent_id       text REFERENCES payment_intents(id),
  withdrawal_id   text REFERENCES withdrawals(id),
  opened_by_type  text NOT NULL CHECK (opened_by_type IN ('merchant_user', 'payer_session', 'operator')),
  opened_by       text NOT NULL,
  category        text NOT NULL CHECK (category IN ('refund', 'dispute', 'payout_delay', 'deposit_issue', 'other')),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exceptions (
  id             text PRIMARY KEY,
  environment    zeb_environment NOT NULL,
  kind           text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('info', 'warning', 'urgent')),
  intent_id      text REFERENCES payment_intents(id),
  withdrawal_id  text REFERENCES withdrawals(id),
  order_id       text REFERENCES p2p_orders(id),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided', 'closed')),
  decision       text,
  decided_by     text,
  approval_id    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
CREATE UNIQUE INDEX exceptions_dedupe ON exceptions(environment, kind, coalesce(intent_id, ''), coalesce(withdrawal_id, ''), coalesce(order_id, ''))
  WHERE status = 'open';

-- ------------------------------------------------------------------ ops: gates, dual control, audit
CREATE TABLE feature_gates (
  environment  zeb_environment NOT NULL,
  feature      text NOT NULL,
  enabled      boolean NOT NULL,
  reason       text NOT NULL,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, feature)
);

CREATE TABLE ops_approvals (
  id             text PRIMARY KEY,
  environment    zeb_environment NOT NULL,
  action         text NOT NULL,
  target         text NOT NULL,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  requested_by   text NOT NULL REFERENCES users(id),
  approved_by    text REFERENCES users(id),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  expires_at     timestamptz NOT NULL,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  actor_type   text NOT NULL,
  actor_id     text,
  action       text NOT NULL,
  target       text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id   text,
  ip_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- ------------------------------------------------------------------ idempotency / outbox / events / jobs
CREATE TABLE idempotency_keys (
  environment      zeb_environment NOT NULL,
  principal        text NOT NULL,
  endpoint         text NOT NULL,
  idem_key         text NOT NULL,
  request_hash     text NOT NULL,
  state            text NOT NULL CHECK (state IN ('in_progress', 'done')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (environment, principal, endpoint, idem_key)
);

CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  environment     zeb_environment NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at   timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(id) WHERE dispatched_at IS NULL;

-- SSE stream source: monotonic id per environment; Last-Event-ID replays from here.
CREATE TABLE resource_events (
  id           bigserial PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  resource     text NOT NULL,        -- 'checkout:pi_…' | 'withdrawal:wd_…' | 'merchant:mer_…'
  event_type   text NOT NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_events_resource ON resource_events(resource, id);

CREATE TABLE jobs (
  id               text PRIMARY KEY,
  environment      zeb_environment NOT NULL,
  kind             text NOT NULL,
  dedupe_key       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'dead', 'paused')),
  run_at           timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 20,
  lease_owner      text,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_dedupe_active ON jobs(environment, kind, dedupe_key) WHERE state IN ('queued', 'running', 'failed', 'paused');
CREATE INDEX jobs_due ON jobs(environment, run_at) WHERE state IN ('queued', 'failed');

CREATE TABLE reconciliation_runs (
  id           text PRIMARY KEY,
  environment  zeb_environment NOT NULL,
  kind         text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           boolean,
  result       jsonb
);

-- P2P relay identities persisted (encrypted) so restarted jobs can continue an order.
CREATE TABLE p2p_relay_identities (
  environment  zeb_environment NOT NULL,
  scope        text NOT NULL,
  identity_ct  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, scope)
);
