-- What an agent shop needs beyond a wallet: a rate agreed with them alone,
-- many numbers bought in one go, a statement they can hand to their
-- accountant, a credit line for the ones we trust, and a key so their own
-- till software can buy without a browser.

-- Per-agent rates. NULL means "use the setting", so the global default keeps
-- working and a signed deal is a number on the agent's own row.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS discount_basis_points   integer;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS commission_basis_points integer;
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_discount_range CHECK (discount_basis_points IS NULL OR (discount_basis_points >= 0 AND discount_basis_points <= 2000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_commission_range CHECK (commission_basis_points IS NULL OR (commission_basis_points >= 0 AND commission_basis_points <= 10000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The credit line: how far below zero this agent's wallet may go. How long
-- they have owed is not kept here. It is worked out from the wallet's own
-- postings, which cannot be edited, so the two can never drift apart.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS credit_limit_kobo bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_credit_limit_positive CHECK (credit_limit_kobo >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One submission of many numbers. The reference comes from the form, so a
-- second tap on a slow phone finds the batch already there instead of
-- buying everything twice.
CREATE TABLE IF NOT EXISTS agent_batches (
  id          bigserial PRIMARY KEY,
  reference   text NOT NULL UNIQUE,
  agent_id    bigint NOT NULL REFERENCES agents (id),
  lines       integer NOT NULL CHECK (lines > 0),
  total_kobo  bigint NOT NULL CHECK (total_kobo >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_id bigint REFERENCES agent_batches (id);
CREATE INDEX IF NOT EXISTS orders_batch_idx ON orders (batch_id) WHERE batch_id IS NOT NULL;

-- A till or a POS device sends its own reference with every purchase. The
-- unique index is what makes a repeated request return the same order
-- rather than buying a second time.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_agent_client_reference_idx ON orders (agent_id, client_reference) WHERE client_reference IS NOT NULL;

-- Keys for the agent's own software. Only the hash is kept, as with the
-- phone bridge: a key we cannot read is a key we cannot leak.
CREATE TABLE IF NOT EXISTS agent_api_keys (
  id           bigserial PRIMARY KEY,
  agent_id     bigint NOT NULL REFERENCES agents (id),
  label        text NOT NULL,
  key_id       text NOT NULL UNIQUE,
  token_hash   text NOT NULL UNIQUE,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS agent_api_keys_agent_idx ON agent_api_keys (agent_id);

DO $$ BEGIN
  CREATE TRIGGER agent_batches_audit AFTER INSERT OR UPDATE OR DELETE ON agent_batches
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER agent_api_keys_audit AFTER INSERT OR UPDATE OR DELETE ON agent_api_keys
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
