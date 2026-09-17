# Retail top-up

Selling airtime for money. It does two jobs: it is the valve that turns an
overfull pool back into cash, and it is a second line of revenue.

## How it works for a buyer

The buyer opens the Buy airtime page, gives a number, its network and an
amount, and sees the price. The price is the face value less any discount
you have set for that network. They pay online through Paystack, by card,
bank transfer or USSD, or by transferring to the bank account you enter
in Settings, with the order reference in the narration. Once the money is
in, the airtime is delivered: through the provider automatically, or from
our SIM by hand from the order page.

## Draining a pool

When MTN airtime piles up in the MTN pool because more people send from
MTN than to it, set a discount for MTN under Settings, Retail top-up. The
Buy airtime page then says "MTN airtime at 3 percent off", buyers come,
and each sale to a buyer delivered from our MTN SIM by hand moves airtime
out of the pool and money into the bank. The discount is booked as its own
expense line so you can see what draining the pool cost.

Deliveries made through the provider do not touch the pool; they come
from the provider wallet. So the pool drains only through deliveries made
from our own SIM, which today means by hand. A phone that can send airtime
by itself is on the list of things to build (see docs/WAITING_ON_FOUNDER.md).

## Setting up

1. Under Settings, Retail top-up, enter the bank details for transfers if
   you want to offer them. Bank transfers are confirmed by hand on the
   order page when you see them on the statement.
2. For online payment, open a Paystack account at paystack.com, get the
   secret key, put it in `/etc/telco/telco.env` as `PAYSTACK_SECRET_KEY`,
   and restart the service. In Paystack's settings, set the webhook address
   to `https://your.domain/payments/paystack/webhook`. The launch
   checklist knocks on Paystack and says whether it answers. Test keys
   are flagged on the checklist so you cannot forget to switch.
3. Turn selling on under Settings, Retail top-up. The checklist goes red
   if selling is on with no way to pay.

## How the money is booked

- A payment credits the money owed to buyers and debits the bank or the
  Paystack balance, net of Paystack's fee, which is its own expense line.
- A delivery from our SIM debits the buyer's money and the discount and
  credits the pool by the face value.
- A delivery through the provider credits the provider wallet by what the
  provider charged and books their commission as revenue.
- A refund is a bank transfer you make, recorded on the order page; it
  debits the money owed to the buyer and credits the bank.
- Paystack settles to your bank on its own schedule. Record each
  settlement under Pools as money lost from Paystack and added to the
  bank, and the checklist will stop warning that the two disagree.

## What can go wrong

- **Underpaid bank transfer.** The order is held and can only be refunded.
- **A webhook arrives twice, or a buyer refreshes the return page.** The
  payment is recorded once; the second time does nothing.
- **A forged webhook.** Refused: the signature must match your secret key.
- **Delivery fails.** Same as transfers: retried with a wait through the
  provider, or left for a person with the provider's words on the order
  page. The buyer's page says a person is looking and nothing is lost.
