# The dial code: what a caller does, and what we do

Written for the founder. The short code itself is leased from an aggregator
and that part is a contract, not code. Everything on our side of it is
built, tested and in this repository, and this page is what it does.

## What it is for

A sender with no data at all, on a phone with no browser worth the name, can
dial a short code and move airtime across networks. No app, no page, no
account. The same menu also sells airtime to us, buys airtime, checks a
transfer and reads back the caller's last few sends.

It is the same business underneath. The dial code does not have its own
prices, its own caps or its own ledger: it calls the same functions the
website calls, so a rate you change in the command centre changes what the
next caller is quoted, and a cap that refuses a transfer on the website
refuses it from the dial pad with the same words.

## What a caller actually sees

Every screen below is the real output of the real code, printed by driving
the endpoint the way an aggregator drives it. The number in brackets is the
character count, because a network will carry 182 characters on one screen
and no more.

**Sending airtime to another network.** The caller dials `*347*55#`:

```
Telco                                   (111)
1 Send airtime to another network
2 Sell airtime to us
3 Buy airtime
4 Check a transfer
5 My recent sends
```

They key `1`:

```
Enter the number that will RECEIVE the airtime.    (47)
```

They key `08021234567`:

```
Which network is 0802 123 4567 on?      (76)
1 MTN
2 Airtel (we think)
3 Glo
4 9mobile
```

The guess comes from the number's prefix. It is offered and never assumed,
because Nigerian numbers get ported and a wrong guess sends somebody's
airtime to the wrong network. They key `2`:

```
How much airtime to send?               (79)
From N100 to N10,000.
Reply with the amount in naira.
```

The limits are the ones in the command centre, and they are on the screen
because a refusal after the fact costs the caller another whole session.
They key `500`:

```
Check carefully:                        (126)
N500 from your MTN line
to 0802 123 4567 (Airtel)
Fee N20, they get N480
1 Confirm  2 Change number  0 Cancel
```

The fee is the real fee from the fee engine, not a figure written into this
menu. They key `1`:

```
Ref TX-YXC98DTX                         (157)
Now dial *600*PIN*500*08039990001# on your MTN line.
PIN is your own transfer PIN. We never ask for it.
We send N480 as soon as MTN confirms.
```

That last screen is the whole point and the whole limit of the thing. **No
network gives anybody an interface to take airtime off a customer's line.**
So the dial code does everything a program can do, and then hands the caller
their own network's transfer code with our receiving number and the amount
already in it, and the word PIN where their PIN goes. We never hold a PIN.
From there it is the ordinary transfer: the phone bridge sees the airtime
arrive, the books are posted, and the payout goes out, with nobody involved.

**Selling airtime to us** is `2` from the menu, then the amount:

```
Sell to us:                             (86)
N1,000 of MTN airtime
You get credit to spend with us.
1 Confirm  0 Cancel
```

```
Ref SB-JDFWA79R                         (103)
Dial *600*PIN*1000*08039990001# on your MTN line.
You get N800 of credit when it lands.
```

Credit only, never cash, from the dial pad. Cash needs a bank account
number, and a bank account number is not a thing anybody should type into a
dial pad on a line that may drop halfway through. Cash sales stay on the
website, where the number can be read back and checked.

**Buying airtime** is `3`, and because the caller cannot pay from a dial
pad, it ends with our bank details and a reference:

```
Pay N500 to                             (120)
Zenith Bank 1012345678
Telco Limited
Put RT-E4J9UZEH as the narration.
Airtime is sent once the money lands.
```

With no bank details set in the command centre, it says so and offers the
website rather than taking an order nobody can pay.

