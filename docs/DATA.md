# Data bundles

Data is not naira. A gigabyte costs different amounts on different networks
and expires on different days, so the product never moves "data": it moves
value at the catalogue price of a named bundle.

## The catalogue

Under Data bundles in the command centre is every bundle we deliver, sell or
accept as a gift, with its price. With the provider's keys on the server,
"Fetch from vtpass" pulls the provider's real list for a network, with the
provider's own code for each bundle, so the provider can deliver it without
a person. A bundle you edit by hand keeps your name and price through later
fetches; only the provider code is filled in. Mark a bundle "giftable" if a
sender can gift that bundle to our SIM on that network; that is what lets
it be sent to us.

## Three things a person can do

- **Receive a bundle.** The sender picks the bundle the other side should
  get. The page tells them the exact airtime to send: the bundle's price
  plus the fee, rounded up to the naira. Only that exact amount is
  accepted; a different amount is held for a person, who returns it. The
  bundle is bought from the provider by its code, or gifted by hand from
  our SIM.
- **Send a bundle.** The sender picks a giftable bundle they hold and gifts
  it to our number with the network's own gifting code. The phone bridge
  reads the network's "you have received 1GB" message and values it at the
  catalogue price of a giftable bundle of that size. The value lands in
  that network's data pool, and the other side receives airtime or a
  bundle after the fee.
- **Buy a bundle.** On the Buy airtime page, a bundle can be chosen instead
  of an amount, at its catalogue price, paid for like any order.

## Why data is harder than airtime, and what is done about it

Airtime in a pool waits; data in a pool rots. A gifted bundle can only
leave our SIM by being gifted onward to a number on the same network, if
the network allows gifted data to be gifted again, and it expires on the
bundle's validity. It cannot be sold to the provider and cannot be turned
into airtime. So every gift that lands is a lot: its size, its catalogue
value, and the day it expires. Data going out of a pool spends the lot
that expires soonest. What expires unused is written off as a loss the day
it expires, with a line in the ledger, so the Pools page never overstates
what you own. The checklist warns a week ahead, and the way out is the
discount on that network's bundles and routing its bundle deliveries to
the phone. Mark a bundle giftable only once you have checked, with a real
gift, that the network lets our SIM gift it onward; otherwise the value
can come in but never go out.

## Data pools

Gifted data sits on our SIM. In the ledger it is a data pool per network,
held at catalogue value. It leaves the pool when a person gifts a bundle
onward from that SIM, to deliver a transfer or an order by hand. The
provider never touches a data pool; it delivers from the provider wallet.
So data pools drain only by hand, the same as airtime pools.

## Settings for each network

- The data gifting code the sender dials, with `{number}` and, where the
  network needs them, `{size}` and `{pin}`. Empty means bundles cannot be
  sent from that network yet, and the sender's page does not offer it.
- How to read the network's data received message, if the built-in reading
  gets it wrong. Test it on the Phone bridge page with a real message.

## What can go wrong

- **No giftable bundle of the size received.** The message is kept for a
  person under Phone bridge with the reason. Add the bundle, then record
  the gift by hand under Airtime in.
- **The provider does not sell the bundle.** The transfer or order is left
  for a person with the reason, to gift from our SIM or to give the bundle
  a provider code.
- **A bundle withdrawn between quote and arrival.** Held for a person.
