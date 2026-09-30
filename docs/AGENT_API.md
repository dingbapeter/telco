# The interface for an agent's own software

A shop that runs its own till, POS device or bookkeeping software can buy
through this interface instead of the portal pages. It is meant for
server to server use and for POS devices, not for scripts running inside
a customer's web browser.

Everything here is already built and covered by tests in
`tests/agentapi.test.ts`.

## Turning it on

Under Settings, Agents:

- **The agent interface for other software.** Off until you turn it on.
  With it off, every key is refused with words that tell the shop their key
  still exists and the portal still works.
- **Requests a key may make each minute.** 120 by default. A till serving
  one customer at a time needs a handful.

## Keys

The agent makes a key themselves at `/agent/keys`, one for each machine.
The key is shown once, on that page, and never again: we keep only a
SHA-256 fingerprint of it, so nobody at Telco can read a shop's key, and
the audit log holds `[hidden]` in place of even the fingerprint. Five keys
in use per agent. Either the shop or you can revoke one, on that page or on
the agent's page in the command centre, and it stops working at once.

Every request carries the key:

```
Authorization: Bearer tk_a7k3m9qr_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

The short part after `tk_` is the key's id. It is shown in the portal and
in the command centre, so a machine's key can be matched to its row
without anybody seeing the key itself.

## Rules that hold everywhere

- **Amounts are in naira**, in a field called `amount`. A field called
  `amount_kobo` is refused with a message, never guessed at, because a till
  that muddled the two would sell five naira of airtime instead of five
  hundred.
- Every answer carries `ok`. A refusal carries `error.code` and
  `error.message`, and the message says what to do next.
- Every amount in an answer comes three ways: `kobo` as a whole number,
  `naira` as a decimal string, and `shown` as we would print it.
- **Every purchase carries a `client_reference` of the shop's own.** If the
  network drops and the software asks again with the same one, it gets back
  the purchase it already made, with `repeated: true`. Nothing is ever
  bought twice.
- The network is worked out from the number. Send `network` as well when a
  customer has moved network and the number would point at the wrong one.

## What to ask for

All addresses are under `/api/v1`.

| Ask | Answers |
| --- | --- |
| `GET /ping` | The agent's name and code, and the key's id. |
| `GET /balance` | Wallet, withdrawals requested, credit line, what is owed, what is free to spend, and the discount. |
| `GET /catalogue` | Whether we are selling, the networks, the smallest and largest airtime purchase, and every bundle with its code, its face value and this agent's price. |
| `POST /quote` | What a purchase would cost. Buys nothing. |
| `POST /purchase` | Buys for one customer, paid from the wallet at once. |
| `POST /purchases` | Buys for a whole list, every line or none. |
| `GET /purchase/<reference>` | How a purchase went, by our reference or the shop's own. |
| `GET /statement?from=&to=` | Every movement of the wallet between two dates. |

### Buying for one customer

```
POST /api/v1/purchase
Content-Type: application/json

{ "client_reference": "till-1-000913", "number": "08031234567", "amount": 500 }
```

Answers `201` with the purchase, or `200` with `repeated: true` if that
reference was used before. A bundle is bought by sending `"bundle":
"mtn-1gb"` instead of `amount`; the codes are in the catalogue.

The purchase comes back with its state. `paid` means the money has left the
wallet and the airtime is on its way; `delivered` means it landed;
`delivery_failed` and `held` carry the reason in `failure` or
`hold_reason`. Ask `GET /purchase/<reference>` again to follow it, or read
the same states in the portal.

### Buying for a list

```
POST /api/v1/purchases
Content-Type: application/json

{
  "client_reference": "monday-morning-1",
  "lines": [
    { "number": "08031234567", "amount": 500 },
    { "number": "08161234567", "network": "AIRTEL", "amount": 200 },
    { "number": "08031234567", "bundle": "mtn-1gb" }
  ]
}
```

Up to 200 customers in one request. Either every line is bought or none is:
if the wallet runs out on line seventeen, nothing is bought and the message
names line seventeen. The same `client_reference` sent again returns the
same list rather than buying it a second time.

## When it says no

| Code | What it means |
| --- | --- |
| `bad_key` | The key is wrong, revoked, or the agent is paused. |
| `api_off` | We have the interface switched off. |
| `agents_off` | Agent accounts are paused. Balances are safe. |
| `too_many_requests` | Too many requests this minute. `wait_seconds` says how long. |
| `missing_client_reference` | Send a reference of your own with every purchase. |
| `amount_in_naira` | An amount was sent in kobo. |
| `wallet_low` | Not enough in the wallet and the credit line. The message gives the figures. |
| `unknown_network` | The number's prefix is not one we know. Send the network. |
| `no_such_bundle` | That bundle code is not on offer on that network. |
| `retail_off` | We have selling switched off altogether. |

## What it deliberately does not do

- It does not top up the wallet. Money in is by bank transfer or Paystack,
  through the portal, so there is one path for money and it is the one a
  person can read in the ledger.
- It does not withdraw. A withdrawal is a request a person settles.
- It does not create agents or keys. Both are deliberate acts by a person.
