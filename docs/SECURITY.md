# Security

What the platform protects, how, and what only the founder can do. Written
after the security reading of 20 September 2026, which read the whole code
four times over: the way people sign in, the way money moves, the public
web surface, and secrets with the phones.

## The rule about secrets

No third-party tool, bot or assistant gets hosting logins, server access or
API keys. Not even me. Where a secret is needed, the guide gives you the
command to run and you read the output on your own screen. Nothing in this
repository, in CI, or in any chat holds a real key. The CI workflow uses no
repository secrets at all, so there is nothing there to leak.

## Money

- **The ledger is double entry and the database enforces it.** A journal
  that does not balance is refused by a trigger at commit, not by code that
  might be skipped. Postings cannot be changed or deleted afterwards.
- **Every automatic money step is idempotent.** Journals carry a key with a
  unique index, so the same payout, refund, payment or commission books
  once however many times it is tried.
- **A payout that has left a SIM but not yet the ledger still counts.**
  Each payout records the account it draws on, and the pool check subtracts
  what is already on its way, so payouts starting together cannot overdraw.
- **Two guardrails under one lock.** The pool balance and the day's ceiling
  for a network are read under the same lock, so two payouts cannot each
  pass a limit without seeing the other.
- **A refund belongs to one hand.** Either the sending phones have it or a
  person does, never both, and recording one by hand while a phone holds it
  is refused.
- **One payment, one order.** A payment reference is unique to its method
  in the database, and paying more than the price waits for a person.
- **Money asked for is money spoken for.** An agent cannot spend what they
  have already asked to withdraw.

## Who may do what

- Passwords are scrypt with a per password salt, compared in constant time,
  and at least twelve characters. Session tokens are 32 random bytes and
  only their hash is stored.
- Every command centre page and every state-changing form requires a
  session, and every such form carries a token tied to that session.
- Every post must come from this site, or from a browser old enough to send
  no origin at all, where the form token still stands behind it.
- Resetting a password ends every session opened with the old one.
- A login for an account that does not exist costs the same as one that
  does, so nobody can learn who has an account by timing the answer. Wrong
  passwords are slowed by account, and loosely by the address they come
  from, loosely because many Nigerian phones share one address.
- An agent only ever sees their own wallet: there is no agent identifier in
  any form or address to change.

## The phones

- A phone authenticates with a token of 192 random bits, stored only as a
  hash, shown once, and revoked by pausing the phone.
- **The PIN never leaves the phone.** The server stores `{pin}` in the code
  and the phone fills it in. A network reply that repeats the PIN has it
  taken out before the phone sends the reply back or shows it.
- A phone refuses to dial anything that is not a top-up code, which is what
  stops a code that would forward the phone's calls. The server keeps the
  same rule, so neither side alone decides it.
- Changing the server address in the app clears the token and the PIN.
- **A message about airtime is believed only when it comes from one of the
  names that network sends from.** Anyone can send a text message that
  reads like a network's, so the words alone are not enough. Anything else
  that talks about value is kept for a person, with the sender named.

## The web

- Content security policy of `default-src 'self'` on every response,
  including static files, with no inline script or style anywhere.
- Every value written into a page is escaped by the page builder itself.
- Pages carrying a reference are never cached, and references are eight
  characters from a thirty-one letter alphabet, so they cannot be guessed.
- Numbers shown on a page that a link might be shared from are masked to
  the first four digits and the last two.
- The address of the person making a request is the one the web server in
  front wrote, so the flood guards can tell one person from another.

## What is not covered

- **Real devices.** The browser sweep runs three engines on eight sizes,
  but the final word is a real phone of each kind after deployment.
- **A stolen unlocked phone.** The PIN is stored on the phone so it can be
  dialled. A release build is not readable over a cable, but someone
  holding an unlocked phone can open the app. Keep a lock screen on every
  sending phone, and pause the phone in the command centre the moment one
  goes missing: paused phones are refused at once.
- **A referral cookie anyone can set.** A visitor can put any published
  agent code in their own browser and hand that agent the commission. They
  can only give commission away, never take it, so this is an accounting
  annoyance rather than a theft. If it is ever abused, the answer is to tie
  the code to the visit that followed the link.
- **A phone's token never expires.** It is revoked by pausing the phone,
  which works at once, but there is no rotation on a schedule. Change the
  token whenever a phone changes hands, by pausing that phone and adding it
  again.
- **A rare crash rather than a wrong number.** Two identical messages
  arriving at the very same instant can leave one of them with a server
  error instead of a quiet "already seen". The unique index still stops the
  money being booked twice, and the phone sends the batch again, so nothing
  is lost. Worth tidying, not worth risking the dedupe rules to tidy now.
- **The people you let in.** Every administrator can see everything and
  move money. There are no roles yet. Give an account only to someone you
  would trust with the float.
