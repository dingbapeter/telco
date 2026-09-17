# Working method

This is the standard every change in this repository is held to. It was set by the founder before the product was described, so that the standard does not depend on the history of any one conversation. Read it before you write anything.

---

## Who you are working for

I am the founder. I am not a developer. I will describe what I want in plain
words and you will build it properly, the whole thing, first time. When you
need a decision only I can make, ask once, clearly, with your recommendation
first. Then carry on with everything that does not depend on the answer.

Always complete all my instructions and never hold back. Be forthright with
recommendations, including when you think I am wrong.

## The standard

Everything you build is going in front of paying users and investors. That
sets the bar:

- **No stubs. No placeholders. No mock data. No "coming soon".** If a button
  exists, it works. If a number is shown, it was calculated from something
  real. A feature that is half built is not shipped; it is finished or it is
  not mentioned.
- **No toasts for anything that matters.** A message about money, an error, or
  a result belongs where the person is looking, and stays until they have read
  it. Toasts are for "copied to clipboard".
- **Every failure says what to do next.** Never show a raw error. Translate it:
  not "SMTP 535" but "the mail server refused the login, that is the password
  in the bridge's service file on your own machine, not anything in the hosting
  panel". The person reading it should know their next move.
- **Configured is not the same as working.** Health checks try the thing. Knock
  on the service, send the test message, read the last outcomes. Never report
  green because a setting exists.

## How it must read

Everything a person reads, in the interface, in emails, in error messages, in
documentation, must sound like it was written by a careful human being.

- Plain British English. Short sentences. One idea each.
- **No em dashes anywhere.** Not in code comments, not in copy, not in commit
  messages. Enforce it with a check in CI if you can.
- None of the tells: no "seamlessly", no "robust", no "leverage", no
  "delve", no "elevate", no three-item lists where two will do, no
  "it's not just X, it's Y".
- Comments in the code explain **why**, not what. A comment that restates the
  line below it is noise. A comment that records the bug this line prevents is
  worth keeping forever.
- Commit messages are prose, not bullet lists of files. Say what changed and
  why it mattered. Someone reading the log in a year should understand the
  product's history from it.

## Testing, the part that is not optional

This is where most of the value came from last time, so do not shortcut it.

1. **Tests live in the repository and run in CI on every push.** A suite that
   exists only on a machine does not exist. We lost nine hundred assertions
   once to a wiped container, and that is why this rule is absolute.
2. **Name each assertion after the behaviour, not the code.** "a learner cannot
   book themselves" tells you what broke. "createBooking returns 403" does not.
3. **Mutation-check every suite before you trust it.** Deliberately break the
   compiled code one way at a time, confirm the suite turns red, put it back.
   Write down in the test README which breakages each suite caught.
4. **When a mutation does NOT turn a suite red, investigate before fixing.**
   Twice it turned out there were two independent defences, and "fixing the
   gap" would have removed one of them. Record what you found.
5. **A test that goes red because behaviour deliberately changed is the test
   doing its job.** Update it to hold the new rule, and say so in the commit.

## Money, if this product touches it

- Every webhook handler is idempotent. Claim the row with a conditional update
  first, and skip every side effect if the claim moves zero rows. Assume every
  message arrives twice.
- Never trust a provider's optimism. A payout is "processing" until the
  provider says it settled, and a failure returns the money exactly once.
- Guardrails in code, not in discipline: a second approver above an amount, a
  daily ceiling, a floor, the balance read before every transfer.
- Keep your own ledger. Do not let the payment provider be your source of truth
  for what anyone is owed.
- Every commission or fee percentage is changeable at runtime from an admin
  panel, with a range, a fallback, and an audit entry. Never a redeploy.

## The database

- Every migration is guarded so it is safe to run twice: `IF NOT EXISTS`,
  `ADD VALUE IF NOT EXISTS`, and `DO $$ ... EXCEPTION WHEN duplicate_object`
  around constraints.
- A script that checks the migration history can rebuild the database from
  nothing, run on demand.
- Never destructive without asking. Ever.

## Security posture

- No third-party tool, bot or assistant ever gets hosting logins, server
  access, or API keys. Not even you. When a secret is needed, give me the
  command to run and I read the output on my own screen.
- Secrets are never printed into a chat, a commit, or a log.
- Anything outward-facing or hard to reverse gets confirmed with me first,
  unless I have told you to proceed without asking.

## The admin panel is a product, not an afterthought

Build a command centre from early on. It should let me:

- See live numbers, every one a real query, none cached stale.
- Change behaviour without a deploy: feature switches, rates, thresholds,
  spacing, commissions.
- Read an audit log written automatically by a single hook, so nothing has to
  remember to log itself.
- See a launch checklist that reads live configuration and live outcomes, and
  tells me exactly what to set and where for anything still red.

## How to work with me

- Go sequentially. Build, test, retest, then move to the next thing.
- Do not stop to ask permission to continue. Keep building and park the
  decisions that are genuinely mine.
- When I give you feedback from testing, fix the small things immediately and
  tell me plainly which ones are real builds that need my decision first.
- Keep a document in the repository of everything still waiting on me, so it
  survives losing this conversation.
- Report honestly. If a test fails, show me the output. If you skipped
  something, say so. If it is done and verified, say so plainly without
  hedging.

## What "sovereign" means here

Own the important parts. Prefer self-hosted and in-repository over a
dependency you cannot inspect or replace:

- Vendor third-party scripts into the repository rather than loading them from
  a CDN, so a blocked host in one country does not break the product there.
- Where a paid API can be replaced with transparent local logic, write the
  logic. I would rather read the maths than pay for a black box.
- Assume the product will be used on a mid-range Android phone on a weak
  connection in a country you have not thought about. Build for that first and
  the fast cases look after themselves.

