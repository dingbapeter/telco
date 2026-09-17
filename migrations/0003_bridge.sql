-- The phone bridge: one Android phone per network holds our receiving SIM
-- and forwards every text message it receives to the server.

CREATE TABLE IF NOT EXISTS bridge_devices (
  id            bigserial PRIMARY KEY,
  label         text NOT NULL,
  network_code  text NOT NULL REFERENCES networks (code),
  token_hash    text NOT NULL UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  app_version   text,
  battery       int,
  queue_size    int
);

-- Every message a phone forwards, parsed or not, so nothing a network said
-- is ever lost and a person can read the ones the parser did not understand.
CREATE TABLE IF NOT EXISTS bridge_messages (
  id                   bigserial PRIMARY KEY,
  device_id            bigint NOT NULL REFERENCES bridge_devices (id),
  from_address         text NOT NULL,
  body                 text NOT NULL,
  received_on_phone_at timestamptz,
  received_at          timestamptz NOT NULL DEFAULT now(),
  dedupe_hash          text NOT NULL UNIQUE,
  outcome              text NOT NULL CHECK (outcome IN ('matched', 'unmatched', 'held', 'duplicate', 'unparsed', 'ignored', 'recorded_by_hand')),
  notification_id      bigint REFERENCES inbound_notifications (id),
  note                 text
);
CREATE INDEX IF NOT EXISTS bridge_messages_unparsed_idx ON bridge_messages (received_at DESC) WHERE outcome = 'unparsed';
CREATE INDEX IF NOT EXISTS bridge_messages_device_idx ON bridge_messages (device_id, received_at DESC);

DO $$ BEGIN
  CREATE TRIGGER bridge_devices_audit AFTER INSERT OR UPDATE OR DELETE ON bridge_devices
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
