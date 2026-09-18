-- Agents: people who bring senders and buyers to us. Each has a referral
-- code, a prepaid wallet held as its own ledger account, and a login.

CREATE TABLE IF NOT EXISTS agents (
  id             bigserial PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  phone          text NOT NULL UNIQUE,
  email          text,
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  token_hash  text PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES agents (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  csrf_token  text NOT NULL
);

-- What an agent asks to be paid out, and what a person did about it.
CREATE TABLE IF NOT EXISTS agent_withdrawals (
  id            bigserial PRIMARY KEY,
  agent_id      bigint NOT NULL REFERENCES agents (id),
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  bank_details  text NOT NULL,
  state         text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'paid', 'declined')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  settled_by    text,
  reference     text,
  note          text
);

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS agent_id bigint REFERENCES agents (id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS agent_commission_kobo bigint;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS agent_id bigint REFERENCES agents (id);
CREATE INDEX IF NOT EXISTS transfers_agent_idx ON transfers (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_agent_idx ON orders (agent_id) WHERE agent_id IS NOT NULL;

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('expense:agent_commissions', 'expense', 'Commissions earned by agents on transfers they brought')
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
  CREATE TRIGGER agents_audit AFTER INSERT OR UPDATE OR DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER agent_withdrawals_audit AFTER INSERT OR UPDATE OR DELETE ON agent_withdrawals
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Online wallet top-ups carry their own reference to the payment provider.
CREATE TABLE IF NOT EXISTS agent_topups (
  reference    text PRIMARY KEY,
  agent_id     bigint NOT NULL REFERENCES agents (id),
  amount_kobo  bigint NOT NULL CHECK (amount_kobo > 0),
  state        text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'paid', 'failed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
