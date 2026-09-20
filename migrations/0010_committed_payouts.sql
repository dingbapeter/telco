-- Airtime promised but not yet posted.
--
-- A payout leaves the pool at the moment the phone or the provider sends
-- it, but the ledger only learns of it when the send is confirmed, which
-- can be minutes later. Between those two moments the pool looks fuller
-- than it is, and ten payouts starting together each saw the whole balance
-- and all passed the check. Recording which account a payout is drawing on
-- lets the check subtract what is already on its way.

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS payout_funding_account text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_funding_account text;

CREATE INDEX IF NOT EXISTS transfers_committed_idx ON transfers (payout_funding_account) WHERE state = 'paying_out';
CREATE INDEX IF NOT EXISTS orders_committed_idx ON orders (delivery_funding_account) WHERE state = 'delivering';

-- One payment, one order. The same bank narration typed against two orders
-- would otherwise book the same money twice.
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_idx
  ON orders (payment_method, payment_reference)
  WHERE payment_reference IS NOT NULL;
