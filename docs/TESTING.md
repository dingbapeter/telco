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

The whole list takes hours, because every breakage rebuilds the test database
and runs a suite. To split it, copy the repository once per shard, give each
copy its own database, and run:

```
MUTATION_SHARD=1/3 DATABASE_URL=postgres://.../telco_m1_test node scripts/mutation-check.ts
```

A copy per shard is not optional: two shards in one folder would edit the same
files and report nonsense. CI needs no copies, because each runner in the
matrix has its own checkout and its own database; it runs three shards and
every one of them has to come back clean.

Each breakage gets ten minutes, which is ten times the slowest suite. A
breakage can hang a suite rather than fail it, because a test left holding a
database lock waits for ever and node's test runner has no time limit of its
own. A suite that never finishes is reported as not caught, which is what it
is, rather than holding the machine until somebody notices.

**If a run is killed part way through, the file it was editing is left
broken.** The script puts every file back in a `finally` block, which a kill
signal does not run. After an interrupted run, check `git status` and
`npx tsc --noEmit` before trusting anything. This happened once while this
work was being built, which is why it is written here.

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
| Money already asked for as a withdrawal spent again | Red |
| An agent's top-up reference made from their row number and the time | Red |

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

## Agent shop suite (`tests/agentshop.test.ts`)

Drives what a shop needs beyond a wallet: a rate of their own, buying for
many customers in one go, the statement, and credit lines. Checked on
30 September 2026.

| Breakage introduced | Result |
| --- | --- |
| An agent's own rate ignored in favour of the one in Settings | Red |
| An agent's own share of our fee ignored | Red |
| A rate outside the allowed range accepted | Red |
| A credit line given above the ceiling | Red |
| A closed credit line still lent against | Red |
| Credit switched off for everyone but still lent against | Red |
| An agent owing longer than allowed still lent against | Red |
| How long an agent has owed read from the whole ledger instead of the current run | Red |
| A credit line taken out in cash as a withdrawal | Red |
| A bundle size that means two bundles quietly picking one | Red |
| A bundle name read as an amount of money | Red |
| A line with no network and a prefix we do not know bought anyway | Red |
| The same list bought twice, with both defences off | Red |
| A running balance that starts again at every line | Red |
| A spreadsheet formula written into a statement as it stands | Red |
| A date that is not a real day accepted | Red |
| An agent's second wallet purchase colliding with their first | Red |

That last one was a real bug, found by this suite rather than by a
mutation. Every wallet purchase was recorded against the payment reference
`wallet:<agent id>`, and the unique index that stops one payment paying two
orders meant an agent's second purchase ever would have failed with a raw
database error. Nobody had bought twice from one wallet in a test before
the bulk work did it four times in a row. The order's own reference is now
part of the payment reference, and the mutation above holds it.

### Two defences on purpose

Buying the same list twice is stopped twice: the code takes the batch row
with `ON CONFLICT DO NOTHING` and hands back the list that already exists,
and the reference column is unique in the database. The mutation has to
turn off both to go red, which is why it is written with an `also` entry.

A credit line being taken out in cash is also refused twice: a plain
message when the wallet is at or below zero, and the older rule that a
withdrawal may not exceed the wallet's own balance. Turning off the message
leaves the money safe but the words poor, which the test catches on the
words.

## Agent interface suite (`tests/agentapi.test.ts`)

Drives the interface an agent's own till or POS software talks to: keys,
the switch, the rate limit, quotes, purchases, lists and the statement.
Checked on 30 September 2026.

| Breakage introduced | Result |
| --- | --- |
| An agent's key kept in clear instead of as a fingerprint | Red |
| A revoked key still working | Red |
| One agent revoking another agent's key | Red |
| The switch on the interface ignored | Red |
| A key allowed to ask as often as it likes | Red |
| An amount sent in kobo taken as kobo | Red |
| A purchase allowed without a reference of the shop's own | Red |
| The same purchase bought twice, with both defences off | Red |
| One shop reading another shop's purchase | Red |

