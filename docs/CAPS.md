# The caps, and what happens when one is hit

A service that moves value between phone numbers for a small fee is a
service for washing money, unless something stops it. Nobody has to be
clever about it: send a stolen line's airtime to twenty numbers in an
afternoon, or take one number's value out through twenty small sales, and
the trail is as good as gone.

So the product counts. Everything here is in `src/limits.ts`, in one file,
because a cap nobody can find is a cap nobody can check.

## What is counted

On a phone number, which is all we have. There is no idea of a person in
this system, and the caps do not pretend otherwise.

**A sender**, on the Transfers side:

| Cap | Where it is set |
| --- | --- |
| Most one number may move in a day | Limits, Daily limit per sender |
| Most one number may move in a week | Laundering caps, Weekly limit per sender |
| How many transfers one number may make in a day | Laundering caps |
| How many transfers one number may make in a week | Laundering caps |

**A receiving number**, on the same side:

| Cap | Where it is set |
| --- | --- |
| Most one number may be sent in a day, from everybody | Laundering caps |
| How many transfers one number may be sent in a day | Laundering caps |

**A seller**, on the Buying back side: the same four shapes, under Settings,
Buying back, counted against the line that is selling.

A day is a Lagos day. A week starts on Monday in Lagos. **A zero turns a cap
off**, and every description says so.

Every money cap counts the amount that arrived from the sender, not the
slightly smaller amount delivered after the fee, so one number's day is
measured the same way at either end of a transfer. A quote that nothing
arrived for, and value we sent back, count as nothing: neither moved.

## Why the receiving number is capped too

Money broken into small pieces across many sending lines and put back
together on one receiving line is the oldest shape in the book, and no cap
on senders can see it. The cap on the receiving number can.

It comes with a rule of its own: **a sender is never told anything about the
receiving number's day.** They are told what one number may be sent and that
this one has reached it, and nothing more. Otherwise anybody could learn how
much a stranger's line has been sent today by asking for quotes until the
message changed, and that is not theirs to learn.

## Checked twice, because the first check is not a control

A cap checked when a quote is asked for stops nobody. Anybody can send
airtime to one of our SIMs with their network's own code, having asked us
nothing, and we would have the value on our SIM with no cap having run.

So every cap runs again when value actually arrives, against the amount that
really landed, not the amount that was quoted. That second check is the one
that holds. It excludes the transfer or sale it is checking from the totals,
or a transfer made at exactly the cap would count itself and be refused, and
the one amount a cap is meant to allow would be the one it blocked.

## What happens to value over a cap

It goes back to the line it came from, by itself, and nothing is paid out.

- The value is still booked when it lands, because it really is on our SIM.
  Pretending otherwise would put the books out.
- The transfer or sale moves straight to being sent back. A phone on that
  network sends the same value to the number that sent it, which is the same
  rail a refund already uses. The books move only when the network confirms
  it has gone.
- If no phone on that network can send, it waits for a person on the
  Transfers or Buying back page, with the reason in plain words.
- The sender's or seller's own page says which cap it was and that the value
  is on its way back, so nobody has to ring anybody to find out.

Two switches, one per side, turn this off: **Send value over a cap straight
back**, under Laundering caps for transfers and under Buying back for sales.
With a switch off, the value waits on the page for a person. That is the
worse choice and the page says so: it means we are holding somebody else's
value while they wait for us.

Once something is going back, it goes back. There is no button to stop it and
buy it after all, because the phone may already have been given the command
and undoing it is how value goes out twice. If a cap is too tight, raise the
cap: the next one through will be fine.

Holds that need a judgement are never sent back automatically. A blocked
seller, or one bank account collecting for several lines, waits for a person,
because sending stolen value back to whoever sent it is not obviously the
right thing to do either.

## What the caps are not

- **Not know your customer checks.** We ask for no name, no bank
  verification number, no photograph. That decision belongs to the founder
  with a lawyer, and is in docs/WAITING_ON_FOUNDER.md. Until then these
  caps, the holding time before cash and the block list stand in its place.
- **Not a reporting regime.** Nothing here files anything with anybody.
  Every cap breach is in the audit log and on the item itself, which is what
  a report would be built from, but no report is made.
- **Not tuned.** The numbers shipped are a guess, made before a single real
  customer. An agent who does transfers for walk-in customers from one line
  will hit the daily count on a busy morning. Watch the Transfers page in
  the first week and move them. They are settings, changeable while the
  service runs, with every change in the audit log.
