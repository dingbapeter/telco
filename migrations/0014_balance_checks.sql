-- Asking each SIM what the network says it is holding.
--
-- A pool is our own ledger's belief about the airtime on a SIM. Until now
-- nothing checked that belief against the network. A balance check is the
-- same mechanism as a payout: the server queues a code, the phone dials it
-- and sends back the network's reply, and the reply is read and compared
-- with the books.

ALTER TABLE phone_commands DROP CONSTRAINT IF EXISTS phone_commands_kind_check;
ALTER TABLE phone_commands ADD CONSTRAINT phone_commands_kind_check
  CHECK (kind IN ('send_airtime', 'gift_data', 'check_balance'));
-- A balance check sends nothing, so it has no amount and no number.
ALTER TABLE phone_commands DROP CONSTRAINT IF EXISTS phone_commands_amount_kobo_check;
ALTER TABLE phone_commands ADD CONSTRAINT phone_commands_amount_kobo_check
  CHECK (amount_kobo >= 0);

CREATE TABLE IF NOT EXISTS balance_checks (
  id              bigserial PRIMARY KEY,
  network_code    text NOT NULL REFERENCES networks (code),
  device_id       bigint NOT NULL REFERENCES bridge_devices (id),
  command_id      bigint NOT NULL REFERENCES phone_commands (id),
  state           text NOT NULL DEFAULT 'asked' CHECK (state IN ('asked', 'answered', 'unreadable', 'failed')),
  asked_at        timestamptz NOT NULL DEFAULT now(),
  asked_by        text NOT NULL,
  answered_at     timestamptz,
  -- What the network said the SIM holds, what our ledger says the pool
  -- holds, and what has left the SIM but not yet the ledger. The difference
  -- is the first less the other two, which is the number that matters.
  reported_kobo   bigint,
  ledger_kobo     bigint,
  committed_kobo  bigint,
  difference_kobo bigint,
  raw_text        text,
  accepted_at     timestamptz,
  accepted_by     text,
  accepted_note   text
);
CREATE INDEX IF NOT EXISTS balance_checks_network_idx ON balance_checks (network_code, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS balance_checks_command_idx ON balance_checks (command_id);

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('revenue:adjustments', 'revenue', 'Airtime found on a SIM that the ledger did not know about')
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
  CREATE TRIGGER balance_checks_audit AFTER INSERT OR UPDATE OR DELETE ON balance_checks
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