### Two defences on purpose

A repeated purchase is stopped twice: the code looks for the shop's
reference before buying, and the database has a unique index on the agent
and that reference, which catches two requests arriving in the same
instant. The mutation turns off both. With only the index off, the code
still answers correctly; with only the lookup off, the index raises the
violation and the code answers with the order the winner made. Do not
remove either.

## Buying back suite (`tests/sellback.test.ts`)

Drives selling airtime and data to us from the quote to the credit code or
the bank transfer: the circle guard, the caps, holds and returns, blocked
numbers, credit codes, cash with its holding time and ceiling, bought data
and its expiry, the phone bridge path and the command centre.
Checked on 1 October 2026.

| Breakage introduced | Result |
| --- | --- |
| Airtime bought back for more than it can be sold for | Red |
| An agent's own rate not counted as a price we sell at | Red |
| Paid on what was quoted instead of what arrived | Red |
| Value below the smallest we buy taken anyway | Red |
| Value from a blocked number bought anyway | Red |
| A blocked number quoted a rate | Red |
| One number allowed to sell as much as it likes in a day, or in a week | Red, one test each |
| One number allowed to make as many sales in a day as it likes | Red |
| The caps not checked again against the value that really arrived | Red |
| Value over a cap kept instead of sent back, and sent back with the switch off | Red, one test each |
| More than we buy in one go kept for a person instead of going back | Red |
| One bank account allowed to collect for any number of lines | Red |
| Cash taken with no account number to pay into | Red |
| A phone number read as a bank account number | Red |
| A return a phone is sending also recorded by hand | Red |
| A return taken over after a phone already has it | Red |
| Data sent back leaving its lot open to be written off twice | Red |
| Short dated data, or data nobody has dated, bought anyway | Red, one test each |
| Short dated data still offered to sellers | Red |
| The day's buying ceiling ignored | Red |
| What we buy not counted against the SIM's daily cap | Red |
| A sale taking airtime a transfer was waiting for | Red |
| Cash paid before the holding time is up | Red |
| The day's cash ceiling ignored | Red |
| A credit code spent past what it holds | Red |
| A credit code read without a lock, so two orders share one balance | Red |
| Stopping a credit code leaving the money owed to nobody | Red |
| Bought data recorded with the bundle's full validity | Red |
| Margin on a purchase never booked | Red |
| The phone's record unable to hold what buying back answers | Red |
| A sale paid twice, with both defences off | Red |
| A refund of credit paid out in cash instead of back onto the code | Red |
| A stopped credit code taking a refund back | Red |

Two of these were real faults, found by the suite rather than by a
mutation. The phone bridge keeps its own record of what became of every
message, with a database rule listing the answers it may hold, and buying
value back was not one of them: the first real message from a phone would
have failed with a database error, which is why that path is driven through
the bridge in a test and not only through the function underneath it. And a
message we bought value on would have stayed in the unmatched list for
ever, telling the founder to go and pay a seller who had already been paid.

### Three faults found while building the fraud controls

**Four figures with no comma were read as three.** The built-in reading of a
network's message had the grouped form of an amount as an optional group, so
against "You have received N1500.00" it matched the first three digits and
stopped: N1,500 was booked as N150. Every sample in the suite happened to use
either three figures or a comma, so nothing caught it. The grouped form now
has to contain a comma, the suite carries four-figure samples with and without
kobo, and the mutation puts the old pattern back. This one would have
mis-booked real money on the first busy day.

**Data sent back left its lot open.** Sending bought data back to the seller
reversed the money and left the lot sitting in the data pool, where it would
later be written off as an expiry loss we had already been paid back for. The
transfer side had been doing this correctly all along, which is how it was
noticed. Now both give the lot up, and a mutation holds it.

