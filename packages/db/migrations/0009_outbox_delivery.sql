ALTER TABLE outbox_events ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN delivery_lease text;
ALTER TABLE outbox_events ADD COLUMN lease_until timestamptz;
ALTER TABLE outbox_events ADD COLUMN delivery_error text;
