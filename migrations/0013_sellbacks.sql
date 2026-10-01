-- Buying airtime and data back from the people who hold it.
--
-- Somebody with airtime or a data bundle they cannot use sends it to one of
-- our SIMs and we pay for it, either as credit to spend with us or, where
-- the founder has turned it on, as cash by bank transfer. What arrives is
-- believed only from the network's own message, the same rule the transfer
-- side follows, because that message is the only proof the value is really
-- on our SIM.

CREATE TABLE IF NOT EXISTS sellbacks (
  id                bigserial PRIMARY KEY,
  reference         text NOT NULL UNIQUE,
  state             text NOT NULL DEFAULT 'awaiting_inbound'
                      CHECK (state IN ('awaiting_inbound', 'expired', 'held', 'received', 'settled', 'paid', 'returned', 'cancelled')),
  network_code      text NOT NULL REFERENCES networks (code),
  seller_number     text NOT NULL,
  receiving_number  text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('airtime', 'data')),
  bundle_id         bigint REFERENCES data_bundles (id),
  -- What the value is worth at the price we would sell it for, the rate we
  -- quoted against it, and what that makes us owe.
  face_kobo         bigint NOT NULL CHECK (face_kobo > 0),
  rate_basis_points integer NOT NULL CHECK (rate_basis_points > 0 AND rate_basis_points < 10000),
  quoted_pay_kobo   bigint NOT NULL CHECK (quoted_pay_kobo > 0),
  received_kobo     bigint,
  pay_kobo          bigint,
  outcome           text NOT NULL CHECK (outcome IN ('credit', 'cash')),
  bank_details      text,
  credit_code       text,
  hold_reason       text,
  notification_id   bigint REFERENCES inbound_notifications (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  received_at       timestamptz,
  settled_at        timestamptz,
  settled_by        text,
  payout_reference  text
);
CREATE INDEX IF NOT EXISTS sellbacks_waiting_idx ON sellbacks (network_code, receiving_number, seller_number) WHERE state IN ('awaiting_inbound', 'expired');
CREATE INDEX IF NOT EXISTS sellbacks_state_idx ON sellbacks (state, created_at);
CREATE INDEX IF NOT EXISTS sellbacks_seller_idx ON sellbacks (seller_number, created_at);

CREATE TABLE IF NOT EXISTS sellback_events (
  id          bigserial PRIMARY KEY,
  sellback_id bigint NOT NULL REFERENCES sellbacks (id),
  at          timestamptz NOT NULL DEFAULT now(),
  from_state  text,
  to_state    text NOT NULL,
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sellback_events_sellback_idx ON sellback_events (sellback_id, id);

-- Credit a seller holds with us. The code is the instrument: whoever has it
-- can spend it on the buy pages, and it draws down as it is used, so one
-- code can pay for several small purchases.
CREATE TABLE IF NOT EXISTS credit_notes (
  code            text PRIMARY KEY,
  sellback_id     bigint NOT NULL REFERENCES sellbacks (id),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  remaining_kobo  bigint NOT NULL CHECK (remaining_kobo >= 0),
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'used', 'voided')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  voided_at       timestamptz,
  voided_by       text,
  void_reason     text,
  CHECK (remaining_kobo <= amount_kobo)
);
CREATE INDEX IF NOT EXISTS credit_notes_sellback_idx ON credit_notes (sellback_id);

-- Numbers we will not buy from again. The operational answer to somebody
-- selling us value that is not theirs.
CREATE TABLE IF NOT EXISTS sellback_blocks (
  number    text PRIMARY KEY,
  reason    text NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  added_by  text NOT NULL
);

-- The phone's own record of what became of each message gains the two new
-- answers. Dropped and added in one go, inside the migration's transaction,
-- so running it twice is safe and the table is never without the rule.
ALTER TABLE bridge_messages DROP CONSTRAINT IF EXISTS bridge_messages_outcome_check;
ALTER TABLE bridge_messages ADD CONSTRAINT bridge_messages_outcome_check
  CHECK (outcome IN ('matched', 'unmatched', 'held', 'duplicate', 'unparsed', 'ignored', 'recorded_by_hand', 'bought', 'bought_held'));

-- Which sale a network message was placed against, so a message we bought
-- value on does not sit in the unmatched list nagging somebody for ever.
ALTER TABLE inbound_notifications ADD COLUMN IF NOT EXISTS matched_sellback_id bigint REFERENCES sellbacks (id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_code text REFERENCES credit_notes (code);
CREATE INDEX IF NOT EXISTS orders_credit_code_idx ON orders (credit_code) WHERE credit_code IS NOT NULL;

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('owed:sellers', 'liability', 'Owed to people who sold us airtime or data'),
  ('revenue:sellback_margin', 'revenue', 'Margin on airtime and data bought below the price we sell it for'),
  ('revenue:voided_credit', 'revenue', 'Credit voided after a seller was blocked')
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
  CREATE TRIGGER sellbacks_audit AFTER INSERT OR UPDATE OR DELETE ON sellbacks
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER credit_notes_audit AFTER INSERT OR UPDATE OR DELETE ON credit_notes
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('code');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER sellback_blocks_audit AFTER INSERT OR UPDATE OR DELETE ON sellback_blocks
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('number');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
