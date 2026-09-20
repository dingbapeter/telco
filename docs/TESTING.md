# Testing record

Every suite in this repository is mutation-checked before it is trusted: the
thing it guards is broken on purpose, one way at a time, the suite is confirmed
to go red, and the breakage is put back. This file records what each check
caught. When a mutation does not turn a check red, the finding is written here
before anything is changed.

## How to run everything

```
npm run check
```

That runs the prose check, the typecheck and the test suite. The suite needs
Postgres. Without `DATABASE_URL` it uses the local cluster and a database named
`telco_test`, which it drops and rebuilds from the migrations on every run,
applying them twice to prove they are safe to repeat. It refuses to reset any
database whose name does not end in `_test`.

The mutation check is a script in the repository and runs in CI on every push:

```
node scripts/mutation-check.ts
```

It applies each breakage listed in the script, runs the suite that should
catch it, restores the file, and fails if any breakage left the suite green.

## Core suites (money, fees, settings, ledger, transfers, migrations)

Checked on 17 September 2026. Thirty breakages, all caught after two test
gaps were closed. The full list is in `scripts/mutation-check.ts`; the ones
that matter most for money:

| Breakage introduced | Result |
| --- | --- |
| The fee floor or ceiling no longer applied | Red |
| The fee allowed to swallow the whole amount | Red |
| The network's share rounded to nearest instead of down | Red, after the gap below was closed |
| A setting written without checking its range | Red |
| An invalid stored setting used instead of the fallback | Red |
| The application's journal balance check removed | Red, on the application's own message |
| The database's journal balance trigger disabled | Red, on the test that bypasses the application |
| A journal posted twice under the same key booked twice | Red |
| Ledger postings made editable | Red |
| The audit hook dropped from the settings table | Red |
| The audit log ignoring who made the change | Red |
| A state change no longer conditional on the current state | Red, on the two-workers and paid-twice tests |
| The same notification processed a second time | Red |
| The pool balance, approval threshold or daily ceiling no longer checked | Red, one test each |
| The sender's daily limit ignored, or expired quotes counted against it | Red |
| Late airtime in the grace period not matched, or the grace period never ending | Red |
| The fee not recomputed on the amount that actually arrived | Red |
| The network's share never booked | Red |
| A refund booked against the wrong pool | Red |
| A transfer held below the minimum allowed to be released | Red |
| A receiving number at its daily cap still chosen | Red |
| The network's own daily transfer cap ignored | Red |
| The migration runner recording nothing | Red, after the gap below was closed |
| Numbers with a country code rejected | Red |

### Mutations that did not turn a suite red, and what was found

- **Network share rounding.** The test used a fee of 2001 kobo at a quarter
  share, which is 500.25 kobo. Rounding to nearest and rounding down both
  give 500, so the test could not tell them apart. Not a second defence: a
  gap. The test now uses 2002 kobo, which is 500.5, where the two rules
  differ. Rounding down is the rule because we never accrue a kobo to a
  network that we do not owe.
- **Migration runner recording nothing.** The rerun test deletes the record
  of applied migrations before running them again, so it could not see
  whether the runner writes the record at all. Not a second defence: a gap.
  A test now checks that every migration is recorded after a run and that a
  second run applies nothing.

## Command centre suite (`tests/admin.test.ts`)

Runs a real server on a random port and drives it the way a browser would,
with cookies and without following redirects. Checked on 17 September 2026.

| Breakage introduced | Result |
| --- | --- |
| The login wall removed | Red |
| The form token no longer checked | Red |
| Any password accepted for a real administrator | Red, after the gap below was closed |
| Logging out leaving the session alive on the server | Red, after the gap below was closed |
| Page values written without escaping | Red |
| The pools form booking twice on a double submit | Red |
| The checklist green without a receiving number | Red |

### Mutations that did not turn the suite red, and what was found

- **Any password accepted.** The wrong-password test used an email with no
  account, so the refusal came from the missing account and the password was
  never compared. A gap. The test now creates a second administrator and
  tries a wrong password against it, and a separate test keeps the check
  that an unknown email is refused with the same message.
