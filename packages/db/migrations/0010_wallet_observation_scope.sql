-- A receiving account change is not a chain reorganisation. Retain ownership even
-- when an output has no invoice mapping; unknown historical ownership stays unknown.
ALTER TABLE deposit_observations ADD COLUMN wallet_id text;
UPDATE deposit_observations d SET wallet_id=za.wallet_id FROM zcash_addresses za WHERE za.id=d.zcash_address_id;
CREATE INDEX deposit_wallet_canonical ON deposit_observations(environment,network,wallet_id) WHERE canonical AND mined;
