-- P2P preparation (1-confirmation trigger). READ-ONLY provider preflight only: a row here never
-- commits funds, never places an order and never authorizes a payout. Execution still requires the
-- separate settlement threshold, operator approval and every gate in tfpayouts.executionBlockers.
CREATE TABLE payout_preparations (
  id text PRIMARY KEY,
  environment text NOT NULL,
  intent_id text NOT NULL REFERENCES payment_intents(id),
  deposit_id text NOT NULL REFERENCES deposit_observations(id),
  block_height bigint NOT NULL,
  block_hash text,
  confirmations integer NOT NULL,
  zec_zatoshis numeric(38,0) NOT NULL,
  inr_paise numeric(38,0) NOT NULL,
  max_usdc_debit_micros numeric(38,0) NOT NULL,
  vpa_masked text NOT NULL,
  terms_hash text NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','READY','BLOCKED','HELD','CANCELLED')),
  state_reason text,
  attempts integer NOT NULL DEFAULT 0,
  tinyfish_run_id text,
  -- No provider draft exists without committing funds; this stays NULL unless a provider officially supports non-binding drafts.
  provider_draft_ref text,
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_status text NOT NULL DEFAULT 'none',
  run_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, intent_id)
);
CREATE INDEX payout_preparations_state_idx ON payout_preparations(environment, state);
