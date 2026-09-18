# Waiting on the founder

Every decision that only the founder can make, with the recommendation given
at the time it was asked. This file exists so that losing a conversation does
not lose the decisions. When a decision is made, move it to the "Decided"
section at the bottom with the date and the answer. Never delete a line.

Last updated: 17 September 2026, after the founder described the product.

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
