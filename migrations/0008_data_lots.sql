-- Gifted data rots: every bundle that lands on our SIM is a lot with an
-- expiry. Value goes out oldest first, and what expires is written off.

CREATE TABLE IF NOT EXISTS data_lots (
  id                    bigserial PRIMARY KEY,
  network_code          text NOT NULL REFERENCES networks (code),
  bundle_id             bigint REFERENCES data_bundles (id),
  size_mb               int NOT NULL CHECK (size_mb > 0),
  value_kobo            bigint NOT NULL CHECK (value_kobo > 0),
  remaining_value_kobo  bigint NOT NULL CHECK (remaining_value_kobo >= 0),
  received_at           timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  source                text NOT NULL,
  state                 text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'used', 'expired')),
  written_off_at        timestamptz
);
CREATE INDEX IF NOT EXISTS data_lots_open_idx ON data_lots (network_code, expires_at) WHERE state = 'open';

DO $$ BEGIN
  CREATE TRIGGER data_lots_audit AFTER INSERT OR UPDATE OR DELETE ON data_lots
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
