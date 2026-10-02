-- A second way for money to reach us, and the balance it sits in.
--
-- Money taken by a card gateway is not in our bank until that gateway settles
-- it, so each gateway holds its own balance in the books, the way the provider
-- wallet does. Paystack's account already exists. This is Flutterwave's, which
-- the founder chose because it takes cards in currencies other than naira and
-- can pay out in them too.
--
-- Nothing else is needed: the table that records a gateway's webhooks already
-- keys on the gateway's name, and an agent's top-up already carries the
-- account the money landed in rather than the name of a gateway.

INSERT INTO ledger_accounts (code, kind, name) VALUES
  ('cash:flutterwave', 'asset', 'Money held by Flutterwave for us, before settlement to the bank')
ON CONFLICT (code) DO NOTHING;
