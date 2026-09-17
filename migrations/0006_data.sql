-- Data bundles. A bundle is not naira: a gigabyte costs different amounts
-- on different networks, so every bundle we sell, deliver or accept has a
-- catalogue entry with its price, and value moves at that price.

CREATE TABLE IF NOT EXISTS data_bundles (
  id                       bigserial PRIMARY KEY,
  network_code             text NOT NULL REFERENCES networks (code),
  code                     text NOT NULL,
  name                     text NOT NULL,
  size_mb                  int NOT NULL CHECK (size_mb > 0),
  validity_days            int,
  price_kobo               bigint NOT NULL CHECK (price_kobo > 0),
  provider_variation_code  text,
  giftable                 boolean NOT NULL DEFAULT false,
  active                   boolean NOT NULL DEFAULT true,
  source                   text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'vtpass')),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network_code, code)
);

DO $$ BEGIN
  CREATE TRIGGER data_bundles_audit AFTER INSERT OR UPDATE OR DELETE ON data_bundles
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What is sent and what is received can each be airtime or a bundle.
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS in_kind text NOT NULL DEFAULT 'airtime' CHECK (in_kind IN ('airtime', 'data'));
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS in_bundle_id bigint REFERENCES data_bundles (id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS out_kind text NOT NULL DEFAULT 'airtime' CHECK (out_kind IN ('airtime', 'data'));
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS out_bundle_id bigint REFERENCES data_bundles (id);

ALTER TABLE inbound_notifications ADD COLUMN IF NOT EXISTS data_mb int;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_id bigint REFERENCES data_bundles (id);

-- Data gifted into our SIM on each network, held at catalogue value.
INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('datapool:MTN',     'asset', 'Data held on our MTN SIM, at catalogue value'),
  ('datapool:AIRTEL',  'asset', 'Data held on our Airtel SIM, at catalogue value'),
  ('datapool:GLO',     'asset', 'Data held on our Glo SIM, at catalogue value'),
  ('datapool:9MOBILE', 'asset', 'Data held on our 9mobile SIM, at catalogue value')
ON CONFLICT (code) DO NOTHING;
