# The phone bridge

One Android phone per network holds our receiving SIM. A small app on it
forwards every text message the phone receives to the server, which reads
the network's "you have received airtime" message, matches it to the
waiting transfer, and books it. Nothing is ever paid out on a sender's word:
only on the network's own message, seen by our own phone.

## What you need

- One Android phone per network (Android 7 or newer; a cheap one is fine).
  It must be Android: iPhones let no app read incoming text messages or
  dial codes on the phone's behalf, so an iPhone cannot do this job.
  Customers on iPhones use the web pages like everyone else. The phone,
  with our SIM for that network in it, on charge, with data on.
- The server running on an https address.

## Setting a phone up

1. In the command centre, under Receiving numbers, add the number of the SIM
   in the phone.
2. Under Phone bridge, add a phone: pick the network, give it a label. The
   page shows a token once. Keep that screen open.
3. Get the app. Every push to the repository builds it in CI; open the
   latest green run on GitHub, under Actions, and download the file called
   `telco-bridge-app`. Unzip it: inside is `app-release-unsigned.apk`.
4. Sign it on your own machine, with a key only you hold. Make the key once
   and keep the file safe; every later version of the app must be signed
   with the same one or the phone will refuse to update it.

   ```
   keytool -genkey -v -keystore telco-bridge.jks -alias telco -keyalg RSA -keysize 2048 -validity 10000
   apksigner sign --ks telco-bridge.jks --out telco-bridge.apk app-release-unsigned.apk
   ```

   The key never goes on a server, into this repository, or to anybody
   else, including me. Then copy `telco-bridge.apk` to the phone.
5. On the phone, allow installing from that source and install it.
6. Open the app. Enter the server address (starting with https) and the
   token from step 2. Tap "Save and connect". Changing the address later
   clears the token and the PIN on purpose, so anyone who points the phone
   at their own server gets neither.
7. Tap "Allow reading text messages" and allow it.
8. Tap "Turn off battery saving for this app" and allow it. Without this,
   some phones stop the app after a few hours.
9. The status at the bottom should read "Reported in; nothing waiting."
   within a minute. In the command centre, the Phone bridge page shows the
   phone as heard from, and the launch checklist line for that network
   turns green.

## Checking it works, not just that it is set up

Send a small airtime transfer from any number on that network to the SIM in
the phone. Within a minute:

- the Phone bridge page shows the phone heard from just now;
- the Airtime in page shows the amount and the sender, matched to a
  transfer if one was waiting, or in the unmatched list if not.

If the message appears under "Messages the parser did not understand", the
network words its message differently from what the built-in reading
expects. Copy the message into "Try a pattern on a real message", write a
pattern with `(?<amount>...)` and `(?<sender>...)`, check it reads the
right amount and number, then save it under Settings, Networks, "How to
read the network's airtime received message".

## When a phone goes quiet

The checklist turns red for that network after 30 minutes without a report.
Check, in this order: power, signal, data, that the app is still installed,
that battery saving is off for it. Open the app and tap "Send now"; the
status line says what happened. Until it is back, record airtime by hand
under Airtime in, from the messages on the phone's screen.

## Sending from the phone

The same phone can send airtime and gift bundles from its SIM, on the
server's instruction: payouts on a network you route to the phone under
Settings, Guardrails; every refund; and every bundle or airtime delivered
from a pool. To turn it on, on the phone:

1. Tap "Allow sending from this SIM" and allow phone calls. Android needs
   that permission to dial a code. On newer phones it also asks to show a
   notification; allow it, because the app keeps a small notice on screen
   while it is on duty.
2. Enter the SIM's transfer PIN and tap "Save PIN". The PIN stays on the
   phone. The server sends each code with the PIN left blank and the phone
   fills it in before dialling. Nobody else ever sees it.
3. The status shows "Sending from this SIM: allowed" and "Transfer PIN:
   saved". In the command centre the phone shows "Can send: yes", and the
   checklist line for sending on that network turns green.

What happens on each send: the server queues a command with the code, the
number and the amount; the phone fetches it once, dials it, and reports the
network's reply. A reply that reads as a confirmation for that number, or
the network's own text message afterwards, completes the payout or refund.
A reply that reads as a final refusal leaves the item for a person with the
network's words. A busy network is retried after a wait. A command that
gets no confirmation within the timeout is never dialled again: it is left
on the Phone bridge page for a person to read the phone and settle.

Some networks answer a transfer code with a menu asking for confirmation.
The phone can only make one request per code; where a network does that,
the confirmation still comes by text message and settles the command. If
a network's reply is not being read, paste it into the pattern tester on
the Phone bridge page and set the "sent confirmation" pattern for that
network under Settings, Networks.

## What the app does and does not do

- It reads text messages as they arrive and forwards them. It does not send
  messages, read contacts, or use the internet for anything else.
- When sending is allowed and a PIN is saved, it dials the codes the server
  asks for, each once, and reports the reply. It dials nothing else.
- It keeps messages in a file until the server has accepted them, so a
  dead spot or a restart loses nothing. The same message sent twice is
  counted once by the server.
- It reports in every fifteen minutes even with nothing to send, with its
  battery level and how many messages are waiting.
- It talks only over https and only to the address you entered.

## Building it yourself

The app is in `bridge-android`. With the Android SDK installed:

```
cd bridge-android
./gradlew :app:assembleDebug
```

The file is written to `app/build/outputs/apk/debug/app-debug.apk`.
