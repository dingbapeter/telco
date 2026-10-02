# Buying airtime and data back

A person holds airtime or a data bundle they cannot use. We buy it from
them below what we can sell it for, and sell it on through the pages that
already exist. This is the other half of the retail business: the Buy
airtime page turns airtime into cash, and this turns cash into airtime at a
discount.

It is also the first thing in this product where our money leaves the
building, so it is built with the brakes on and every brake is a setting.

## How it works

1. The seller opens `/sell`, puts in their number and network, and says how
   much airtime, or which bundle, they want to sell. They choose credit or,
   where you have turned it on, cash.
2. They are quoted a share of what it is worth, and shown our own number on
   their network and the exact code to dial. **The rate quoted is the rate
   paid**, even if you change the setting while they are dialling: a quote
   is a promise.
3. They send it with their network's own transfer or data gifting code. No
   network lets us take value off somebody's line, which is why the seller
   always does this part themselves.
4. The network sends its own message to our SIM. The phone bridge forwards
   it, and **only that message is believed**. A text message from anybody
   else is ignored, which is what stops somebody being paid for value that
   never arrived.
5. We pay. Credit is a code, handed over the moment the value lands. Cash
   waits for the holding time and then for a person to send it by bank
   transfer and record the reference.

A sale that nothing arrives for lapses on its own and leaves nothing owed.
Value that arrives over one of the caps, or over the most we buy in one go,
goes straight back to the line it came from without anybody being asked: the
phone on that network sends it, and nothing is owed. Value held for a reason
that needs judgement, such as a number you have since blocked or one bank
account collecting for several lines, waits for a person, who either buys it
anyway or sends it back.

## Credit before cash

Credit is a code like `CR-ABCD234567`, worth what we owe. It is spent on the
Buy airtime page, for any number on any network, and it draws down: a code
worth N800 can pay for a N500 purchase and keep N300 for later. It does not
expire. Whoever holds the code can spend it, so the seller is told to keep
it safe.

Credit is the default and cash is off until you turn it on, for one reason:
**credit never leaves the business.** Somebody who buys airtime with a
stolen card and sells it to us for credit has only moved their problem
sideways. The same person paid in cash has laundered it, and we are the
laundry. Everything below exists because of that sentence.

## The circle, and the guard against it

If we ever paid more for airtime than the cheapest price somebody can buy
it from us for, the same naira could be bought from us and sold straight
back at a profit, over and over, until our float was gone. An agent on a 15
percent discount buying at 85 and selling back at 90 would do this all day,
and it would look like roaring trade.

So before any rate is used, it is compared with the cheapest share of face
value anybody can buy on that network:

- the retail discount on that network;
- the agents' standing discount;
- the best rate agreed with any one agent.

Our buying rate must sit below the lowest of those by at least the margin
you set, which is 3 percent to start with. The check runs when you save the
rate **and again when a seller asks for a quote**, because an agent's rate
agreed next month can break a rate that was safe today. When it breaks,
buying on that network pauses, the public page says we are not buying, and
the launch checklist names the discount it clashed with and the rate to set
instead.

## What it earns, and what it costs

At 80 percent on airtime: we pay N800 for N1,000 of airtime and sell it at
face value for N1,000, or N980 to an agent. That is N180 to N200 on N800
put out, which is many times the few percent a reseller makes. The catch is
not the margin, it is everything around it:

- **It is working capital, not profit, until it is resold.** Every naira
  paid out is airtime on a SIM. If selling is slow, the money is parked.
- **Data expires and the loss is the cash, not the discount.** A N600
  bundle bought for N420 and never sold costs us N420. Bought data is
  therefore recorded as expiring on the shorter of the bundle's own
  validity and what you assume a gifted bundle has left, because the
  network never tells us what is left, and the write-off is posted as a
  loss you can see on the Pools page rather than a hole in the pool.
- **Fraud will find this before your customers do.** Turning airtime into
  cash is the standard way stolen airtime and card-bought airtime are
  cashed out in Nigeria. Every control below is there for that.
- **The networks have views.** Their terms treat gifting as a thing people
  do for each other, not a wholesale channel. Nothing here breaks a
  network's code, but a line buying at volume all day is a line they may
  ask about, and that conversation belongs in the one about an aggreement
  with them. See docs/TELCOS.md.

## Every brake, and where it is

All under Settings, Buying back.

| Setting | What it holds back |
| --- | --- |
| Buy airtime back, buy data back | The whole thing, per kind. Off to start with. |
| Pay sellers in cash as well as credit | Cash. Off to start with. |
| What we pay for airtime, what we pay for data | The rate, per network. Zero means not buying that kind there. |
| Gap we keep between buying and selling | The circle guard above. |
| Smallest we will buy, largest we will buy at once | The size of one sale. |
| Most one number may sell in a day, most in a week | A single line, counted in Lagos days and from Monday. Zero turns the weekly one off. |
| Sales one number may make in a day, in a week | How many, whatever they are worth. Breaking a large amount into small sales is the first thing anybody tries. Zero turns them off. |
| Phone numbers one bank account may be paid for | Above this, a cash sale is held with the other numbers named. Zero turns it off. |
| Send value over a cap straight back | On to start with. Off means we hold value we have decided not to buy while the seller waits. |
| Shortest data validity we will take | Six months to start with. Data we cannot resell before it dies costs us what we paid for it. |
| Most we will buy in a day | The face value we will take in per network per day. Zero means not buying, so this has to be set before anything happens. |
| How long a seller has to send | How long a quoted rate is held. |
| How long we assume data gifted to us lasts | What data gifted to us is recorded as being worth for, and when it is written off. |
| Holding time before cash can be paid | How long a cash payout waits after the value lands. A day to start with. |
| Most cash we will pay out in a day | Across every seller. Zero means no cash at all, whatever the switch says. |

