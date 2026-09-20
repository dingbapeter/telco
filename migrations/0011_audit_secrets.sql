-- Nothing secret in the audit log.
--
-- The audit trigger copies whole rows, so a password hash, a session token
-- hash or a form token landed in audit_log and was shown in full on the
-- Audit page to anyone who could open it. A hash is not a password, but it
-- is the material for guessing one offline, and a stored token hash is the
-- token as far as the server is concerned. They are replaced by a marker
-- before the row is written, so nothing sensitive is ever in the table, not
-- even in a backup.

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor  text := coalesce(nullif(current_setting('app.actor', true), ''), 'system');
  before jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after  jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  secret text;
  row_id text;
BEGIN
  -- The first column of every audited table is its identity.
  row_id := coalesce(after ->> TG_ARGV[0], before ->> TG_ARGV[0]);
  FOREACH secret IN ARRAY ARRAY['password_hash', 'token_hash', 'csrf_token'] LOOP
    IF before ? secret THEN before := jsonb_set(before, ARRAY[secret], '"[hidden]"'); END IF;
    IF after ? secret THEN after := jsonb_set(after, ARRAY[secret], '"[hidden]"'); END IF;
  END LOOP;
  INSERT INTO audit_log (actor, table_name, row_id, action, before, after)
  VALUES (actor, TG_TABLE_NAME, row_id, lower(TG_OP), before, after);
  RETURN NULL;
END $$;

-- Anything already written before this ran is cleaned up too.
UPDATE audit_log SET
  before = CASE WHEN before ? 'password_hash' THEN jsonb_set(before, '{password_hash}', '"[hidden]"') ELSE before END,
  after = CASE WHEN after ? 'password_hash' THEN jsonb_set(after, '{password_hash}', '"[hidden]"') ELSE after END
WHERE before ? 'password_hash' OR after ? 'password_hash';
UPDATE audit_log SET
  before = CASE WHEN before ? 'token_hash' THEN jsonb_set(before, '{token_hash}', '"[hidden]"') ELSE before END,
  after = CASE WHEN after ? 'token_hash' THEN jsonb_set(after, '{token_hash}', '"[hidden]"') ELSE after END
WHERE before ? 'token_hash' OR after ? 'token_hash';
UPDATE audit_log SET
  before = CASE WHEN before ? 'csrf_token' THEN jsonb_set(before, '{csrf_token}', '"[hidden]"') ELSE before END,
  after = CASE WHEN after ? 'csrf_token' THEN jsonb_set(after, '{csrf_token}', '"[hidden]"') ELSE after END
WHERE before ? 'csrf_token' OR after ? 'csrf_token';
