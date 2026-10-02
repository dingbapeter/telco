# Waiting on the founder

Every decision that only the founder can make, with the recommendation given
at the time it was asked. This file exists so that losing a conversation does
not lose the decisions. When a decision is made, move it to the "Decided"
section at the bottom with the date and the answer. Never delete a line.

Last updated: 2 October 2026, after the laundering caps, the fraud controls on buying back, and the move to Flutterwave for taking card money.

## Needed before the core can be built

### 1. What the product does

Decided. See the "Decided" section and docs/PRODUCT.md.

### 2. Country, networks, currency and language

Decided: Nigeria, naira, MTN, Airtel, Glo and 9mobile, English. Number
portability means a number's prefix only hints at its network, so the
sender confirms the network on screen.

### 3. How airtime actually moves, today and at launch

Please describe how you move airtime now, if you do it at all, even by hand
over WhatsApp. The options for the build are:

- **Inbound (receiving airtime from a user).** Most networks only allow
  airtime to move by their own transfer code, to a number on the same
  network, with a per day limit and sometimes a fee. The platform therefore
  needs at least one SIM on each network, and a way to know the moment a
  transfer lands. The reliable way is a cheap Android phone holding those
  SIMs, running a small bridge that forwards each network notification to
  the server. A confirmation that is read from a notification, not assumed,
  is what protects the float.
- **Outbound (sending airtime or data).** Either from the platform's own
  SIMs by the same transfer codes, or through a licensed top-up provider's
  API. The API route is the one that scales and gives a receipt for every
  transaction.

**Recommendation, now the design in docs/PRODUCT.md:** outbound through a
licensed top-up provider, inbound by network transfer to the platform's
numbers with a notification bridge, and a manual confirmation screen in the
command centre for the day the bridge is offline. Still needed from you:

- Which top-up provider you have or want an account with. VTpass is the
  best documented in Nigeria and is the default adapter I will build first.
- Whether you have, or will buy, one Android phone per network to hold the
  receiving SIMs. The bridge is a small app that runs on it.
- Whether any network has ever spoken to you about an agreement. If not,
  every network's fee share starts at zero.

### 4. How money comes in and goes out

The fee comes out of the airtime, so no payment provider is needed to
launch. Money enters when we buy airtime for an empty pool from the top-up
provider (a bank transfer to their wallet, done by you) and when we sell
airtime from an overfull pool as retail top-ups. For the retail side a
payment provider is needed and that is a later decision.

**Recommendation:** launch without one. When retail top-up is built, use a
Nigerian provider that supports bank transfer and cards, and keep our own
ledger as the source of truth for every balance.

## Needed soon, but I will take a default and carry on

### 5. Who uses it

Consumers and agents, both built. Three settings are yours under Settings,
Agents: whether agents are on, their share of our fee, and their purchase
discount. Defaults: off, 20 percent of our part of the fee, 2 percent off.

### 6. Channels

Web app first, or USSD, WhatsApp or SMS as well. **Default:** a mobile
web app that installs to the home screen and works on a weak connection.
USSD needs a short code agreement with each network and is parked until you
have one.

### 7. Hosting

Where it will run. Your working method mentions a hosting panel and a mail
bridge on your own machine from the last project. **Default:** a single
Linux server with Postgres on it, deployed by pulling from this repository
and restarting a service. No secrets pass through me at any point.

### 8. Technology

**Default:** Node.js with TypeScript, Postgres, pages rendered on the server
with a small amount of JavaScript kept in the repository, tests run with the
Node test runner and Playwright, all in CI on every push. One language
everywhere keeps the code readable by the next person. If the last project
used something different and you want the two to match, say so.

### 9. How the business earns

A spread on the rate, a fixed fee, or both. **Default:** a rate table per
network pair and a fee percentage, all changeable from the admin panel with a
floor, a ceiling, a fallback and an audit entry.

### 10. Name, domain and brand

The product name, the domain, and any colours or logo you already have.
**Default:** the working name "Telco" until you give me the real one.

