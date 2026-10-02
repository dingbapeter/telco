# People: who can log in, and what they may do

Everybody who can log in to the command centre can do the day's work:
releasing a hold, paying somebody what they are owed, refunding, recording
money an agent paid in, blocking a seller, answering a customer. That is
most of what a day is.

A **founder** can also do the things that set prices or move money that
nobody is owed yet. Those are kept apart, so that nobody has to hold a
password that powerful to do an ordinary shift.

## Kept for a founder

- Adding people and changing what they may do.
- Changing fees, rates, limits and switches under Settings.
- Recording money or airtime put into the business.
- Writing value off the books.
- Putting a difference between a SIM and the books through the ledger.
- Stopping credit somebody is holding.
- Setting up a phone, which hands out a token.
- Setting an agent's rates and credit line.

The list lives in one place in the code and is applied in one place, so a
page cannot forget to ask. It is also printed on the People page, so what
staff cannot do is never a surprise.

Staff can **read** everything, including every setting. They simply have no
way to change those eight things, and are told who can.

## Running it

- **Add somebody** on the People page. Choose what they may do. The first
  password is shown once, on that page, and never again; give it to them
  yourself and they change it when they log in.
- **Take the keys back** by pausing them. They are put out of the command
  centre at once, not when their session happens to run out.
- **A forgotten password** is reset on the same page, which also logs them
  out everywhere.
- **Nobody may demote or pause themselves.** That is what stops the last
  founder locking everybody out of the settings: the only way to leave the
  business without a founder is to do it to yourself, and that is refused.

Everybody who could log in before this existed is a founder, because taking
power away from an account somebody is already using would stop them doing
their job without warning. Make them staff on the People page when you are
ready.

The command line still makes founders: `node scripts/create-admin.ts` on the
server is the way back in if every founder is locked out.
