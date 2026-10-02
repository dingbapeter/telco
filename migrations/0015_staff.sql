-- People who work here, and what they may do.
--
-- Until now everybody who could log in could do everything, including
-- change the fees. A shop assistant settling withdrawals does not need
-- that, and nobody should have to hold a password that powerful to do an
-- ordinary day's work.
--
-- Everyone who already has a login stays a founder, because taking power
-- away from an account somebody is already using would lock them out of
-- their own job without warning.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'founder';
DO $$ BEGIN
  ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('founder', 'staff'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