### 11. Limits and rules

Per user daily limits, whether identity is checked before larger amounts, and
whether you have read each network's terms on airtime resale. I want to be
forthright here: some networks treat accounts that receive many transfers as
resale and suspend them. The design above keeps the platform's SIMs
replaceable and its ledger independent, but the risk is commercial, not
technical, and it is yours to weigh.

### 12. The fee rule at launch

The example was 20 naira on a 500 naira transfer. The engine supports a
percentage, a flat amount, a floor and a ceiling, per network pair, all
changeable at runtime. **Default until you set it:** 4 percent, floor 20
naira, ceiling 200 naira, network share zero.

### 13. Transfer limits at launch

Minimum and maximum per transfer and per sender per day. **Default:** 100
naira minimum, 10,000 naira maximum per transfer, 20,000 naira per sender
per day, all runtime settings. Each network's own daily transfer cap will be
entered in the command centre when you confirm it from the network's
current terms, because those caps change and I will not guess them.

### 14. Hosting and the domain, now needed

The command centre is ready to run. To put it on a server I need to know
where: the provider, whether Postgres is already there, and the domain name
the command centre will answer on. I will give you the commands to run and
never ask for the login. **Recommendation:** one small Linux server from a
provider with a Lagos or European region, Postgres on the same machine,
the service under systemd, and Caddy in front for the certificate.

### 15. A USSD short code of our own

Today a sender needs a little data to open our page, and dials their own
network's USSD code to move the airtime. A short code of our own (a sender
dials, say, *347*88# and follows a menu) would let people with no data
start a transfer, but it needs a USSD aggregator and, through them, each
network's agreement, with a monthly cost. **Recommendation:** launch with
the web page, watch how many senders drop off before dialling, and decide
on a short code from that number.

### 16. Text message confirmations

The bridge phones could text the sender on each network's own SIM when the
airtime is delivered, at the network's ordinary SMS rate on that SIM. The
app would need the permission to send messages. **Recommendation:** yes,
after the first real transfers, once the pattern of what senders ask is
known.

### 17. The networks: licence, aggregator, negotiation

See docs/TELCOS.md. Three decisions are yours and none blocks launch:
whether to apply for a VAS licence now or operate under an aggregator's;
which aggregator to approach for airtime charging and top-up; and the
terms you will and will not accept, since a content-style revenue share
would consume the fee. **Recommendation:** operate under an aggregator's
licence first, approach the aggregator with three months of real volume
from the rails, and hold the line that this is a transfer product.

The founder wants to revisit all of this properly. Optasia and the airtime
credit market are written up at the end of docs/TELCOS.md for that
discussion.

### 18. Payment provider for retail

Paystack is built in on my recommendation: bank transfer, card and USSD,
good documentation. Bank transfer by hand works without it. **Needed from
you:** a Paystack account and its secret key on the server, when you want
online payment. Test keys are flagged on the checklist.

### 19. A phone that sends airtime by itself

Built, at the founder's request; see docs/BRIDGE.md. Two things are
yours when the phones are in service: allow sending and enter the SIM's
PIN on each phone, and choose under Settings, Guardrails which networks
pay out from the phone rather than the provider.

### 20. The product's name

The founder asked for a coinage made of airtime, data and transfer or
exchange. Suggested on 17 September 2026, in order of preference:
**Airdax** (AIR-time, DA-ta, eXchange; said AIR-dax), then Airdex,
Airdatex, Adex. Checked against the web only: Airdax turns up nothing;
Airdex is two industrial companies abroad, pallets and heating, nothing in
payments or telecoms; Airdatex turns up nothing; Adex is a common
abbreviation used by many. Earlier plain-word suggestions, for the record:
Crossline, Airswitch, Swapline, Crossair. Checked against the web only: Crossline
turns up one household textiles trademark abroad and nothing in payments
or telecoms; Anyline is an existing software company and Lineswap is
already three products, so both are out. Domain registries are blocked
from the build machine, so the .ng and .com checks and a Nigerian
trademark search are yours, or your lawyer's, before anything is printed.
The working name stays Telco in the code until you choose.