- **Logout keeping the session.** The test checked that the next request was
  turned away, but the browser had already dropped the cookie, so a server
  that kept the session would have passed. A gap. The test now counts the
  sessions on the server before and after.

## Phone bridge suite (`tests/bridge.test.ts`)

Drives the endpoint the phone app calls, with a device token, and the
command centre page for phones. Checked on 17 September 2026.

| Breakage introduced | Result |
| --- | --- |
| The phone's token no longer checked | Red, after the gap below was closed |
| The same message from a phone recorded twice | Red |
| The founder's custom reading pattern ignored | Red |
| An unreadable airtime message dropped instead of kept for a person | Red |
| The phone's report not recorded, so it looks quiet | Red |
| The token stored in clear instead of hashed | Red |

Mutation that did not turn the suite red, and what was found: the
wrong-token test ran with no phones registered, so a server that accepted
any token still found nothing to accept. A gap. The test now registers a
phone first.

The Android app itself is compiled by CI on every push (the "Phone bridge
app" job) and the installable file is published as a build artifact. There
is no automated test on the phone; docs/BRIDGE.md describes the check a
person does with a real transfer.

## Sender's pages suite (`tests/public.test.ts`)

Drives the public pages the way a phone browser would. Checked on 17
September 2026, all six breakages caught first time.

| Breakage introduced | Result |
| --- | --- |
| Sender's numbers shown in full on the status page | Red |
| A flood of quotes no longer slowed | Red |
| A form filled by a bot accepted | Red |
| An expired quote still telling the sender to send | Red |
| The dial code showing a placeholder instead of the amount | Red |
| The network suggestion from the prefix broken | Red |

The suite also holds each page under a size limit, so a change that makes
the pages heavy for a weak connection fails the build.

## Provider and automatic payouts suite (`tests/rails.test.ts`)

Runs a stand-in for VTpass that answers the way their interface does, and
drives the client and the payout worker through every answer the provider
can give. Checked on 17 September 2026.

| Breakage introduced | Result |
| --- | --- |
| Automatic payouts running while the switch is off | Red |
| The attempt limit ignored | Red |
| An unanswered payout sent again instead of checked by request id | Red |
| The provider's commission not booked | Red |
| Provider figures that do not add up booked anyway | Red |
| A failure the provider calls final retried anyway | Red |
| A low wallet read as a final failure | Red |
| The request id missing the Lagos timestamp the provider requires | Red |
| The wrong service id for 9mobile | Red |
| The wallet balance not checked before sending | Red |

## Retail suite (`tests/retail.test.ts`)

Runs stand-ins for Paystack and VTpass and drives orders from the buyer's
page through payment, delivery, holds and refunds, and the settlement
page. Checked on 17 September 2026, all nine breakages caught first time.

| Breakage introduced | Result |
| --- | --- |
| A webhook believed without checking its signature | Red |
| The same webhook processed again on repeat | Red |
| The return from Paystack trusted without reading the result | Red |
| An underpayment accepted as paid | Red |
| The discount not taken off the price | Red |
| A sale created while selling is off | Red |
| A settlement payment above what is owed accepted | Red |
| Paystack's fee not booked | Red |
| Buyer numbers shown in full on the order page | Red |

## Data suite (`tests/data.test.ts`)

Drives bundles received, bundles sent, the bridge reading a data message,
the catalogue fetch from the provider stand-in, and bundle orders. Checked
on 17 September 2026.

| Breakage introduced | Result |
| --- | --- |
| A bundle transfer accepting a different amount than quoted | Red |
| The required amount one naira short of covering the bundle | Red |
| Gifted data booked in the airtime pool | Red |
| Airtime matched to a transfer waiting for gifted data | Red |
| A bundle sent to the provider as if it were airtime | Red |
| A bundle the provider does not know sent anyway | Red |
| A data message read as one naira of airtime, with both defences off | Red, see below |
| A hand-set bundle price overwritten by a provider fetch | Red |
| A bundle that cannot be gifted offered as the thing sent | Red |

### Mutation that did not turn the data suite red, and what was found

Disabling the "read as data first when the message names a size" check
left the suite green. Investigated before changing anything: the airtime
pattern itself also refuses an amount followed by GB or MB, so the message
still fell through to the data reader. Two independent defences, both
kept. The mutation now switches both off together, and the suite goes red.

## Sending phone suite (`tests/sendingphone.test.ts`)

Drives the server side of the sending phone the way the app does: fetching
commands, reporting replies, the network's text message settling a command,
refunds, bundles gifted from a data pool, and settling by hand. Checked on
17 September 2026.

| Breakage introduced | Result |
| --- | --- |
| A phone command handed out twice | Red |
| A confirmation for a different number accepted | Red, after the gap below was closed |
| The PIN placeholder filled in on the server | Red |
| A command with no confirmation read as delivered | Red |
| A phone that has gone quiet still used to send | Red |
| A refund queued with no phone to send it | Red |
| A final refusal from the network retried | Red |
| The network's text message not used to settle a command | Red |

Mutation that did not turn the suite red, and what was found: every test
reported a confirmation for the right number, so a server that accepted a
confirmation for any number passed. A gap. A test now reports a
confirmation naming a different number, by reply and by text message, and
checks the command stays open.

The app itself is compiled by CI. Dialling a real network code cannot be
tested here; the check a person does with a small real transfer is in
docs/BRIDGE.md.

## Data lots suite (`tests/datalots.test.ts`)

Gifted data as lots with expiry: opened on arrival, spent soonest-expiring
first by deliveries and refunds, written off once when expired, and
reported a week ahead. Checked on 18 September 2026.

| Breakage introduced | Result |
| --- | --- |
| Expired data never written off | Red |
| Expired data written off twice | Red |
| Data spent newest first instead of soonest expiring | Red |
| Gifted data landing without a lot | Red |
| A lot's expiry ignoring the bundle's validity | Red |

## Agents suite (`tests/agents.test.ts`)

Drives the referral link, the commission, the wallet by bank transfer and
by Paystack, buying from the wallet, refunds back to it, withdrawals, and
the portal and command centre pages. Checked on 18 September 2026.

| Breakage introduced | Result |
| --- | --- |
| A commission paid twice | Red |
| The commission not paid on completion | Red |
| A wallet purchase allowed beyond the balance | Red |
| A withdrawal allowed beyond the balance | Red |
| An agent's link accepted while agents are off | Red |
| The agent's discount not applied | Red |
| A wallet refund sent to the bank instead of the wallet | Red |
| An online top-up credited twice | Red |
| A paused agent able to log in | Red |

### Two defences on purpose

The ledger's balance rule is checked twice: in `postJournal` so the caller
gets a message that names the difference in kobo, and by a deferred trigger
in the database so nothing that writes postings directly can post an
unbalanced journal. Each has its own test and its own mutation. Removing
either one alone turns exactly one test red, which is how it should be. Do
not "simplify" by removing one.

The same is true of notification deduplication: the application checks the
hash and reports a duplicate, and the database has a unique index on the
hash. The mutation that makes the application process a duplicate is caught
by the pool balance staying the same, not by an error, because the unique
index still stops the second row.

## Browser sweep (`scripts/browser-sweep.sh`)

Drives every public, agent and command centre page on three browser
engines, each in its own CI job on every push: Chromium, which is what
Chrome, Edge, Samsung Internet and Opera run; WebKit, which is Safari on
iPhone, iPad and Mac; and Firefox. At eight sizes: iPhone SE, iPhone 13,
Pixel 5, Galaxy S9+ with touch, iPad, a laptop, a desktop, and a phone with
script switched off, which is how Opera Mini's extreme mode and a blocked
script leave a page. On each, a sender gets a quote choosing the networks
by hand and a buyer places an order. It fails the build on a page that
scrolls sideways, a text field under 16 pixels (iPhones zoom in), a button
smaller than a fingertip, or any error the browser reports. Screenshots
are kept with each run as `screenshots-<engine>`. By hand: `npm run
browsers`, with `ENGINES=chromium,webkit,firefox` to run all three.

Findings on 19 September 2026, all fixed: three tables pushed the
narrowest phones sideways; command centre buttons were under a fingertip;
the stylesheets leaned on CSS variables, which Opera Mini's extreme mode
and old Android browsers drop, so every colour is now written out in
full; the network lookup called a function old browsers lack, now
guarded; and the sweep itself tripped the product's own limit of five
quotes per address in ten minutes, which is the flood guard doing its job,
so the flows run on three profiles.

Findings on 20 September 2026, from the two engines the first sweep could
not run, all fixed. Safari held the account list on the pools page at the
width of its longest choice, so the row of fields came to 296 pixels inside
a 254 pixel panel and the page scrolled nine pixels sideways on a 320 pixel
phone: fields may now shrink below the width their content asks for, and
the choices are short names with the explanation under the label. The
public stylesheet's fallback for browsers without flex gap named two
classes those pages never use, so the header lost its spacing on such a
browser. Safari and Firefox refuse a screenshot taller than 32767 device
pixels, which the settings page passes on a phone drawing four and a half
device pixels per pixel, so a page that tall keeps its first screen.

One message from Safari is ignored by name: before each screenshot the
sweep tool itself adds an empty style element to settle animations, and the
product's security policy refuses it. Standing in its place, the sweep now
fails any page that carries an inline style of its own, which is the thing
that message would otherwise have warned about.

Finding a sideways scroll took three runs because the first reports said
only how far the page moved. The sweep now names every element past the
right edge with the scrolling box that holds it, hides each element and
then each kind of element until the scrolling stops, and lists any box
holding more than it shows. Proved by breaking a page on purpose: the
report named the element. One trap is recorded in the code: the probe must
put elements back through the display property, because the security policy
refuses a written style attribute and a refused restore leaves the page
hidden and every later reading wrong.

Handled in code and held by tests because no emulator shows them: iPhones
refuse to dial a code with stars and hashes from a link, so the page shows
a copy button and a plain instruction on iPhones and the dial pad link on
Android; and every page carries a home-screen icon for iPhones beside the
manifest Android uses.

What is not covered: real devices. The build machine cannot run Safari's
engine, so here the sweep runs Chromium only; CI runs all three engines
on GitHub's machines. Old Android browsers are covered by the no-script
run and the plain stylesheet, not by running them. The final word is one
real phone of each kind opening the site after deployment.

The sending phone app is Android only by nature: iOS lets no app read
incoming text messages or dial codes, so the phones holding our SIMs must
be Android. Customers on any phone use the web pages.

## Prose check (`scripts/check-prose.sh`)

Checked on 17 September 2026 against a staged README.md.

| Breakage introduced | Result |
| --- | --- |
| An em dash character in prose | Red. Reported file and line. |
| The HTML entity for an em dash | Red. Reported file and line. |
| The words "robust" and "seamless" in one sentence | Red. Reported file and line. |
| The sentence "It's not just fast, it's cheap." | Red. Reported file and line. |
| No breakage | Green. Reported the number of files checked. |

Known limits, recorded rather than hidden:

- The check reads tracked files only. An untracked file is not checked until it
  is staged or committed, which is the point at which it matters.
- The banned word list is the founder's list. "Delve", "elevate" and
  "leverage" are matched in their common inflections. Words used inside a
  quoted rule about the words themselves are exempt by file path, not by
  context, so a new file that needs to quote them must be added to the exempt
  list in the script.
- A three-item list where two would do cannot be checked by a machine. That
  one stays a review rule.

## Commit message check (`scripts/check-commit-messages.sh`)

Checked on 17 September 2026 by committing a message containing an em dash
with the hook installed. The hook refused the commit. The CI step checks the
pushed range, so a commit made on a machine without the hook is still caught.
