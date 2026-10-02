# Retail top-up

Selling airtime for money. It does two jobs: it is the valve that turns an
overfull pool back into cash, and it is a second line of revenue.

## How it works for a buyer

The buyer opens the Buy airtime page, gives a number, its network and an
amount, and sees the price. The price is the face value less any discount
you have set for that network. They pay online through the card gateway, by
card, bank transfer or USSD, or by transferring to the bank account you enter
in Settings, with the order reference in the narration, or with a credit code
from having sold us airtime. Once the money is in, the airtime is delivered:
through the provider automatically, or from our SIM by hand from the order
page.

## Draining a pool

When MTN airtime piles up in the MTN pool because more people send from
MTN than to it, set a discount for MTN under Settings, Retail top-up. The
Buy airtime page then says "MTN airtime at 3 percent off", buyers come,
and each sale to a buyer delivered from our MTN SIM by hand moves airtime
out of the pool and money into the bank. The discount is booked as its own
expense line so you can see what draining the pool cost.

Deliveries made through the provider do not touch the pool; they come
from the provider wallet. So the pool drains only through deliveries made
from our own SIM, either by a person from the order page or by the sending
phone dialling the network's own code, which is set per network under
Settings, Guardrails. See docs/BRIDGE.md.

## The card gateway

Two are supported and the product knows about neither: pages ask whichever
gateway has its keys on the server for a page to send the buyer to, and read
the result back from that gateway before a naira is booked.

**Flutterwave** is the one in use when `FLUTTERWAVE_SECRET_KEY` is on the
server. It takes cards issued outside Nigeria as well as Nigerian ones, which
is why it was chosen: somebody in London can top up a line in Lagos, their
bank does the conversion, and we are settled in naira.

**Paystack** is used when Flutterwave's key is absent and its own is present.
It is kept rather than deleted, because a gateway nobody is using takes no
money and costs nothing to keep. With both keys set, Flutterwave is used.

Each holds its own balance in the books, because each settles to the bank
separately, and the Pools page lists both.

Three differences between them live in the adapters and nowhere else, because
each is a way to lose money quietly:

- **Flutterwave works in naira, Paystack in kobo.** A kobo figure sent as
  naira charges a hundred times too much. Both conversions are one function
  with a test of its own.
- **Flutterwave calls a settled charge "successful", Paystack "success".**
- **Flutterwave's webhook header is a fixed secret you choose, not a signature
  over the message.** Anybody who ever saw one header could forge a body
  saying any amount. So no webhook's figures are believed from any gateway:
  the amount is always read back from the gateway by our own reference. This
  is the same rule the airtime side follows about network messages.

A charge that comes back in any currency but naira is not booked at all. We
price in naira and ask for naira, so another currency means the figures do not
mean what the rest of the system assumes, and that is for a person to look at.

## Which ways a buyer may pay, and why it matters more than it looks

Under Settings, Retail top-up, "Ways a buyer may pay online" is a list of tick
boxes. Whatever is ticked is what the gateway offers the buyer, in that
gateway's own words, and each adapter does its own translation: what we call a
bank transfer is `banktransfer` to Flutterwave and `bank_transfer` to Paystack,
and what we call bank, meaning a debit straight from the buyer's account, is
`account` to one and `bank` to the other. Tick nothing and the gateway offers
whatever its own dashboard has enabled, which is the escape hatch if they add
something we cannot name.

It starts as bank transfer, USSD, card and bank: the ways people in Nigeria
actually pay. The order on the page is the gateway's business, not ours.

**The reason to care is chargebacks.** Airtime cannot be taken back off a line.
A card payment can be reversed by the payer weeks after the airtime is gone,
and the loss is ours with nothing to show for it. This is the single worst
fraud shape in this business, and it is the mirror of the one on the buy-back
side: there somebody sells us value that is not theirs, here somebody buys with
a card that is not theirs.

Bank transfer and USSD cannot be reversed. They are push payments: the buyer
moves the money themselves from their own bank. So the cheapest protection
available is to untick card, at the cost of the buyers who have nothing else.
The setting says which methods the payer can reverse, in those words, beside
each tick box.

What is deliberately not offered:

- **Mobile money as its own method.** The wallets Nigerians hold, OPay,
  PalmPay, Moniepoint and the rest, are reached by ordinary bank transfer, so
  they already work. The mobile money networks that need a method of their own,
  M-Pesa in Kenya or MoMo in Ghana, take money in another country's currency,
  which is the second currency in the ledger and a decision for the founder
  rather than a line of code. See question 33 in docs/WAITING_ON_FOUNDER.md.
- **Refusing a card because of where it was issued.** A card from London can
  pay in naira and that is a feature. Where a card is from is between the
  gateway and its own rules; what we control is the method and the currency.

## Setting up

1. Under Settings, Retail top-up, enter the bank details for transfers if
   you want to offer them. Bank transfers are confirmed by hand on the
   order page when you see them on the statement.
2. For online payment, open a Flutterwave account at flutterwave.com, get the
   secret key, and put it in `/etc/telco/telco.env` as
   `FLUTTERWAVE_SECRET_KEY` yourself, then restart the service. **The key is
   never pasted into a chat, a commit or a log.**
3. In Flutterwave under Settings, Webhooks, set the address to
   `https://your.domain/payments/flutterwave/webhook` and type a long random
   secret hash. Put the same secret in the environment file as
   `FLUTTERWAVE_WEBHOOK_SECRET`. Without it no webhook is believed, which is
   safe but means a buyer who closes the tab before coming back waits for
   somebody to look. The checklist says so in those words.
4. Turn selling on under Settings, Retail top-up. The checklist goes red
   if selling is on with no way to pay, knocks on the gateway, reads its
   balance, and warns while the keys are test keys.

The adapter is built against Flutterwave's version 3 interface, which is what
their production integrations use. They have a version 4 in public beta with a
different way of signing in; moving to it is a job of its own and nothing here
forces it.

## How the money is booked

- A payment credits the money owed to buyers and debits the bank or the
  gateway's balance, net of the gateway's fee, which is its own expense line.
- A delivery from our SIM debits the buyer's money and the discount and
  credits the pool by the face value.
- A delivery through the provider credits the provider wallet by what the
  provider charged and books their commission as revenue.
- A refund is a bank transfer you make, recorded on the order page; it
  debits the money owed to the buyer and credits the bank.
- A gateway settles to your bank on its own schedule. Record each settlement
  under Pools as money lost from that gateway's balance and added to the bank,
  and the checklist will stop warning that the two disagree.

## What can go wrong

- **Underpaid bank transfer.** The order is held and can only be refunded.
- **A webhook arrives twice, or a buyer refreshes the return page.** The
  payment is recorded once; the second time does nothing.
- **A forged webhook.** Refused: the signature or secret must match. And even
  a real one is only a nudge to go and ask the gateway what really happened.
- **Delivery fails.** Same as transfers: retried with a wait through the
  provider, or left for a person with the provider's words on the order
  page. The buyer's page says a person is looking and nothing is lost.