### Everything parked for one deployment

The founder will do all of the following at once: the server details and
deployment (docs/DEPLOY.md), the VTpass account and keys
(docs/PROVIDER.md), the Paystack account and key (docs/RETAIL.md), the
phones and their set-up (docs/BRIDGE.md), the transfer and gifting codes
and caps under Settings, and the name. Nothing in the build waits on any
of it.

### From the security reading, 20 September 2026

Everything the reading found in the code is fixed and held by tests. Four
things need you, and they are all part of the one deployment above.

1. **Who each network's messages come from.** A message about airtime is
   now believed only when it comes from one of the names that network sends
   from. The settings start with MTN, Airtel, Glo and 9mobile. The moment
   your SIMs are live, send yourself a small transfer on each network and
   look at the Airtime in page: if a real message was kept for a person
   with a note naming the sender, add that name under Settings, Networks,
   who the network's messages come from. Until a name is right there, that
   network's transfers wait for you rather than paying out.

2. **Sign the phone app with your own key.** The app CI builds is now a
   release build and unsigned, because a debug build can be read by anyone
   who plugs the phone into a computer, which would hand them the PIN and
   the token. docs/BRIDGE.md has the two commands. Make the key once, keep
   the file, and never give it to a server, to this repository, or to me.

3. **The data gifting code uses the bundle's name where the network wants a
   plan code.** A dialling string cannot carry spaces, so a code like
   `*141*{number}*{size}#` will not work as it stands on a real SIM. When
   you have a phone in hand, dial the gifting code by hand once, see what
   the network actually asks for, and set the code to match.

4. **Old sessions.** A command centre session lasts a fortnight and an
   agent session a month, and nothing signs anyone out for being idle. For
   a shop phone or a laptop left on a counter that may be too long. Say a
   number and it becomes a setting; my recommendation is to leave it until
   you have real staff, because signing yourself out every day while you
   are the only user is a cost with no gain.

### 21. The rate card for agents

An agent's discount and their share of our fee can now be set per agent,
with the rate in Settings as the default for everyone else. Nothing is
blocked: the defaults, 2 percent off purchases and 20 percent of our fee,
stand until you change them. **Needed from you, when you start signing
shops:** the rate card you will offer, and at what monthly volume each step
applies. **Recommendation:** three steps, for example 2 percent at any
volume, 3 percent above two hundred thousand naira a month and 4 percent
above a million, reviewed monthly from the statements the product now
produces. Set each agent's own rate by hand on their page after you have
seen a month of their figures, rather than promising a step in advance.

### 22. Credit for agents

Built and switched off. Three numbers are yours, under Settings, Agents:
whether credit is on at all, the largest line one agent may be given, and
how many days an agent may stay owing before their line closes itself.
**Recommendation:** leave credit off until launch has settled. Then turn it
on with a small ceiling, for example twenty thousand naira, seven days, and
give a line only to a shop with three months of steady top-ups behind them.
Every naira lent is money we have already paid the networks for and cannot
get back if the shop walks away, so treat a line as a loan, not a
discount. The Agents page shows what every agent owes and the total at
risk.

### 23. The interface for an agent's own software

Built and switched off. See docs/AGENT_API.md. **Needed from you:** the
decision to open it, and to whom. **Recommendation:** open it for a shop
only after they have bought through the pages for a month, so the first
integration is with somebody whose volume you already know. The switch and
the requests a key may make each minute are in Settings, Agents.

### 24. Cash for sellers, or credit only

Buying airtime and data back is built and switched off. Credit is built to
be the default: a code the seller spends with us, which never leaves the
business. Cash by bank transfer is built too, and off.

**Recommendation: open with credit only.** Credit cannot be used to turn
stolen value into money, which is the whole reason anybody would attack
this. Watch who sells, for a month. Then, if you want cash, turn it on with
the smallest ceiling you can live with, a holding time of a day, and a rule
that you look at every seller's history before settling. The product gives
you all four.

