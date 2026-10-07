-- A dialled session, kept across keypresses.
--
-- USSD has no cookies and no memory. The aggregator sends one keypress at a
-- time to our address and expects one screen back, so everything the caller
-- has told us so far has to live here. It cannot live in the server's memory:
-- a restart between two keypresses would lose somebody mid-transfer, and two
-- requests for one session can arrive at once.
--
-- The row is also the record of what happened. Each screen and keypress is
-- appended to the transcript, so a caller who says they were shown something
-- else can be answered from what was really sent. There is deliberately no
-- audit trigger on this table: a session changes on every keypress and would
-- bury the audit log, and the transcript already holds more than the trigger
-- would.
--
-- The key is a number of our own and not the network's session id, so that a
-- dial is a record that is never written over. The network's id is unique in
-- practice but we do not get to rely on that, and a session that created a
-- real transfer must not lose its transcript because a later caller happened
-- to be given the same id.

CREATE TABLE IF NOT EXISTS ussd_sessions (
  id             bigserial PRIMARY KEY,
  session_id     text NOT NULL,
  -- The line the caller dialled from, which is also the line that will send
  -- the airtime, and the short code they dialled.
  caller_number  text NOT NULL,
  service_code   text NOT NULL,
  -- The caller's own network. The aggregator knows it, because the session
  -- came in over that network; where it does not say, we ask.
  network_code   text REFERENCES networks (code),
  step           text NOT NULL,
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Everything keyed so far, joined the way the aggregator joins it. A
  -- request that repeats it is a retry, not a new keypress.
  input_so_far   text NOT NULL DEFAULT '',
  last_screen    text NOT NULL DEFAULT '',
  -- Counted so that a session cannot be kept open for ever by one caller.
  keypresses     int NOT NULL DEFAULT 0,
  -- What the session created, once. A retry at the confirm screen finds this
  -- already set and shows the same answer rather than creating a second one.
  reference      text,
  transcript     jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  outcome        text
);

CREATE INDEX IF NOT EXISTS ussd_sessions_caller_idx ON ussd_sessions (caller_number, started_at DESC);
CREATE INDEX IF NOT EXISTS ussd_sessions_open_idx ON ussd_sessions (last_seen_at) WHERE ended_at IS NULL;
-- The session the next keypress belongs to, found by the network's id. The
-- newest row wins, because an older one with the same id is a finished dial.
CREATE INDEX IF NOT EXISTS ussd_sessions_lookup_idx ON ussd_sessions (session_id, started_at DESC);
-- One open session per network id at a time. The endpoint closes a stale
-- session before it starts a new one with the same id; this is what makes
-- that a rule rather than a habit.
CREATE UNIQUE INDEX IF NOT EXISTS ussd_sessions_one_open_idx ON ussd_sessions (session_id) WHERE ended_at IS NULL;
