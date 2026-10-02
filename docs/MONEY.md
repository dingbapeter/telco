# The money page

One page that answers the two questions a founder running a float business
has to be able to answer at any hour: **how much of this money is mine**,
and **did this week make any**. It is in the command centre under Money.

Every figure is read from the ledger when the page is opened. Nothing is
cached, and nothing is kept in a second table that could drift from the
books.

## What is ours right now

- **What we hold.** Airtime in each network's pool, data in each data pool
  at the price we sell it for, money in the bank, money a card gateway is holding
  for us, and the provider's wallet.
- **What we owe.** Senders whose airtime has arrived and not yet been paid
  out, buyers who have paid and not yet been delivered, sellers we have
  bought from and not yet paid, agents' wallet balances, and each network's
  share of the fees.
- **What is ours.** The first less the second, with the founder's own float
  and everything earned since named underneath.

Underneath it is a line that should never appear: if what we hold less what
we owe is not exactly what was put in plus what has been earned, the page
says so in red. A deferred trigger in the database already refuses any
journal that does not balance, so this is an alarm that should never sound.
It is kept because an alarm costs nothing and a silent hole costs
everything.

## What it earned

Pick two dates, in Lagos days, both ends included. The default is this
month so far.

**Earned** is every revenue line: our share of transfer fees, the margin on
airtime and data bought back below what we sell it for, the commission the
provider pays us, and credit stopped after a seller was blocked.

**Spent** is every cost: discounts given to buyers, commissions paid to
agents, the payment provider's fees, and value lost to failed rails, barred
SIMs or data that expired before it could be sold on.

**Held for the networks** is beside the profit and is not part of it. A
network's share of a fee is their money from the moment it is earned, and
it sits as a debt until it is settled.

Under those is a chart of each day's profit, drawn on the server as plain
shapes, so the page still needs no script and carries no written style.
Then what was actually done: transfers paid out, airtime and data sold, how
much of that was bought by agents, and how much was bought back from
people.

The whole period downloads as a file for a spreadsheet, with the same
protection against a cell being read as a formula that the agents'
statements have.

## Reading it

- **Profit that falls while volume rises** usually means a discount is too
  deep or a buying rate is too close to a selling price. The Buying back
  page and Settings, Retail top-up are where those live.
- **Losses rising** is data expiring before it could be sold. Lower what we
  pay for data, or sell it faster.
- **What we hold rising while what is ours stays flat** means the growth is
  other people's money: agents' wallets and sellers waiting. That is not a
  bad thing, but it is not profit either.
