# Agents

An agent is a person or a shop that brings customers. Two things, both of
which move volume in Nigeria:

- **A link and a code.** Anyone who opens the agent's link, `/a/<code>`,
  and then moves airtime or buys within thirty days counts as the agent's.
  On every transfer they make, the agent earns a share of our part of the
  fee, paid into the agent's wallet the moment the transfer completes. The
  share is a setting.
- **A prepaid wallet.** The agent pays money in, by bank transfer recorded
  by you or online through Paystack, and buys airtime and bundles for
  walk-in customers from it at a discount, which is also a setting. The
  order is paid at once and delivered like any other. A wallet purchase
  that has to be refunded goes back to the wallet.

Commissions land in the same wallet. The agent spends them or asks to
withdraw, and you pay by bank transfer and record it on the Agents page.

## Setting an agent up

1. Turn agents on under Settings, Agents, and set the commission share, the
   purchase discount and the smallest top-up.
2. Under Agents, add the agent: a name, their phone number, which is their
   login, and an email if they want receipts. The page shows their first
   password once. Give it to them; they change it on the portal.
3. The agent logs in at `/agent/login` with their phone number. Their
   pages: wallet, buy for a customer, top up, withdraw, my link, password.
4. Their link is `/a/<code>`. They can say the code aloud; a customer
   types it as `your.domain/a/<code>`.

## Money

Each wallet is its own account in the ledger, named after the agent, so
the Pools page and the audit log show every kobo that moved. The
commission is an expense line of its own. Turning agents off pauses their
logins and links and keeps every balance.

## What can go wrong

- **The agent buys more than the wallet holds.** Refused with the amount
  and the advice to top up.
- **A withdrawal for more than the wallet holds**, or on top of one already
  requested, is refused with the figure they can ask for.
- **The same top-up recorded twice.** Recorded once by its reference.
- **An agent loses their password.** Reset it on the Agents page; the new
  one is shown once and the agent is logged out everywhere.