**Data gifted in for a transfer was dated by the bundle's full life.** A
sellback dated its lot on the shorter of the bundle's validity and what we
assume a gifted bundle has left; a transfer used the bundle's whole validity,
which is a year on a year-long bundle that may have a week to run. Both now
use the same assumption, in one function, and the datalots suite proves the
lot is not dated by the bundle.

### Two gaps a mutation found in the new controls

**Taking a return off the phones.** Recording by hand a return a phone is
already sending would send the value out twice, so the same rule as a refund
applies: it cannot be taken over once a phone has it. Turning the rule off
left the suite green, because the test took the return over before any phone
had been given it. The suite now also sets the request id first, the way the
worker does, and insists both the takeover and the by-hand record are refused.

**A phone number is not a bank account.** The account number is read out of
what a seller typed as the one run of exactly ten digits. Loosening it to any
ten digits left the suite green, because the only test for it used bank
details with no digits at all. An eleven digit phone number would then have
had its first ten digits taken as an account number: a payment into an account
nobody holds, and a wrong count of the lines sharing an account. The suite now
refuses details that carry only a phone number, and picks the account out of
details that carry both.

### Three defences on purpose

Paying a seller their cash twice is stopped three times over: the state is
checked when the row is read, the claim that moves it to paid is
conditional on the state, and the journal is keyed on the sale so a second
posting does nothing. Turning off the first two is what the mutation above
does, and the suite goes red on the answer the second call gives. Even
then the money is safe, because the third defence is the one holding the
books. Do not remove any of them.

### The one that needed investigating

The conditional claim on its own left the suite green, because the state
check in front of it answered first. That is the second defence doing its
job, not a gap, so the mutation now turns off both and the finding is
written here rather than "fixed" by deleting one of them.

## Money report suite (`tests/report.test.ts`)

Drives the Money page: the balance sheet, the profit and loss for a period,
the Lagos day boundaries and the file it hands over. Checked on 1 October
2026 after money had been moved through every line the business has: a
transfer with a fee and a network share, a discounted sale paid by card
with a payment fee, an agent's commission, airtime and data bought back,
and a bundle written off when it expired unsold.

| Breakage introduced | Result |
| --- | --- |
| What is owed to other people counted as ours | Red |
| The books adding up reported without being checked | Red |
| A period taking in journals from outside its dates | Red |
| The last day of a period left out of it | Red |
| The network's share of the fee counted as our earnings | Red |
| Expenses left out of the profit | Red |

### The one that needed investigating

The alarm that says the books do not add up could be hardcoded to "yes" and
the suite stayed green, because the test checked the same arithmetic itself
rather than the product's. The database refuses to post a journal that does
not balance, so there is no honest way to make a real ledger disagree and
watch the alarm sound. The answer was to pull the arithmetic out as a
function of four numbers and test it with figures that are deliberately
wrong. The alarm is now proven to be able to say no, which is the only
thing worth proving about an alarm.

## Balance checks suite (`tests/balances.test.ts`)

Drives asking a SIM what the network says it holds, reading the answer,
putting a difference through the books, and the schedule that asks without
being asked. Checked on 2 October 2026.

| Breakage introduced | Result |
| --- | --- |
| A balance check ignoring what is already on its way off the SIM | Red |
| An unreadable answer guessed at instead of kept word for word | Red |
| A balance code that is not a code a SIM may dial sent anyway | Red |
| A difference put through the books twice | Red |
| Airtime found on a SIM booked as the founder's own float | Red |
| Every SIM asked its balance over and over | Red |
| A phone nobody has heard from still asked to dial | Red |
| A text message settling a balance check, with both defences off | Red |
| An answer written down for a command nobody dialled | Red |

### Three that needed investigating

The suite was green on three of these at first, and each was a real gap
rather than a second defence.

A phone that had not reported in was refused by the schedule's own rule, so
mutating the rule the direct ask uses changed nothing. The suite now asks
directly with a stale phone and expects the refusal.