**Checking** is `4` and a reference, which finds a transfer, a sale or an
order and says where it stands in words a caller understands ("waiting for
your airtime", "done", "coming back to you"). **`5`** is the caller's last
three sends, which is the question the command centre gets asked most.

## How the aggregator talks to us

The aggregator posts one request per keypress to `POST /ussd` and we answer
with one screen. Nothing else is needed: no session cookie, no callback, no
second address.

They do not all speak the same way, so two things are set once in the
environment file on the server, on the day the aggregator is chosen:

| Setting | Values | What it means |
| --- | --- | --- |
| `USSD_INPUT_STYLE` | `cumulative` (the default) | The whole keyed history arrives each time, joined with stars: `1*08021234567*2*500`. |
| | `keypress` | Only the latest key arrives. |
| `USSD_RESPONSE_STYLE` | `con_end` (the default) | A plain body beginning `CON ` (keep going) or `END ` (finished). |
| | `json` | `{"message": "...", "continueSession": true}`. |

Both conventions are tested, both ways round, against the same endpoint.

Field names differ too, so the endpoint reads each fact under the several
spellings in use: the session id as `sessionId`, `sessionID` or
`session_id`; the caller's number as `phoneNumber`, `msisdn`, `from` or
`mobile`; the short code as `serviceCode`, `shortCode`, `serviceId` or
`ussdCode`; what was keyed as `text`, `userData`, `input`, `message` or
`ussdString`; and the caller's network as `networkCode`, `network`,
`operator` or `telco`. The body may be a form or JSON. Networks come in a
dozen spellings and all of them are read: `MTN-NG`, `mtn_ng`, `Globacom`,
`Airtel NG`, `Etisalat` for 9mobile. A word we do not know is not guessed
at: the caller is asked which network they are on, which costs one screen.

## The door

`USSD_SHARED_SECRET` is the secret the aggregator gives us. It goes in the
environment file on the server and nowhere else: not in this repository, not
in the command centre, not in a chat. The aggregator sends it as
`Authorization: Bearer ...`, or in a `secret` field if that is all they can
do, and it is compared in constant time so nothing can be learned by
timing the answer.

- **No secret on the server: the address does not exist.** It answers 404,
  not 401, so nothing advertises that there is anything there.
- **Wrong secret: 401, and no session is created.**
- **A short code that is not the one in the command centre is not
  answered.** That is somebody else's traffic, or a test pointed at the
  wrong address.
- **A caller's number we cannot read ends the session** saying so, because
  everything after that point depends on knowing which line is sending.

## What you set in the command centre

Settings, under **Dial service**:

| Setting | What it does |
| --- | --- |
| Dial service open | Off, and callers are told we are not open and sent to the website. One switch, and it needs no deploy. |
| Our dial code | The code you leased, like `*347*55#`. Traffic for any other code is refused. |
| How long a dial session lasts | Five minutes by default. A caller who walks away mid-journey is not kept open for ever. |

Everything else a caller meets is a setting you already have: the fee, the
rates, the limits, the caps, the receiving numbers, the networks' transfer
code templates, the bank details.

## Reading a session back

Every screen we sent and every key the caller pressed is kept, and the
command centre has a page for it: **Dial code**. The list shows who dialled,
from which network, how many keys they pressed, how it ended and what it
made. Opening one shows the session screen by screen, with the network's own
session id to quote to the aggregator if something needs looking into at
their end.

This exists for one reason. A caller who says "it showed me a different
number" or "I never agreed to that fee" can be answered from what was really
sent, in seconds, rather than argued with.

A session is a record, so nothing writes over it. If the network hands the
same session id to somebody else later, that is a new row; the old one keeps
its transcript. The database holds a unique index that allows only one open
session per id at a time, so that is a rule and not a habit.

## The things that go wrong on a real line, and what happens

USSD runs over a signalling channel on a weak network. These are not edge
cases; they are Tuesday.

- **The aggregator did not hear our answer and sends the same keypress
  again.** It gets the same screen back and nothing moves twice. On the
  cumulative convention a repeat is recognised by the keyed history being
  the same; on the one-key convention, by the same key arriving within five
  seconds.
- **It retries the keypress that created a transfer.** The dial is finished,
  so the caller is given back the reference and the dial code they were
  given the first time, not a fresh menu that would lose them the thing they
  rang up for. There is exactly one transfer. Three separate things stop a
  second one: the record of what the session already made, the guard inside
  the engine, and the per-session lock.
- **Two requests for one session arrive at once.** Each session is locked on
  its own id for the length of its database transaction, so they are handled
  one after the other rather than interleaving. Two callers never wait on
  each other.
- **A request arrives that is neither the same keypress nor the next one.**
  It is not guessed at. The caller is asked the same question again, because
  working out which part of a jumbled history is new would be guessing with
  somebody's money.
- **The caller walks away.** The session is finished after the window in the
  command centre, marked dropped by the minute timer, and the next dial
  starts clean at the menu.
- **Something keys at us in a loop.** Forty requests of any kind, keyed or
  repeated, and the session ends politely. Repeats are not written into the
  transcript, so a loop cannot fill the record either.
- **A rule says no.** A cap, a block, a number we will not send to: the
  reason the website would have given is trimmed to a screen and shown, so
  the caller knows why and what to do. Not "something went wrong".
- **A fat finger at a confirmation.** Anything that is not confirm or cancel
  asks the same question again rather than throwing the journey away.

## What this does not do

- It cannot take airtime off the caller's line. Nothing can. See
  docs/CODES.md.
- It does not take cash sales, or card payments, or bank details.
- It does not log anybody in. A dial session knows the line it came in on
  and nothing else, which is also why it can only read back sends made from
  that same line.
- It is not a chat. Each screen is 182 characters, there is no scrolling and
  no going back, so the screens are written to be read once.

## The day a contract is signed

1. Put the aggregator's secret in `/etc/telco/telco.env` as
   `USSD_SHARED_SECRET`, with `USSD_INPUT_STYLE` and `USSD_RESPONSE_STYLE`
   if they do not use the common ones. Restart the service.
2. Give the aggregator the address: `https://your.domain/ussd`.
3. Type the code into Settings, Dial service, and turn the switch on.
4. Dial it yourself and send N100 to another network. Then open the Dial
   code page and read your own session back.

Nothing in this list is a deploy, apart from the secret, and nothing in it
needs a developer.
