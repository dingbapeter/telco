# What runs without anybody, and what does not

Asked plainly: is the whole thing run by the machine, with people only to
watch it, settle arguments and work the command centre?

**Yes for every transaction, with four exceptions, and each exception is on
purpose.** This page is the honest list, so nobody discovers an exception at
the wrong moment.

## Nobody is in the way of a transaction

Every one of these happens with no person involved, day or night, whether
anybody is logged in or not.

| What | How |
| --- | --- |
| Quoting a transfer, a sale or a purchase | The public pages work the fee and the rate out from the settings, and choose which of our SIMs receives. |
| Knowing value arrived | The Android phone forwards the network's own message. The server reads it, matches it to what was waiting, and books it. Nothing else is ever believed. |
| The books | Every movement is a double entry posted in the same database transaction as the thing it describes. Nobody types a figure anywhere. |
| Paying out airtime and data | The worker runs every fifteen seconds: through the provider where its keys are set, otherwise by dialling the network's code on our own phone. It checks by request id before ever sending again. |
| Delivering what somebody bought | The same worker, the same rules. |
| Credit for a sale | The code is made and shown the moment the value lands. |
| Agents | Their own pages, their own API, their commission booked as they sell. |
| Sending value back over a cap | Queued to the phone by itself. See docs/CAPS.md. |
| Quotes and sales that nothing arrives for | Expired every minute. |
| Data that dies on our hands | Written off as a loss the day it expires, with a line in the ledger. |
| Asking the SIMs what the network says they hold | Queued on a timer, dialled by the phone, read and compared with the books. |
| Caps, blocks, holds, the circle guard on buy-back rates | Every one of them in code, run on every quote and again on every arrival. |

## The four things a person does

**1. Cash out of the bank.** Paying a seller in cash, and settling an
agent's withdrawal, is a person making a bank transfer and recording the
reference. This is deliberate and should stay that way until the business is
much older: it is the only place money leaves for good, and a wait with a
pair of eyes on it is the cheapest fraud control there is. The holding time,
the day's cash ceiling and the seller's history are all there to make that
look take two minutes.

**2. Stock.** Somebody has to buy the airtime onto our SIMs and put money in
the provider's wallet. No network sells wholesale airtime to a program
without an agreement, so this is a person with a bank app, recorded on the
Pools page. Until there is an agreement with the networks, it stays a person.
See docs/TELCOS.md.

**3. A judgement.** Releasing something that is being held, accepting a
difference between a SIM and the books, blocking a number, stopping a credit
code, and changing any rate or cap. Each one asks for a reason and each one
is in the audit log with who did it. The machine will hold the item for ever
rather than decide one of these itself.

**4. When the phone cannot.** A payout or a return that no phone and no
provider can send ends up on the page that owns it, in plain words, for a
person to do by hand and record. This is the fallback, not the normal path.

Everything else on the command centre is reading, not doing.

## What a person is really maintaining

Not transactions. Two things:

- **The phones.** Each network's SIM sits in an Android phone running our
  app. It needs power, signal, its PIN set once, and airtime on the SIM to
  send from. A phone that goes quiet stops payouts on that network, and the
  overview page says so. It is the one piece of hardware in the product.
- **The numbers.** Every rate, fee, cap and ceiling is a setting that can be
  changed while the service runs. They shipped as a guess and they want
  watching in the first weeks.

## What could be automated later, and what should not

- Cash payouts could go through a bank transfer API. Worth doing when the
  volume makes a person slow, not before, and only behind the holding time
  and the daily ceiling that already exist.
- Buying airtime stock could be automated if a network or an aggregator
  gives us an account that sells it. That is the conversation in
  docs/TELCOS.md, not a piece of code.
- Releasing holds should not be automated. A hold exists because a rule we
  wrote could not decide. Automating the decision would delete the rule.
