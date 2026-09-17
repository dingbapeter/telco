# How the product works

Written on 17 September 2026 from the founder's description. This is the
plain-language design. Anything built later must agree with it, or this file
must change first.

## The idea in one line

Move airtime or data from one Nigerian network to another, for a small fee
set in the command centre, the way money moves between banks.

## Why the bank comparison only half works, and what that means for the build

Banks can move money between each other because of two things. Money is money
whichever bank holds it, and every bank in the country joined one shared
switch under the central bank's rules. Airtime has neither. Airtime on MTN is
a prepaid credit on MTN's books and is worth nothing to Airtel. There is no
shared switch, and no network has a reason to let value leave it.

So the product has two layers, and they are built in this order of value but
the reverse order of time.

**Layer one is the switch.** A ledger that records every transfer, a fee that
is split by rule between us and the network the airtime left, settlement
reports per network, and an interface a network could plug into. This is
what the business is worth. It is also what a network agreement or a licence
application would describe. It is built from the first day because the
ledger and the fee engine are the same whichever layer moves the airtime.

**Layer two is the rails.** How a transfer actually happens today without
asking any network's permission. We hold an account on every network, the
way a bureau de change holds every currency: a SIM and a float on MTN, on
Airtel, on Glo, on 9mobile.

- **Inbound.** The sender moves airtime to our number on their own network
  using that network's own transfer code. Our phone on that network receives
  the network's notification of the transfer. A small bridge on that phone
  forwards the notification to the server, which matches it to the waiting
  transfer by sender number, receiving number and amount, and marks the
  airtime as received. Nothing is ever paid out on the sender's word alone.
- **Outbound.** We send airtime to the recipient on the destination network
  through a licensed top-up provider (VTpass first; docs/PROVIDER.md) that
  returns a receipt for every transaction and takes the cost from money we
  hold with them, or from our own SIM on that network by hand when the
  provider is down.
- **The fee comes out of the airtime.** Send 500 naira on MTN with a 20 naira
  fee and the recipient gets 480 naira on Airtel. No money changes hands and
  no payment provider is needed to launch.

The user sees one product: "move airtime from MTN to Airtel". They never see
the layers.

## The pools, and why they must be kept in balance

Each network has a pool: the airtime we hold there. Every MTN to Airtel
transfer fills the MTN pool and drains the Airtel pool. When flows in both
directions are equal, the fee is pure margin. When they are not, we end up
holding airtime on the network people are leaving and short of airtime on
the network they are going to.

Two things keep the pools healthy:

- The command centre shows every pool level live, with a floor and a ceiling
  per network set at runtime, and turns red before a pool runs dry.
- A retail top-up feature sells airtime from an overfull pool for money, and
  the money buys airtime for an empty pool from the top-up provider. This is
  the valve that keeps the pools balanced and it is a second line of revenue.

## Where the fee goes

The fee on each transfer is split by rule into our share and the share of the
network the airtime left. Both percentages live in the command centre. Until
a network has signed an agreement with us, its share is set to zero and the
whole fee is ours. The ledger keeps a payable account for each network from
the first day, so that when an agreement is signed one setting changes and the
network's share starts accruing with a full history behind it. Recording a
share for a network that has not agreed to anything would be a made-up
liability, so the system does not do that.

## Data

Data is designed in from the start but launches after airtime, for reasons
that are about the networks, not about us:

- A gigabyte on MTN and a gigabyte on Airtel cost different amounts and
  expire on different days. There is no face value to move, so each bundle is
  valued at its retail price in naira and the recipient gets the nearest
  destination bundle at or below that value after the fee. The mapping is a
  table in the command centre.
- Networks let a subscriber gift or share data only to a number on the same
  network, and only from some plans. Our SIM then holds data it can share on
  but not sell as airtime, so the data pool balances differently.

Built as described, on the same core: see docs/DATA.md.

## Risks, stated plainly

- **Network terms.** Every network's transfer feature is offered for personal
  use, and a number that receives a great many transfers can be barred. The
  design treats every SIM as replaceable, caps what any one SIM receives in
  a day, and never holds more in a pool than the next few hours need. The
  cap is a setting.
- **Fraud.** A sender who claims to have sent airtime they did not send is
  paid nothing, because a transfer is only confirmed against the network's
  own notification. When the bridge is offline an administrator confirms
  by hand, with the notification in front of them, and that confirmation is
  in the audit log with their name on it.
- **Network limits.** Each network caps how much airtime a subscriber can
  transfer in a day. The product enforces the same caps so it never tells a
  person to do something their network will refuse.
- **Regulation.** The Nigerian Communications Commission has views on value
  added services. Whether and when to engage is the founder's decision. The
  switch layer is the thing a licence application would describe.

## Channels: USSD and a little data

The founder's rule: people will move the airtime by USSD, and reach us over
mobile data that may be slow, expensive or both. So:

- The sender's pages are a few kilobytes each, one cached stylesheet, no
  fonts, no images, and nothing that needs a script. A script fills in the
  network from the number as a convenience and the page works without it.
- The instruction page shows one thing large: the exact USSD code to dial,
  with the amount and our number filled in. Where the network's code has no
  PIN in it, one tap opens the dial pad with the code. Where it does, the
  page says where the PIN goes and that we never ask for it.
- The status page updates itself with a plain page refresh, which works in
  every browser and costs a few kilobytes a time.
- Numbers on the status page are masked, because the link may be shared.

Two channels are designed for and not yet built: a USSD short code of our
own, so a sender with no data at all can start a transfer from the dial
pad, which needs an aggregator and a network agreement; and text message
confirmations to the sender, which the bridge phones can send on each
network's own SIM once the app is allowed to send.

## Who uses it

- **The sender** has airtime on network A and wants airtime on network B, for
  their own number or someone else's. At launch no account is needed: a
  transfer has a reference and a status page.
- **The recipient** receives airtime. They need nothing.
- **An agent** (later) holds a float and earns a commission on the transfers
  they bring in.
- **The founder** runs everything from the command centre.

## The order of building

1. The core: money as integer kobo, a double-entry ledger, the fee engine,
   runtime settings with ranges and fallbacks, an audit log written by one
   database hook, and the transfer as a state machine. All tested against a
   real database and mutation-checked.
2. The command centre: live numbers, settings, audit log, pools, the launch
   checklist that knocks on every rail and reports what to set and where.
3. The rails: the notification bridge and its server endpoint, the top-up
   provider adapter with a health check that tries a real call, and the
   manual confirmation screen.
4. The sender's web app: quote, instructions, status, built for a mid-range
   Android phone on a weak connection.
5. Retail top-up, for the pools and for revenue.
6. Data.
7. The sending phone: the bridge app dialling the network's own codes to
   send airtime and gift bundles from our SIMs, so payouts from a pool,
   refunds and pool draining happen without a person.
8. Agents.
