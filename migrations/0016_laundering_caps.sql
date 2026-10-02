-- Caps that stop the service being used to wash money, and the value going
-- straight back when one is hit.
--
-- A cap that only refuses a quote is not a control: somebody can send
-- airtime to one of our SIMs without asking us first, and often does. So
-- what arrives over a cap is held, and where the founder has left the
-- switch on, sent back to the line it came from without anybody being
-- asked. Sending it back is the same rail a refund already uses, so a sale
-- needs the same two columns a transfer has: which rail is sending it and
-- the request id that stops it being sent twice.

ALTER TABLE sellbacks DROP CONSTRAINT IF EXISTS sellbacks_state_check;
ALTER TABLE sellbacks ADD CONSTRAINT sellbacks_state_check
  CHECK (state IN ('awaiting_inbound', 'expired', 'held', 'received', 'settled', 'paid', 'returning', 'returned', 'cancelled'));

ALTER TABLE sellbacks ADD COLUMN IF NOT EXISTS return_rail text;
ALTER TABLE sellbacks ADD COLUMN IF NOT EXISTS return_request_id text;
ALTER TABLE sellbacks ADD COLUMN IF NOT EXISTS return_last_error text;

-- The account number inside the bank details a seller typed, kept on its
-- own so one account collecting from many different lines can be counted.
-- Nothing else is read out of what they typed, and the whole text is still
-- shown to the person paying.
ALTER TABLE sellbacks ADD COLUMN IF NOT EXISTS bank_account_digits text;
CREATE INDEX IF NOT EXISTS sellbacks_bank_account_idx ON sellbacks (bank_account_digits) WHERE bank_account_digits IS NOT NULL;

-- The recipient caps count by the receiving line, which nothing indexed.
CREATE INDEX IF NOT EXISTS transfers_recipient_idx ON transfers (recipient_number, created_at DESC);

-- Two more answers a phone's message can end in: the value was sent back
-- automatically, on a transfer and on a sale.
ALTER TABLE bridge_messages DROP CONSTRAINT IF EXISTS bridge_messages_outcome_check;
ALTER TABLE bridge_messages ADD CONSTRAINT bridge_messages_outcome_check
  CHECK (outcome IN ('matched', 'unmatched', 'held', 'duplicate', 'unparsed', 'ignored', 'recorded_by_hand', 'bought', 'bought_held', 'returned', 'bought_returned'));
