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
