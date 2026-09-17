-- Foundation: networks, settings, audit, ledger, transfers.
-- Every statement is safe to run twice. See docs/WORKING_METHOD.md.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- One hook writes the audit log. Tables opt in with a trigger below; nothing
-- in application code has to remember to log a change. The actor comes from
-- a transaction-local setting that the application sets before writing.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor       text NOT NULL,
  table_name  text NOT NULL,
  row_id      text NOT NULL,
  action      text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  before      jsonb,
  after       jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_row_idx ON audit_log (table_name, row_id);

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor  text := coalesce(nullif(current_setting('app.actor', true), ''), 'system');
  before jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after  jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  row_id text;
BEGIN
  -- The first column of every audited table is its identity.
  row_id := coalesce(after ->> TG_ARGV[0], before ->> TG_ARGV[0]);
  INSERT INTO audit_log (actor, table_name, row_id, action, before, after)
  VALUES (actor, TG_TABLE_NAME, row_id, lower(TG_OP), before, after);
  RETURN NULL;
END $$;

-- Rows in these tables are history. Changing them would change the past.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TABLE IF NOT EXISTS networks (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  active  boolean NOT NULL DEFAULT true
);

-- Number portability means a prefix only hints at the network. The sender
-- confirms the network on screen; this table just picks the default.
CREATE TABLE IF NOT EXISTS network_prefixes (
  prefix        text PRIMARY KEY,
  network_code  text NOT NULL REFERENCES networks (code)
);

-- Our own numbers that receive inbound airtime, one or more per network.
CREATE TABLE IF NOT EXISTS receiving_numbers (
  number          text PRIMARY KEY,
  network_code    text NOT NULL REFERENCES networks (code),
  label           text NOT NULL DEFAULT '',
  active          boolean NOT NULL DEFAULT true,
  daily_cap_kobo  bigint NOT NULL DEFAULT 0 CHECK (daily_cap_kobo >= 0)
);

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL
);

-- Ledger. Amounts are integer kobo. A posting is a debit when positive and a
-- credit when negative, and every journal sums to zero, checked at commit.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code  text PRIMARY KEY,
  kind  text NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue', 'expense', 'equity')),
  name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id               bigserial PRIMARY KEY,
  posted_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  description      text NOT NULL,
  reference        text,
  idempotency_key  text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id            bigserial PRIMARY KEY,
  journal_id    bigint NOT NULL REFERENCES ledger_journals (id),
  account_code  text NOT NULL REFERENCES ledger_accounts (code),
  amount_kobo   bigint NOT NULL CHECK (amount_kobo <> 0)
);
CREATE INDEX IF NOT EXISTS ledger_postings_account_idx ON ledger_postings (account_code);
CREATE INDEX IF NOT EXISTS ledger_postings_journal_idx ON ledger_postings (journal_id);

CREATE OR REPLACE FUNCTION check_journal_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  n     int;
BEGIN
  SELECT coalesce(sum(amount_kobo), 0), count(*) INTO total, n
  FROM ledger_postings WHERE journal_id = NEW.journal_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal % does not balance: sum is % kobo', NEW.journal_id, total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal % needs at least two postings', NEW.journal_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

