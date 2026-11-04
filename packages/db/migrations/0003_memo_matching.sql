-- Memo-matched invoices (zkool_graphql watch-only account, per Free Society Hack testnet guidance):
-- several invoices may share one Ironwood receiving address; each carries a unique encrypted memo
-- code. Matching is by memo (inside the shielded note), never by amount.
ALTER TABLE zcash_addresses ADD COLUMN memo_code text;
ALTER TABLE zcash_addresses DROP CONSTRAINT zcash_addresses_environment_network_address_key;
CREATE UNIQUE INDEX zcash_addresses_address_unique ON zcash_addresses(environment, network, address) WHERE memo_code IS NULL;
CREATE UNIQUE INDEX zcash_addresses_memo_unique ON zcash_addresses(environment, network, memo_code) WHERE memo_code IS NOT NULL;
ALTER TABLE deposit_observations ADD COLUMN memo_matched boolean NOT NULL DEFAULT false;
