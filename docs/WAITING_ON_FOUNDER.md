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

Taken as Nigeria, naira, MTN, Airtel, Glo and 9mobile, and English, because
the founder priced the example in naira and named those networks. Say so if
any of that is wrong. Number portability means a number's prefix only hints
at its network, so the sender confirms the network on screen.

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

Consumers only, or also agents and resellers who hold a float and earn a
commission. **Default:** both, because in most airtime markets agents bring
the volume. Agent features come after the consumer loop works end to end.

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

## Decided

- **17 September 2026. What the product does.** An airtime and data switch
  between Nigerian networks. A sender moves airtime from their network to a
  number on another network and pays a fee set in the command centre. The
  fee is shared between us and the network the airtime left. The founder's
  description and the resulting design are in docs/PRODUCT.md.
