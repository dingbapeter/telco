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
