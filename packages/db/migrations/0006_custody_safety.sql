-- Keep every wallet-owned output, even when invoice attribution is unavailable.
ALTER TABLE deposit_observations ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE deposit_observations ALTER COLUMN zcash_address_id DROP NOT NULL;
ALTER TABLE deposit_observations ADD COLUMN observed_address text;
ALTER TABLE deposit_observations ADD COLUMN custody_revision integer NOT NULL DEFAULT 0;
ALTER TABLE deposit_observations ADD COLUMN custody_booked boolean NOT NULL DEFAULT false;
ALTER TABLE deposit_observations ADD CONSTRAINT deposit_attribution_pair CHECK ((intent_id IS NULL) = (zcash_address_id IS NULL));
ALTER TABLE exceptions ADD COLUMN deposit_id text REFERENCES deposit_observations(id);
DROP INDEX exceptions_dedupe;
CREATE UNIQUE INDEX exceptions_dedupe ON exceptions(environment, kind, coalesce(intent_id,''), coalesce(withdrawal_id,''), coalesce(order_id,''), coalesce(deposit_id,'')) WHERE status='open';

-- Historical TAZ reference amounts must not remain redeemable INR books. Preserve
-- original journals/receipts verbatim; append one balanced compensation per journal.
INSERT INTO ledger_journals(id, environment, event_id, kind, memo, effective_at, reversal_of)
SELECT 'testnet_reclass_' || j.id, j.environment, 'testnet_nonredeemable:' || j.id,
       'testnet_reference_reclassification', 'TAZ reference amount has no redeemable INR value', now(), j.id
FROM ledger_journals j
WHERE j.environment='testnet'
  AND EXISTS (SELECT 1 FROM ledger_postings p WHERE p.journal_id=j.id AND p.currency='INR')
  AND j.kind <> 'testnet_reference_reclassification'
  AND NOT EXISTS (SELECT 1 FROM ledger_journals r WHERE r.reversal_of=j.id AND r.kind='testnet_reference_reclassification')
ON CONFLICT (environment, event_id) DO NOTHING;
INSERT INTO ledger_postings(id, journal_id, account_id, currency, debit_minor, credit_minor, merchant_id)
SELECT 'testnet_reclass_' || p.id, r.id, p.account_id, p.currency, p.credit_minor, p.debit_minor, p.merchant_id
FROM ledger_journals r JOIN ledger_postings p ON p.journal_id=r.reversal_of
WHERE r.environment='testnet' AND r.kind='testnet_reference_reclassification'
ON CONFLICT (id) DO NOTHING;
UPDATE merchant_credits SET status='frozen', version=version+1, updated_at=now()
WHERE environment='testnet' AND status IN ('credit_prepared','credit_locked','credit_available');

-- Hard financial boundary, in addition to service-layer guards.
CREATE FUNCTION testnet_no_inr_postings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency='INR' AND EXISTS (
    SELECT 1 FROM ledger_journals j WHERE j.id=NEW.journal_id AND j.environment='testnet'
      AND j.kind <> 'testnet_reference_reclassification'
  ) THEN RAISE EXCEPTION 'testnet cannot create INR postings' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER testnet_no_inr_postings BEFORE INSERT ON ledger_postings FOR EACH ROW EXECUTE FUNCTION testnet_no_inr_postings();