**If you do want cash from day one**, say so and I will tell you what else I
would build first: a name check against the line's registration, and a
second approver above an amount.

### 25. What we pay for airtime and data

Set per network under Settings, Buying back. The defaults are 80 percent of
face value for airtime and 70 percent for a bundle, with a 3 percent gap
kept below the cheapest price anybody can buy from us.

**Needed from you:** the rates you actually want, and the daily ceiling for
how much we are willing to hold. The ceiling starts at zero, which means
nothing is bought until you set it. **Recommendation:** start at 75 percent
for airtime and 65 percent for data on one network only, with a ceiling of
fifty thousand naira a day, until you know how fast you can sell it on
again. The margin is not the problem; being left holding stock is.

### 26. Know your customer, and the regulator

We buy value from a person and give them money. Nothing in Nigerian law
makes that a payment service, and we are not holding anybody's funds, but
paying cash for value bought with somebody else's card is the shape money
laundering takes, and the questions a bank or the Nigerian Financial
Intelligence Unit would ask start there.

**Needed from you, with a lawyer, before cash is switched on:** whether we
must identify a seller above an amount, what records to keep and for how
long, and whether our bank needs telling what this account does.
**Recommendation:** credit only until that advice is in hand; it keeps the
question academic. When you do ask, ask about three things: the threshold
for identifying a seller, the reporting duty on a suspicious pattern, and
whether reselling gifted airtime needs anything we do not already have.
This is next to item 17, the networks and the licence, because the same
lawyer should answer both.

### 27. The balance code for each network, and how far apart is too far

The server can now ask each SIM what the network says it holds and put that
beside the books. **Needed from you:** the balance code each network uses,
under Settings, Networks, which you can read off the SIM pack or by dialling
it yourself; and the difference worth worrying about, under Settings, Pools.
**Recommendation:** enter the codes as soon as the SIMs are in the phones,
set the checking interval to every sixty minutes, and start with a hundred
naira as the figure that turns the checklist red. A SIM used for ordinary
calls drifts, so zero would cry wolf.

### 28. Who else gets a login, and as what

Staff logins exist and everybody who has one today is a founder.
**Needed from you:** who else should be able to get in, and whether each of
them is staff or a founder. **Recommendation:** nobody but you until there
is a second person, then staff for anybody doing the day's work, and a
second founder only when you want somebody who can change prices while you
are away. Keep two founders once you have staff: it is the only way back in
if you lose your own password, apart from the server itself.

### 29. The data validity floor is set to six months, and that is most data

**What is built.** We take in no data bundle whose catalogue validity is
shorter than the floor under Settings, Buying back, and none at all whose
validity is blank. The floor starts at 180 days, which is the six months you
asked for. The rule covers both ways data reaches us: sold to us, and gifted
to us to pay for a transfer, because the exposure is the same.

**What it costs.** Most Nigerian data bundles are thirty days. At 180 days the
only data we take in is the long-dated kind, which few people hold, so in
practice this turns data buying and data-paid transfers down to a trickle.
Airtime is untouched.

**What I need from you.** The number. Three sensible answers:

- **180 as it stands.** Only long-dated data, almost no volume, almost no
  expiry losses. The safest.
- **30.** We take the ordinary monthly bundles, which is where the volume is,
  and accept that data unsold in a month is a loss. The assumption of what a
  gifted bundle has left on it should then come down too.
- **Two numbers.** A long floor for data we buy for credit or cash, and a
  shorter one for data gifted in to pay for a transfer, which turns over
  faster. This is the only one of the three that needs code.

Until you say, it stays at 180.

### 30. The caps are a guess, and an agent working from one line will hit them

**What is built.** Four caps on a sending number, two on a receiving number,
four on a selling number, all in docs/CAPS.md, all changeable while the
service runs. They ship at: N20,000 a day and N100,000 a week per sender, ten
transfers a day and thirty a week per sender, N20,000 and ten transfers a day
per receiving number.

