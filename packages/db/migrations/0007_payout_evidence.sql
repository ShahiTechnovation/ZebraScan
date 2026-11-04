-- Only the separately authenticated evidence-review process may populate this
-- append-only table. Browser runs never write it. No public write API is exposed.
CREATE TABLE payout_settlement_evidence (
  payout_id text PRIMARY KEY REFERENCES payout_commands(id),
  command_hash text NOT NULL,
  provider_order_id text NOT NULL CHECK (length(provider_order_id)>0),
  account_fingerprint text NOT NULL,
  recipient_hash text NOT NULL,
  inr_paise numeric(38,0) NOT NULL CHECK (inr_paise>0),
  actual_usdc_micros numeric(38,0) NOT NULL CHECK (actual_usdc_micros>=0),
  outcome text NOT NULL CHECK (outcome IN ('delivered','cancelled_no_debit')),
  debit_reference text NOT NULL CHECK (length(debit_reference)>0),
  bank_reference text NOT NULL CHECK (length(bank_reference)>0),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by text NOT NULL,
  second_reviewer text NOT NULL CHECK (second_reviewer <> reviewed_by),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome='delivered' AND actual_usdc_micros>0) OR (outcome='cancelled_no_debit' AND actual_usdc_micros=0))
);
CREATE TRIGGER payout_evidence_immutable BEFORE UPDATE OR DELETE ON payout_settlement_evidence FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