The four caps on a selling number are counted in `src/limits.ts`, the same
file and the same arithmetic as the caps on the transfer side, and the whole
of that thinking is in docs/CAPS.md. They are checked when a quote is asked
for **and again when value actually arrives**, because anybody can send
airtime to our SIM having asked us nothing at all.

## One bank account, many lines

The strongest signal of a ring, and the only one that does not rest on
anybody's judgement, is one bank account collecting the money for sales from
several different phone numbers.

So the ten digit account number inside what a seller types is kept on its
own, and counted. Above the number of lines you allow, the sale is **held
for you** rather than sent back, with the other numbers named on the page,
because a family really might share an account and that is a judgement, not
an arithmetic. Nothing else is read out of what they typed, and the whole
text is still shown to whoever pays.

A cash sale with no account number in it at all is refused when it is
quoted: there would be nothing to pay into, and nothing to count.

## Data we will not take

Bought data is stock. If it dies before we sell it on, we have paid cash for
nothing, so **we only take data whose catalogue validity is six months or
more**, and none at all whose validity nobody has written down, whatever the
floor says: data we cannot date is data we cannot value, cannot sell with a
straight face and cannot write off on time. The floor is a setting.

Two consequences worth knowing before you move it:

- Most Nigerian bundles are thirty days. At six months, the only data we buy
  is the long-dated kind, which is a small part of what people hold. Airtime
  is untouched by this.
- The same rule governs data gifted to us to pay for a transfer, because that
  data sits in our pool in exactly the same way.

A bundle that fails either test is offered to nobody, on the selling page or
the transfer page, because being refused after you have sent something is
worse than never being offered it. The Data bundles page marks them.

Beyond the settings:

- **Numbers we will not buy from.** On the Buying back page. A blocked
  number is refused a quote, and value already on its way in from it is
  held for you rather than bought.
- **Stopping a credit code.** When we should never have bought the value
  behind it. The reason is required, what is left on the code becomes ours,
  and the seller is told the code was stopped.
- **The seller's history.** Every screen where a payout or a release can be
  settled shows the same facts about the number: how many times it has sold
  to us, how much in all, how much it has taken, when it first appeared,
  whether it is blocked, and any other lines sharing its bank account. The
  cash queue, the held list and the sale's own page all show it, so a new
  number asking for a large payout looks like what it is wherever you meet
  it.
- **The same SIM's daily cap.** What we buy counts against the receiving
  number's daily cap along with transfers, because the network's limit
  applies to the SIM and not to our reasons for using it.

## What is deliberately not built

- **No automatic cash.** Every cash payout is a person sending a bank
  transfer and recording the reference. Nothing pays itself.
- **No know your customer checks.** We do not ask for a name, a bank
  verification number or a photograph. That is a decision for the founder
  with a lawyer, and item 26 in docs/WAITING_ON_FOUNDER.md. Until then, the
  holding time, the caps and the block list are what stand in its place,
  and cash should stay off.
- **No buying from an agent's wallet.** An agent sells to us as anybody
  else does, from their own line.
- **No holding time on credit.** Cash waits; a credit code is handed over
  the moment the value lands. Credit never leaves the business, so the cost
  of being wrong is airtime we can stop: the code can be stopped with a
  reason and whatever is left on it becomes ours. Making sellers wait for a
  code would cost us honest sales to prevent something we can already undo.
  Say the word and it becomes a setting like the others.

## What can go wrong

- **A seller sends a different amount.** We pay for what arrived at the
  rate quoted, and say so on their page.
- **A seller sends nothing.** The sale lapses. Late value inside the grace
  minutes set under Transfers is still matched and still bought.
- **Two things arrive from one number at once.** Each message is matched to
  one sale, oldest first, and the same message is never counted twice.
- **A transfer and a sale are both waiting for the same airtime.** The
  transfer wins, because somebody is waiting on the other side of it.
- **We cannot sell the data on.** It expires and the loss is posted. Watch
  the Pools page and the checklist, which warns two days before.
- **An order paid with credit has to be refunded.** The value goes back
  onto the code the buyer used, so they can spend it again at once, and no
  cash leaves the bank. A code that has been stopped cannot take it back,
  and the refund stays where the stopped money went.
- **A seller says they never got their cash.** The bank reference is on the
  sale, and the sale is in the audit log with who settled it.
- **Value is going back and the phone cannot send it.** It appears on the
  Buying back page as yours to send by hand, with the phone's own words. Take
  it over first, so it cannot go out twice, then record what you sent.
