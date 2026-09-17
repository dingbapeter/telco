-- Administrators of the command centre and their sessions.

CREATE TABLE IF NOT EXISTS admins (
  id             bigserial PRIMARY KEY,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The token itself is never stored, only its hash, so a copy of the
-- database cannot be used to log in.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  text PRIMARY KEY,
  admin_id    bigint NOT NULL REFERENCES admins (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  csrf_token  text NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx ON admin_sessions (admin_id);

DO $$ BEGIN
  CREATE TRIGGER admins_audit AFTER INSERT OR UPDATE OR DELETE ON admins
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
