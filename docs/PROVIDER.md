# The top-up provider

## What it is, in plain words

VTpass is a Nigerian company that sells airtime and data on every network
through an interface a computer can call. You open an account with them,
pay money into your wallet with them by bank transfer, and our server then
tells them "send 480 naira of Airtel airtime to 0802...". They deliver it
within seconds, take the cost from your wallet, and pay you a small
commission on each purchase. It is what the person selling recharge cards
at the roadside does, done by a machine.

For us it replaces our own SIM on the outbound side. A transfer from MTN to
Airtel then works like this: the sender dials MTN's transfer code to our MTN
phone as before; our phone sees MTN's message; and instead of a person
sending Airtel airtime from our Airtel SIM, the server asks VTpass to send
it. Nothing about the inbound side changes.

It is one provider among several in Nigeria. The code is written so another
can be added beside it; VTpass is first because its interface is the best
documented and its client libraries agree with each other.

## What to do

1. **Open an account** at vtpass.com. Use the business's name and email.
   Complete whatever identity check they ask for; they are a regulated
   payments company and will ask for it before live keys are issued.
2. **Get the keys.** In your VTpass account, find the section for API keys
   (they call the interface an API). There are three: an API key, a secret
   key and a public key. Also note that they have a sandbox, a practice
   copy of the service with play money, with its own keys.
3. **Put the keys on the server**, in `/etc/telco/telco.env`, on the lines
   already there for them:

   ```
   VTPASS_ENV=sandbox
   VTPASS_API_KEY=...
   VTPASS_SECRET_KEY=...
   VTPASS_PUBLIC_KEY=...
   ```

   Then `sudo systemctl restart telco`. The keys go in that file and
   nowhere else: not in the command centre, not in a message, not in git.
4. **Open the launch checklist.** It now has a line saying whether VTpass
   answers and accepts the keys. The check makes a real call each time the
   page opens. If it is red, the line says which key to look at.
5. **Fund the wallet** at vtpass.com by bank transfer, then record the same
   amount in the command centre under Pools, into the provider wallet. The
   checklist compares what VTpass reports with what our ledger says and
   warns when they differ.
6. **Practise in the sandbox.** With sandbox keys, make a real transfer end
   to end: quote, send airtime to the phone, watch the status page. The
   sandbox delivers pretend airtime and answers like the real thing.
7. **Turn automatic payouts on**, under Settings, Guardrails. Until then the
   provider is set up but every payout still waits for a person.
8. **Go live.** Change `VTPASS_ENV=sandbox` to `VTPASS_ENV=live`, put the
   live keys in, restart the service, fund the live wallet, record it under
   Pools, and check the checklist line is green.

## How the money is booked

Each automatic payout credits the provider wallet in our ledger by what
VTpass actually charged, which is the airtime's face value less their
commission. The commission is booked as its own line of revenue, separate
from our fee, so the Pools page shows both. If the provider's figures ever
fail to add up, the payout is refused and left for a person rather than
booked wrongly.

## What happens when things go wrong

- **VTpass says the wallet is too low.** The transfer waits and is retried
  after one, five and fifteen minutes. The transfer page and the checklist
  both say to fund the wallet. Once funded, the next try succeeds.
- **VTpass says it is still working on it.** The server asks again by the
  request id until it says delivered or failed. Nothing is sent twice.
- **VTpass never answers.** The server asks for the result by request id
  before it would ever send again, so a dropped connection cannot pay
  twice.
- **VTpass says the transaction failed.** The transfer is left for a
  person, with the provider's own words on the transfer page. A person can
  try the provider again, send by hand from our SIM, or refund the sender.
- **The attempt limit is reached.** The transfer is left for a person the
  same way. The limit is a setting.
- **In a moment of doubt**, turn automatic payouts off under Settings.
  Nothing is lost; every transfer waits for a person as before.