**The problem.** Those numbers were chosen with no customers to look at. A POS
agent doing transfers for walk-in customers sends them all from their own
line, so ten a day is a busy morning and then they are stopped, with a message
telling them to come back tomorrow.

**The options.** Raise the counts for everybody, which weakens the control for
everybody. Or let an agent's own transfers be counted against their own,
higher caps, which is maybe twenty lines of code and one more number per agent
on the Agents page. Or leave it and watch the Transfers page in the first
week.

**What I need from you.** Whether agents working from one line are a real part
of the plan. If they are, say so and I will build the per-agent caps before
launch rather than after the first complaint.

### 31. Credit is handed over at once, with no holding time

Cash waits for the holding time you set. A credit code does not: it is made
the moment the value lands. The reasoning is that credit never leaves the
business, so being wrong costs us airtime we can still stop, and the code can
be stopped with a reason at any time with whatever is left on it becoming
ours. Making every honest seller wait for a code would cost real sales to
prevent something that is already reversible.

If you would rather credit waited too, say so: it is one setting and a step in
the worker, about half a day's work, and the seller's page would show when
their code appears.

### 32. Prices in naira only, or real foreign currency pricing

**What is built.** Flutterwave is now the card gateway, so a card issued
anywhere works. We ask for naira, the buyer's own bank does the conversion at
its rate, and we are settled in naira. A charge that comes back in any other
currency is refused rather than converted on a guess. Nothing in the ledger
changed, because every figure that reaches it is still naira.

**What is not built.** Showing a price in pounds or dollars on our own page,
holding a balance in that currency, or paying anybody out in one. That is a
second currency in the books: a rate to choose and store, a gain or loss when
the rate moves between the sale and the settlement, and a decision about who
carries that risk. It is perhaps a fortnight of work and it changes the money
pages, the report and the ledger.

**What I need from you.** Which of the two you meant by accepting
international currencies. If it is the first, nothing more is needed. If it is
the second, say so and say who should carry the rate risk: the buyer, by
pricing in naira and letting their bank convert, which is what happens now; or
us, by quoting a fixed foreign price and absorbing the movement. Diaspora
top-up is a real market and the second version reads better on a page, so this
is a commercial decision, not a technical one.

### 33. Paying out through Flutterwave, in or out of Nigeria

Flutterwave can also send money, which is the other half of what you
mentioned. Nothing uses it: paying a seller their cash and settling an agent's
withdrawal are still a person making a bank transfer and recording the
reference, deliberately, because that is the only place money leaves for good
and a wait with eyes on it is the cheapest control there is. See
docs/AUTOMATION.md.

If you want those automated, the holding time, the day's cash ceiling and the
seller history all stay in front of it, and the sensible order is: watch a few
weeks of real payouts by hand first, then automate the ones that are already
routine. Say the word and I will build it behind those same brakes.

## Decided

- **17 September 2026. Country and networks.** Nigeria, naira, MTN,
  Airtel, Glo and 9mobile, English. Confirmed by the founder.
- **17 September 2026. Fees and limits.** Decided in the command centre by
  the founder, whenever they choose; the defaults stand until then.
- **17 September 2026. The phone bridge.** Build it. Built; see
  docs/BRIDGE.md.
- **17 September 2026. Hosting.** The founder already has a server and a
  domain. Still needed from them: the provider, whether Postgres is on the
  machine, and the domain name, when they are ready to deploy.
- **17 September 2026. The top-up provider.** VTpass, on my
  recommendation; the founder asked for the adapter and a guide. Built; see
  docs/PROVIDER.md. Automatic payouts are off until the founder has an
  account, keys on the server, and turns the switch on. How the founder
  moves airtime today is still to come and changes nothing in the build.
- **17 September 2026. What the product does.** An airtime and data switch
  between Nigerian networks. A sender moves airtime from their network to a
  number on another network and pays a fee set in the command centre. The
  fee is shared between us and the network the airtime left. The founder's
  description and the resulting design are in docs/PRODUCT.md.
