-- Automatic payouts through a top-up provider.

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS payout_rail text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS payout_request_id text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS payout_next_attempt_at timestamptz;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS payout_last_error text;
CREATE INDEX IF NOT EXISTS transfers_payout_request_idx ON transfers (payout_request_id) WHERE payout_request_id IS NOT NULL;

-- Money we hold with the provider, in naira, and the commission they pay
-- us on each purchase. Both are ours; neither is airtime on a SIM.
INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('wallet:vtpass', 'asset', 'Money in our VTpass wallet'),
  ('revenue:provider_commission', 'revenue', 'Commission the provider pays us on each purchase')
ON CONFLICT (code) DO NOTHING;