A text message cannot settle a balance check because a balance check has no
number and the matcher pairs on the number. The kind filter in front of it
is a second defence, and turning off only one leaves the other holding, so
the mutation now turns off both. The first test message did not read as a
confirmation at all, which is why even that looked green until it was
rewritten.

An answer written down for a command the phone never dialled could not
happen in the suite, because the suite had been fixed to fetch the command
first, the way a phone does. A test now posts a result for a command still
queued and expects nothing to be written down.

## Find suite (`tests/find.test.ts`)

Drives the one box that looks up a number, a reference, a credit code or an
agent across everything the business holds. Checked on 2 October 2026.

| Breakage introduced | Result |
| --- | --- |
| A number typed with spaces or a country code finding nothing | Red |
| The same thing found twice when a number is typed two ways | Red |
| A reference typed in lower case finding nothing | Red |
| The search box dropped from the pages | Red |

### Two defences on purpose, found by a mutation that stayed green

Searching a credit code finds the purchase it paid for twice over: the
order carries the code in its own column, and the payment reference for a
credit payment is the code and the order reference together. Taking the
column out of the search changes nothing, because the payment reference
still matches. The mutation was removed rather than the column: a second
way of finding something is not a fault, and the format of a payment
reference is not a thing to lean on.

The same pattern, honestly: a number typed with a country code was found
even with the digits left unstripped, because the number is also looked up
in the form we store. The suite now searches part of a number with a space
in it, which only the stripping can find.

## Staff suite (`tests/staff.test.ts`)

Drives what a person who is not the founder may and may not do, and the
People page that decides it. Checked on 2 October 2026.

| Breakage introduced | Result |
| --- | --- |
| The founder's things opened to everybody | Red |
| A path kept for the founder matched loosely enough to catch the day's work | Red |
| A new person made a founder whatever was chosen | Red |
| Somebody able to take away their own powers | Red |
| A paused person left inside, with both defences off | Red |
| Staff shown the forms that change the settings | Red |

### Two guards removed because a mutation showed they did nothing

The People page also refused to demote or pause "the last founder". Turning
that off left the suite green, and the reason is worth keeping: only a
founder can open that page, so the only way to leave the business without
one is to demote or pause **yourself**, which a separate rule already
refuses. The redundant checks were taken out rather than propped up with a
test, and the suite now proves the real rule from both sides, with one
founder and with two.

A paused person is kept out twice over: their sessions are deleted when
they are paused, and a session is only accepted while the account is
active. Only the second is load-bearing, so the mutation turns off both.
The deletion stays, because a row nobody can use is still a row with a
token hash in it.

## Laundering caps suite (`tests/limits.test.ts`)

Drives the caps that stop the service being used to wash money, and what
happens to value that arrives over one. Checked on 2 October 2026. The
thinking behind them is in docs/CAPS.md.

| Breakage introduced | Result |
| --- | --- |
| The week's money cap on a sender ignored | Red |
| The day's or the week's count of transfers ignored | Red, one test each |
| A receiving number's daily amount or count ignored | Red, one test each |
| A cap set to zero still refusing, instead of being off | Red |
| The week counted from the beginning of time instead of Monday | Red |
| A transfer counted against its own cap | Red |
| The caps not checked again against the amount that really arrived | Red |
| Value over a cap kept for a person instead of sent back | Red |
| Value over a cap sent back even with the switch turned off | Red |
| Expired and returned transfers counted against the number that sent them | Red |

| The locks that make two things at once count each other, on quoting and on arrival | Red, one test each |

Two of those are worth saying plainly, because they are the tests that stop
the caps doing harm rather than good.

**A transfer must not count against its own cap.** The row is in the table
before the airtime lands, so a cap checked on arrival without excluding the
transfer being checked would send back every transfer made at exactly the
cap, which is the one amount a cap is meant to allow. The test quotes at the
cap, lands the exact amount and insists it goes through.

