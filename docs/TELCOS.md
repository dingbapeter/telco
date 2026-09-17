# How the networks come on board

## The honest starting point

The product runs without the networks' agreement, and does today: the
sender uses their own network's transfer feature, and we pay out through a
licensed top-up provider. What we cannot have without the networks is
durability at scale. The rails depend on features the networks offer for
personal use, with daily caps, and a SIM that receives thousands of
transfers can be barred. So the networks are not a precondition for
launch. They are the precondition for the business being worth what the
founder wants it to be worth, and for the fee split to become real money.

## The path, in order

1. **The regulator.** The Nigerian Communications Commission licenses
   value added services. Charging subscribers' airtime for a service is
   done under a VAS licence, our own or a licensed aggregator's. Apply
   early. The switch layer of this codebase (the ledger, the fee split,
   the settlement statements) is what the application describes.
2. **The door in is an aggregator, not a bilateral deal.** The networks
   connect partners through VAS aggregators who already hold approved
   connections to all four networks for the two products we need:
   charging a subscriber's airtime with their consent (our inbound leg
   without the dial code) and topping up a number (our outbound leg). An
   aggregator connection is the real "network agreement" for the first
   year or two. Its interface plugs in beside the phone bridge and the
   top-up provider; the transfer machine does not change.
3. **The pitch.** When airtime leaves MTN through us, MTN has already been
   paid for it, and it is still spent on MTN's network by whoever we sell
   it to on the way back. The network loses nothing, gains a share of
   every fee, and gets the interoperability the regulator keeps asking
   for. The share is a setting in the command centre, at zero until they
   sign, and the settlement page shows what they would have earned.
4. **What they will ask to see.** Volume, a ledger, and a settlement
   statement per network. The Settlement page in the command centre is
   that statement: transfers out of the network by month, fees, their
   share, what has been paid, and what is owed now.
5. **The price of the deal.** Networks and aggregators typically keep a
   large share of airtime-billed revenue for content services. A transfer
   product must be negotiated as a transfer, not as content, or the fee is
   gone. That negotiation is the founder's, and it is the biggest
   commercial risk in the plan.

## What is built for it now

- The fee share per network, changeable at runtime, audited.
- A payable account per network in the ledger, accruing on every completed
  transfer at the set share, with the shares rounded down so the platform
  never owes a kobo it did not agree to.
- The settlement statement per network and the recording of payments.
- The state machine, which does not care whether the inbound leg came from
  a dial code, a phone's message, or an aggregator's charge.

## Optasia and the airtime credit market, for the discussion to come

Looked at on 17 September 2026 at the founder's request. Optasia, formerly
Channel VAS, is the engine behind "borrow airtime" on most African
networks: MTN's XtraTime and Airtel's Extra Credit in Nigeria among them.
The network advances its own airtime, at almost no cost to itself, to a
subscriber Optasia's scoring says is good for it. The subscriber pays a
service fee taken up front (15 percent on MTN Nigeria: borrow 100 naira,
receive 85) and the advance plus fee is deducted from the next recharge.
The network keeps the customer and does the collecting; Optasia runs the
engine and takes an agreed share of the fee, reported at about a quarter.
The group listed in Johannesburg in November 2025, made about 265 million
dollars in 2025, and now earns most of its money from cash microloans on
the same rails, with airtime credit as the way in.

In Nigeria in 2026 the model met its regulator. New consumer lending rules
from the Federal Competition and Consumer Protection Commission led to a
two-month suspension of airtime credit on every network, court cases, and
the approval of nine Nigerian firms to offer airtime and data advances,
ending a twelve-year exclusivity. Nigeria fell from about 14 percent of
Optasia's revenue to under 4 percent in one quarter.

What it means for us, in short: the shape of our pitch to the networks is
proven (the network keeps the customer and the collection, the partner
brings the engine, the fee is shared); the nine approved Nigerian firms
are the most realistic door in, because they hold or are getting the
network connections we need and lack a product like ours; the 15 percent
people already pay to borrow airtime says our transfer fee has room; and
lending ourselves is not for now, because without a network's deduction
from the next recharge there is no way to collect, and the lending rules
would make us a regulated lender carrying credit risk on a thin fee.
