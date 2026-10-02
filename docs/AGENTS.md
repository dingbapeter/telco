# Agents

An agent is a person or a shop that brings customers. Two things, both of
which move volume in Nigeria:

- **A link and a code.** Anyone who opens the agent's link, `/a/<code>`,
  and then moves airtime or buys within thirty days counts as the agent's.
  On every transfer they make, the agent earns a share of our part of the
  fee, paid into the agent's wallet the moment the transfer completes. The
  share is a setting.
- **A prepaid wallet.** The agent pays money in, by bank transfer recorded
  by you or online by card, and buys airtime and bundles for
  walk-in customers from it at a discount, which is also a setting. The
  order is paid at once and delivered like any other. A wallet purchase
  that has to be refunded goes back to the wallet.

Commissions land in the same wallet. The agent spends them or asks to
withdraw, and you pay by bank transfer and record it on the Agents page.

## A rate of their own

The discount in Settings is the rate for every agent who has no rate of
their own. On an agent's page you can set:

- **the discount they buy at**, up to 20 percent;
- **the share of our fee they earn** on transfers they bring;
- **a credit line**, described below.

Leave a box empty and the agent goes back to the rate in Settings. This is
what lets you sign a volume buyer at a better price without moving
everybody else's. Every change is written to the audit log by the database
trigger, with your name on it, so a rate cannot be quietly moved.

## Buying for many customers at once

A shop that serves twenty people in a morning pastes a list at
`/agent/bulk`, one customer to a line, the way they would write it:

```
08031234567 500
0803 123 4567, 1,000
08161234567 airtel 200
08031234567 mtn-1gb
# my note, ignored
```

The number may be written with spaces. The amount is in naira, or the line
names a data bundle by its size or its code. The network comes from the
number and only needs saying when the customer has moved network. Up to two
hundred lines at a time.

The whole list is bought in one go or not at all. If the wallet runs out on
line seventeen, nothing is bought and the page says which line stopped it,
with the list they typed still in the box. The list's own reference is made
when the page is opened, so a second tap on a slow phone lands on the list
that already exists instead of buying everything twice. The list page then
shows each customer and refreshes itself while any of them is still on the
way.

## The statement

At `/agent/statement` the agent picks two dates and sees the opening
balance, every movement of the wallet, the closing balance, what they
bought at face value against what they paid for it, and the commission they
earned. Two files can be downloaded, the movements and the purchases, and
both open in any spreadsheet. The command centre can pull the same two
files for any agent from their page.

The statement is built from the ledger itself, not from a second set of
numbers, so it can never disagree with the books. A cell that a spreadsheet
would run as a formula is written with an apostrophe in front of it.

## Credit lines

An agent we trust can be given a limit, and their wallet may go that far
below zero. Three settings hold the reins:

- **Credit lines for agents.** Off until you turn it on. Turning it off
  stops every line being drawn on and writes nothing off.
- **Largest credit line one agent may be given.** Zero by default, so no
  credit can be given at all until you set it. A limit above it is refused
  on the agent's page.
- **Days an agent may stay owing.** Seven by default. A line that has been
  owing longer closes itself until the agent tops up enough to clear it,
  and both they and you are told so in words.

How long an agent has owed is worked out from the wallet's own postings,
which cannot be edited, so it can never drift from the books. A credit line
is money to buy airtime with, never money to take out in cash: a withdrawal
reads the wallet itself and refuses while anything is owed.

## A key for the shop's own software

A shop with a till or POS software can buy through our interface instead of
the pages. The agent makes a key at `/agent/keys`, one for each machine,
shown once and kept only as a fingerprint. See docs/AGENT_API.md for the
whole interface, and Settings, Agents for the switch and the rate per
minute.

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
- **A bulk list with a bad line.** Nothing is bought, the line is named,
  and the typed list comes back so nothing is retyped.
- **A shop's till asks for the same purchase twice** after a timeout. It
  gets the purchase it already made, not a second one.
- **A machine with a key on it is lost.** Revoke the key, in the portal or
  on the agent's page. It stops working at once.
- **An agent owes and stops paying.** Their line closes itself after the
  days you allow, and the Agents page shows what every agent owes us and
  what the total exposure is.