**A sender must learn nothing about the receiving number.** The cap on a
receiving number can only be enforced by telling the sender it has been
reached, so the test asserts that the figure for that number's day appears
nowhere in the message. Otherwise anybody could learn how much a stranger's
line has been sent today by asking for quotes until the message changed.

### A concurrency test that passed by luck

Two quotes asked for at the same moment must not both pass a cap, and two
amounts arriving at the same moment must not either. The first version of
both tests started the two with `Promise.all` and asserted that only one got
through. Both mutations, which take the locks out, left the suite green: with
the locks gone nothing blocked, the first transaction committed before the
second reached its counting, and the second was refused for the ordinary
reason. The test was passing on timing, not on the thing it was written for.

They now hold both transactions open on purpose, and before letting the first
commit they wait until Postgres itself reports a backend waiting on a lock.
With the lock in place the second really is inside the first; with it gone
nothing ever waits, the second counts a day that is still empty, and the test
goes red. Written down because a concurrency test that cannot fail is worse
than no test: it reads like a guarantee.

## Security review (20 September 2026)

Four readings of the whole code in parallel: the way people sign in, the
way money moves, the public web surface, and secrets with the phones.
Everything they reported was checked against the code before anything
changed. What was fixed, with the test that holds it, is recorded against
each suite above. Two notes belong here.

The first is a mutation that cannot be made to fail. The check that a
static file lies inside the public folder now compares with the separator,
so a folder beside it whose name merely starts the same way cannot pass.
Removing that separator leaves every test green, because the address parser
removes the dot segments before the check ever runs, so no request can
reach such a folder anyway. The guard is a second defence, kept for the day
the first one changes, and it is not in the mutation list because nothing
observable turns red.

What the reading found and what was done about it is in the commits of 20
September 2026 and, for the founder, in docs/SECURITY.md. The four things
that need the founder are in docs/WAITING_ON_FOUNDER.md. Every fix that
could be held by a test is held by one, and every one of those has a
mutation that turns its suite red.

The second thing to record is what a test cannot see. A login for an address nobody has an
account for now checks the password against a stand in, so it costs the
same as a real one and nobody can learn who has an account by timing the
answer. A test that measured the time would be a test that fails on a busy
machine, so what is held instead is that the stand in is a real stored
password of the same shape and cost, and the mutation that turns it into a
malformed one turns the suite red.

## Browser sweep (`scripts/browser-sweep.sh`)

Drives every public, agent and command centre page on three browser
engines, each in its own CI job on every push: Chromium, which is what
Chrome, Edge, Samsung Internet and Opera run; WebKit, which is Safari on
iPhone, iPad and Mac; and Firefox. At eight sizes: iPhone SE, iPhone 13,
Pixel 5, Galaxy S9+ with touch, iPad, a laptop, a desktop, and a phone with
script switched off, which is how Opera Mini's extreme mode and a blocked
script leave a page. On each, a sender gets a quote choosing the networks
by hand and a buyer places an order. The seeded database holds an agent
with a rate of their own, a credit line, a key and a bought list, so the
shop's pages have real figures on them rather than empty tables. It fails the build on a page that
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

Findings on 1 October 2026: none. The selling page, a seller's instruction
page and the two buying back pages in the command centre were added to the
sweep with a seeded sale waiting and another waiting for cash, and every
engine was clean first time.

Findings on 30 September 2026, when the shop's new pages and the agent's
own page in the command centre were added to the sweep, all fixed. The
revoke button beside a key was 42 pixels tall, two short of a fingertip,
because the agent pages had their own small button rule and no minimum
height. The two date fields on an agent's page were left at the browser's
default 13 pixels, because the command centre's stylesheet named every kind
of text field except a date. And an agent's page scrolled seven pixels
sideways on a 320 pixel phone: the description list puts the term and its
value side by side, and a long term with a long value came to 311 pixels
inside 288. Terms and values now stack under 26 rems, which fixes the same
fault on every other page that uses one.

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
