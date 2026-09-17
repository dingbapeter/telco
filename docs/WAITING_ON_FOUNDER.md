# Waiting on the founder

Every decision that only the founder can make, with the recommendation given
at the time it was asked. This file exists so that losing a conversation does
not lose the decisions. When a decision is made, move it to the "Decided"
section at the bottom with the date and the answer. Never delete a line.

Last updated: 17 September 2026.

## Needed before the core can be built

### 1. What the product does, in one sentence

The repository says "Telco airtime and data inter-network transfer". That can
mean three different products:

- **Airtime swap.** A person holding airtime on network A gets airtime or data
  on network B, or cash, at a published rate. The platform receives the
  airtime on its own number and pays out from its own float.
- **Universal top-up.** A person pays money and receives airtime or data on
  any network. This is a well served market with thin margins.
- **Peer transfer across networks.** A person on network A sends airtime to a
  friend on network B. This is the airtime swap with a different recipient.

**Recommendation:** build the airtime swap, with the recipient allowed to be
someone else. It is the only one of the three that networks do not already
offer, so it is where the value is. Universal top-up can be added later as a
payout option, because the outbound side of a swap is a top-up anyway.

### 2. Country, networks, currency and language

Everything depends on this: number formats, the transfer codes each network
uses, which payment providers exist, what the regulator allows, and which
language the interface speaks.

**Recommendation:** one country to start, all of its main networks, and
whichever language its users type in. A second country is a configuration
job once the first one is earning.

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

**Recommendation:** outbound through a licensed top-up provider in your
country, inbound by network transfer to the platform's numbers with a
notification bridge, and a manual confirmation screen in the admin panel as
the fallback for the day the bridge is offline. Tell me which providers you
already have an account with, if any.

### 4. How money comes in and goes out

If cash payouts or cash purchases are part of the product, which payment
method do users have: mobile money (and which operator), bank transfer, or
cards. Which payment provider do you have, or want, and is the business
registered in a way that lets you open a merchant account.

**Recommendation:** one provider that covers mobile money in the chosen
country, and our own ledger from the first day, so that what any person is
owed is known from our records and never from the provider's dashboard.

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

## Decided

Nothing yet.
