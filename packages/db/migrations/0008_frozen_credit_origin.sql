-- Keep the liability bucket when freezing; one frozen credit cannot hide drift.
ALTER TABLE merchant_credits ADD COLUMN frozen_from_status text;
UPDATE merchant_credits SET frozen_from_status=CASE
  WHEN withdrawal_id IS NOT NULL THEN 'withdrawal_reserved'
  WHEN available_at IS NOT NULL THEN 'credit_available' ELSE 'credit_locked' END
WHERE status='frozen';
