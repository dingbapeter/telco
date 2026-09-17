-- The sending phone: the bridge app dials the network's own codes to send
-- airtime and gift bundles from our SIMs, on the server's instruction.

ALTER TABLE bridge_devices ADD COLUMN IF NOT EXISTS can_send boolean NOT NULL DEFAULT false;
ALTER TABLE bridge_devices ADD COLUMN IF NOT EXISTS pin_set boolean NOT NULL DEFAULT false;

-- One row per thing a phone is asked to dial. The code keeps a {pin}
-- placeholder: the SIM's PIN is on the phone and nowhere else.
CREATE TABLE IF NOT EXISTS phone_commands (
  id             bigserial PRIMARY KEY,
  device_id      bigint NOT NULL REFERENCES bridge_devices (id),
  network_code   text NOT NULL REFERENCES networks (code),
  kind           text NOT NULL CHECK (kind IN ('send_airtime', 'gift_data')),
  number         text NOT NULL,
  amount_kobo    bigint NOT NULL CHECK (amount_kobo > 0),
  bundle_id      bigint REFERENCES data_bundles (id),
  code           text NOT NULL,
  purpose        text NOT NULL,
  state          text NOT NULL CHECK (state IN ('queued', 'fetched', 'dialled', 'confirmed', 'failed', 'unknown')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  fetched_at     timestamptz,
  dialled_at     timestamptz,
  response_text  text,
  failure        text,
  resolved_at    timestamptz,
  resolved_by    text
);
CREATE INDEX IF NOT EXISTS phone_commands_device_state_idx ON phone_commands (device_id, state, id);

-- Refunds can now be sent by a phone; these record which and how.
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS refund_rail text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS refund_request_id text;

DO $$ BEGIN
  CREATE TRIGGER phone_commands_audit AFTER INSERT OR UPDATE OR DELETE ON phone_commands
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
