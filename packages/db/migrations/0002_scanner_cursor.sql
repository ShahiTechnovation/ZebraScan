-- Pull-mode scanner cursor (the gateway can also push via /api/v1/internal/zcash/events).
ALTER TABLE scanner_state ADD COLUMN deposit_cursor text;
ALTER TABLE scanner_state ADD COLUMN gateway_version text;
ALTER TABLE scanner_state ADD COLUMN nu7_active boolean NOT NULL DEFAULT false;
ALTER TABLE scanner_state ADD COLUMN last_error text;