DO $$ BEGIN
  CREATE CONSTRAINT TRIGGER ledger_postings_balance
    AFTER INSERT ON ledger_postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_journal_balances();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER ledger_postings_immutable
    BEFORE UPDATE OR DELETE ON ledger_postings
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER ledger_journals_immutable
    BEFORE UPDATE OR DELETE ON ledger_journals
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Transfers. The state column is the machine; every change goes through a
-- conditional update in application code and is recorded in transfer_events.
CREATE TABLE IF NOT EXISTS transfers (
  id                    bigserial PRIMARY KEY,
  reference             text NOT NULL UNIQUE,
  state                 text NOT NULL,
  from_network          text NOT NULL REFERENCES networks (code),
  to_network            text NOT NULL REFERENCES networks (code),
  sender_number         text NOT NULL,
  recipient_number      text NOT NULL,
  receiving_number      text NOT NULL REFERENCES receiving_numbers (number),
  requested_kobo        bigint NOT NULL CHECK (requested_kobo > 0),
  received_kobo         bigint,
  fee_kobo              bigint,
  platform_share_kobo   bigint,
  network_share_kobo    bigint,
  payout_kobo           bigint,
  quoted_fee_kobo       bigint NOT NULL,
  quoted_payout_kobo    bigint NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  inbound_confirmed_at  timestamptz,
  paid_out_at           timestamptz,
  refunded_at           timestamptz,
  payout_attempts       int NOT NULL DEFAULT 0,
  payout_reference      text,
  hold_reason           text,
  approved_by           text,
  approved_at           timestamptz,
  CHECK (from_network <> to_network)
);
CREATE INDEX IF NOT EXISTS transfers_state_idx ON transfers (state);
CREATE INDEX IF NOT EXISTS transfers_sender_idx ON transfers (sender_number, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_match_idx
  ON transfers (from_network, receiving_number, sender_number)
  WHERE state = 'awaiting_inbound';

CREATE TABLE IF NOT EXISTS transfer_events (
  id           bigserial PRIMARY KEY,
  transfer_id  bigint NOT NULL REFERENCES transfers (id),
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_state   text,
  to_state     text NOT NULL,
  actor        text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS transfer_events_transfer_idx ON transfer_events (transfer_id, at);

-- Every network notification we receive, matched or not. The dedupe hash
-- makes a notification that arrives twice count once.
CREATE TABLE IF NOT EXISTS inbound_notifications (
  id                   bigserial PRIMARY KEY,
  network_code         text NOT NULL REFERENCES networks (code),
  receiving_number     text NOT NULL,
  sender_number        text NOT NULL,
  amount_kobo          bigint NOT NULL CHECK (amount_kobo > 0),
  raw_text             text NOT NULL,
  source               text NOT NULL CHECK (source IN ('bridge', 'manual')),
  occurred_at          timestamptz,
  received_at          timestamptz NOT NULL DEFAULT now(),
  recorded_by          text NOT NULL,
  dedupe_hash          text NOT NULL UNIQUE,
  matched_transfer_id  bigint REFERENCES transfers (id)
);
CREATE INDEX IF NOT EXISTS inbound_notifications_unmatched_idx
  ON inbound_notifications (network_code, received_at DESC)
  WHERE matched_transfer_id IS NULL;

-- Audit hooks. The argument names the identity column.
DO $$ BEGIN
  CREATE TRIGGER settings_audit AFTER INSERT OR UPDATE OR DELETE ON settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('key');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER networks_audit AFTER INSERT OR UPDATE OR DELETE ON networks
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('code');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER receiving_numbers_audit AFTER INSERT OR UPDATE OR DELETE ON receiving_numbers
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('number');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER transfers_audit AFTER INSERT OR UPDATE OR DELETE ON transfers
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER inbound_notifications_audit AFTER INSERT OR UPDATE OR DELETE ON inbound_notifications
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed data. Networks and prefixes are reference data the command centre
-- can edit; the seed only fills gaps and never overwrites an edit.
INSERT INTO networks (code, name) VALUES
  ('MTN', 'MTN'), ('AIRTEL', 'Airtel'), ('GLO', 'Glo'), ('9MOBILE', '9mobile')
ON CONFLICT (code) DO NOTHING;

INSERT INTO network_prefixes (prefix, network_code) VALUES
  ('0803','MTN'),('0806','MTN'),('0703','MTN'),('0706','MTN'),('0813','MTN'),
  ('0816','MTN'),('0810','MTN'),('0814','MTN'),('0903','MTN'),('0906','MTN'),
  ('0913','MTN'),('0916','MTN'),('0704','MTN'),
  ('0802','AIRTEL'),('0808','AIRTEL'),('0708','AIRTEL'),('0812','AIRTEL'),
  ('0701','AIRTEL'),('0902','AIRTEL'),('0901','AIRTEL'),('0907','AIRTEL'),
  ('0912','AIRTEL'),('0911','AIRTEL'),
  ('0805','GLO'),('0807','GLO'),('0705','GLO'),('0815','GLO'),('0811','GLO'),
  ('0905','GLO'),('0915','GLO'),
  ('0809','9MOBILE'),('0818','9MOBILE'),('0817','9MOBILE'),('0909','9MOBILE'),
  ('0908','9MOBILE')
ON CONFLICT (prefix) DO NOTHING;

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('pool:MTN',        'asset',     'Airtime held on MTN'),
  ('pool:AIRTEL',     'asset',     'Airtime held on Airtel'),
  ('pool:GLO',        'asset',     'Airtime held on Glo'),
  ('pool:9MOBILE',    'asset',     'Airtime held on 9mobile'),
  ('owed:senders',    'liability', 'Airtime received and not yet paid out or refunded'),
  ('owed:MTN',        'liability', 'Fee share owed to MTN'),
  ('owed:AIRTEL',     'liability', 'Fee share owed to Airtel'),
  ('owed:GLO',        'liability', 'Fee share owed to Glo'),
  ('owed:9MOBILE',    'liability', 'Fee share owed to 9mobile'),
  ('revenue:fees',    'revenue',   'Our share of transfer fees'),
  ('equity:float',    'equity',    'Airtime put into the pools by the founder'),
  ('expense:losses',  'expense',   'Airtime lost to failed rails or barred SIMs')
ON CONFLICT (code) DO NOTHING;
