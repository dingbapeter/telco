# The phone bridge

One Android phone per network holds our receiving SIM. A small app on it
forwards every text message the phone receives to the server, which reads
the network's "you have received airtime" message, matches it to the
waiting transfer, and books it. Nothing is ever paid out on a sender's word:
only on the network's own message, seen by our own phone.

## What you need

- One Android phone per network (Android 7 or newer; a cheap one is fine),
  with our SIM for that network in it, on charge, with data on.
- The server running on an https address.

## Setting a phone up

1. In the command centre, under Receiving numbers, add the number of the SIM
   in the phone.
2. Under Phone bridge, add a phone: pick the network, give it a label. The
   page shows a token once. Keep that screen open.
3. Get the app. Every push to the repository builds it in CI; open the
   latest green run on GitHub, under Actions, and download the file called
   `telco-bridge-app`. Unzip it and copy `app-debug.apk` to the phone, or
   open the link on the phone.
4. On the phone, allow installing from that source and install it.
5. Open the app. Enter the server address (starting with https) and the
   token from step 2. Tap "Save and connect".
6. Tap "Allow reading text messages" and allow it.
7. Tap "Turn off battery saving for this app" and allow it. Without this,
   some phones stop the app after a few hours.
8. The status at the bottom should read "Reported in; nothing waiting."
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

## What the app does and does not do

- It reads text messages as they arrive and forwards them. It does not send
  messages, read contacts, or use the internet for anything else.
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
