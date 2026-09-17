-- Retail top-up: selling airtime for money. This is the valve that turns an
-- overfull pool back into cash, and a second line of revenue.

CREATE TABLE IF NOT EXISTS orders (
  id                        bigserial PRIMARY KEY,
  reference                 text NOT NULL UNIQUE,
  state                     text NOT NULL,
  network_code              text NOT NULL REFERENCES networks (code),
  recipient_number          text NOT NULL,
  buyer_email               text,
  face_kobo                 bigint NOT NULL CHECK (face_kobo > 0),
  discount_kobo             bigint NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
  price_kobo                bigint NOT NULL CHECK (price_kobo > 0),
  payment_method            text,
  payment_reference         text,
  paid_kobo                 bigint,
  payment_fee_kobo          bigint,
  paid_at                   timestamptz,
  delivery_rail             text,
  delivery_request_id       text,
  delivery_reference        text,
  delivery_attempts         int NOT NULL DEFAULT 0,
  delivery_next_attempt_at  timestamptz,
  delivery_last_error       text,
  delivered_at              timestamptz,
  refunded_kobo             bigint,
  refund_reference          text,
  refunded_at               timestamptz,
  hold_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_state_idx ON orders (state);
CREATE INDEX IF NOT EXISTS orders_delivery_request_idx ON orders (delivery_request_id) WHERE delivery_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_events (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders (id),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_state  text,
  to_state    text NOT NULL,
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, at);

-- Every message a payment provider sends us, once. A message that arrives
-- twice is recorded once and does nothing the second time.
CREATE TABLE IF NOT EXISTS payment_events (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL,
  event_type          text NOT NULL,
  provider_reference  text NOT NULL,
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  outcome             text,
  UNIQUE (provider, event_type, provider_reference)
);

DO $$ BEGIN
  CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('cash:bank',                'asset',     'Money in our bank account'),
  ('cash:paystack',            'asset',     'Money held by Paystack for us, before settlement to the bank'),
  ('owed:buyers',              'liability', 'Money paid by buyers for airtime not yet delivered or refunded'),
  ('expense:retail_discounts', 'expense',   'Discounts given to buyers to drain an overfull pool'),
  ('expense:payment_fees',     'expense',   'Fees charged by the payment provider')
ON CONFLICT (code) DO NOTHING;
