# Connecting an iPhone

[한국어](iphone.md) · [All user guides](README.md)

The iPhone app reaches the IAMCEO server on your Mac through [Tailscale](https://tailscale.com). No ports are opened and the connection goes through no relay. The only server the developer runs is the notification relay that hands iPhone notifications to Apple (see [Notifications](#notifications)).

## What you need

- **The iPhone app:** [get it on the App Store](https://apps.apple.com/app/id6831782194). iPhone only, iOS 17 or later; iPad is not supported.
- **Tailscale:** install it on the Mac and the iPhone, sign in with the **same account** and turn it on.
- **MagicDNS:** MagicDNS must be on in the DNS settings of the Tailscale admin console (a new tailnet has it on from the start). The iPhone blocks unencrypted connections to numeric `100.x.x.x` addresses, so the app connects through the `<device name>.<tailnet>.ts.net` name.
- **The Mac server must be running.** Press 이 Mac에서 시작 (Start on this Mac) once in the Mac app and the server starts whenever the Mac does.

## Connecting

1. In the Mac app, open **설정 → 연결 → iPhone 연결** (Settings → Connection → Connect iPhone). A pairing QR appears.
2. In the iPhone app's first screen press **QR 스캔** (Scan QR), or point the iPhone's own Camera at the QR and tap the banner.
3. The iPhone app shows the address it is about to connect to. Confirm when it is your Mac. If it is already connected to another Mac, it says this would replace it.

The pairing QR does not contain the access code. It holds a code that works once within five minutes, and **a key for that device alone** goes only to the device that used it. When it runs out, press **새 QR 만들기** (New QR). A link whose address is not a Tailscale address is not opened.

## Connected devices

**설정 → 연결 → 연결된 기기** (Settings → Connection → Connected devices) lists what is connected to the server. The Mac app and the iPhone app show the same list.

- Each device connected with a QR code has its own row: its name, when it last connected and when it was paired. The device you are using is marked **이 기기** (This device). **끊기** (Disconnect) cuts off that device alone, at once; the others stay connected. To use a disconnected device again, connect it with a new QR.
- **Only the app on the Mac that runs the server can disconnect other devices.** On an iPhone or another Mac, only your own row (**이 기기**, This device) has **끊기** (Disconnect), and the list ends with "Other devices can be disconnected on the Mac that runs the server." Disconnecting your own row removes the key stored on this device and returns to the connection screen (your drafts stay). This keeps one lost or stolen device from disconnecting the rest → [Security](../security.en.md#what-is-blocked)
- The **공용 접속 코드** (Shared access code) row is the app on this Mac, any device where the code was typed in, and an iPhone paired before devices had their own keys. That row cannot be cut off one device at a time; changing the access code on the Mac cuts it off. Reconnecting an older iPhone once with a new QR moves it to a row of its own.
- **최근 실패한 시도** (Recent failed attempts) counts tries in the last 7 days with a wrong code or the key of a disconnected device. Only the address and time are kept, never the code.

Instead of the QR you can type the address and the access code (**주소와 접속 코드를 직접 입력**, Enter the address and access code, on the iPhone's first screen). Copy the command at the bottom of the connection screen and run it in a terminal on the Mac: it prints the address and the access code. When the app knows that Mac's server runs from inside the app (it connected to it before, or it is the Mac app on that same Mac), the command uses the path inside the app (`/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo open`); otherwise it reads `iamceo open`. Unless you set up a short name for `iamceo`, run it with the path inside the app → [Getting started](getting-started.en.md#the-command-line-tool)

To change the app language before you connect, use the **언어** (Language) menu at the bottom of the first screen, next to the privacy policy, and pick Automatic, 한국어 or English. The new language shows after you close the app completely and open it again → [Getting started](getting-started.en.md#app-language)

## HTTPS address (optional)

By default Tailscale encrypts the link between the iPhone and the Mac, and the app connects over it with a plain address (`http://<device name>.<tailnet>.ts.net:7878`). If you want the app's own connection encrypted as well, you can use an HTTPS address.

- **Turning it on:** in the Mac app, under **설정 → 연결 → iPhone 연결** (Settings → Connection → Connect iPhone), press **켜기** (Turn on) on the **HTTPS 주소** (HTTPS address) row and confirm. The server opens HTTPS (port 443) on this Mac's Tailscale with `tailscale serve` and hands it to the IAMCEO server. Only devices in the same tailnet can reach it; nothing is opened to the internet. The first time can take about a minute while the certificate is issued. The server never turns this on by itself, because it changes your Tailscale settings.
- **After that:** the first address in every new pairing QR is `https://<device name>.<tailnet>.ts.net`, so newly paired iPhones connect over HTTPS. The released iPhone apps (0.2.2, 0.2.3) follow it without an update. iPhones that are already connected stay connected on their current address; pairing one again with a new QR moves it to HTTPS.
- **If it says it cannot turn on:** follow the message. The most common cause is that HTTPS certificates are off for the tailnet. Turn on **MagicDNS** and **HTTPS Certificates** in the [DNS settings of the Tailscale admin console](https://login.tailscale.com/admin/dns) and press it again (the row's **Tailscale 관리 화면** (Tailscale admin console) button opens that page). If something else already uses HTTPS (443) on this Mac, IAMCEO leaves it alone and does not turn on.
- **Turning it off:** press **끄기** (Turn off) in the same place. Only the Tailscale setting the server made is removed. iPhones connected through the HTTPS address are cut off; pair them again with a new QR.
- Turning it on and off works only from the app on the Mac that runs the server.

**Nothing is sent while the iPhone's Tailscale is off (from the next iPhone app).** A plain address is encrypted only while Tailscale is on, so before sending a request to a plain address the iPhone app checks that this iPhone's Tailscale is on (by the tailnet address on the Tailscale tunnel; a 100.x address from a carrier or another VPN alone does not count). If it is off, the app sends nothing and says so ("이 iPhone의 Tailscale이 꺼져 있어 보내지 않았습니다", Tailscale is off on this iPhone, so nothing was sent). It reconnects by itself once Tailscale is on. An iPhone connected through the HTTPS address is protected by HTTPS and does not need this check.

## Notifications

- **Mac:** works. Turn on **설정 → 알림 → Mac 알림** (Settings → Notifications → Mac notifications) in the Mac app. It tells you about new decisions, approval or choice waits, finished and blocked reports, and to-dos for you.
- **iPhone (from the next release):** works with the App Store app; turn notifications on in the iPhone app's settings. When your Mac has no Apple push key for the app, the server hands each notification to the **notification relay** run by the developer, which sends it to Apple. The relay receives only the push token, the notification type, random IDs and an expiry time, and stores none of them → [Privacy](../../PRIVACY.md). To turn the relay off, put `"pushRelay": false` in `~/.iamceo/config.json` and restart the server (the App Store app then gets no iPhone notifications). An app you build yourself sends with your own key → [native guide](../../native/README.md#iphone-apns-and-signing)
- **If turning notifications on failed before**, update the server and then turn the notification switch on again in the iPhone app's settings (the first prompt does not come back).
- If notification settings say "The notification service is temporarily unavailable", the relay cannot be reached for now. The server sends again on its own; just wait.

A notification carries a fixed sentence and identifiers only, never conversation content. Tapping it never answers, approves or types anything for you.

## When it does not connect

Check these in order.

1. **Is Tailscale on on the Mac?** On a Mac an iPhone has been connecting to, Tailscale being off for more than a minute raises a Mac notification and a line in the Mac app. Turn it back on and the iPhone connects again; the line goes away.
2. **Is Tailscale on on the iPhone?** Look at the VPN indicator and the Tailscale app.
3. **Are both devices in the same tailnet?** Each should appear in the other's device list in the Tailscale app.
4. **Is MagicDNS on?** See "What you need" above.
5. **Is the Mac awake?** While the server runs, the Mac does not go to sleep on its own when idle, but closing the lid or putting it to sleep makes it unreachable from the iPhone.
6. **Did you replace the access code, or was this device disconnected?** `iamceo auth rotate` disconnects the devices on the shared access code. Disconnecting this device under Connected devices on the Mac that runs the server does the same for it. Connect again with a new QR.

On the Mac, `iamceo doctor` shows the current state in its Tailscale item → [Troubleshooting](troubleshooting.en.md)

## While it is not connected

**The last seen state.** The App keeps the last state the server confirmed (the project list, and the team, decisions, to-dos, files and recent conversation of the project you were on) on the iPhone. If you open the App and the server is out of reach, you see that state with a **Last seen · 12 min ago** line instead of an empty connection screen. It may differ from now, so it is read-only: you cannot answer decisions or control staff. **Reconnect** on that line tries again, and as soon as the server answers the screen switches to the current state. Tapping a notification also takes you to its screen (the Inbox, for example) and opens the notification properly once connected. To change the server address, choose **Sign out** in Settings and connect again.

**Messages that wait for the connection.** While disconnected, the composer's send button turns into a clock. Pressing it keeps the message on the iPhone and clears the composer; once connected, the messages are sent one at a time, oldest first. Under the composer, **n messages to send when connected · View** lets you edit or delete them until they go. Send messages with attachments after you reconnect.

- A message written more than a day ago is not sent automatically when the connection comes back, because an old instruction may no longer fit. The composer shows **n messages over a day old · Need your review**, and in the list you choose **Send**, **Edit** or **Delete** for each one. Later messages wait and go out in order once the earlier ones are settled. Messages written within a day are sent in order, once each, as before.
- A message belongs to the server it was written for. If you connect to another server, the messages for the previous one are neither deleted nor sent to the new one: they appear at the bottom of the list under **n messages meant for another server**, grouped by server address, where you can only read, **Copy** or **Delete** them. They are sent in order when you reconnect to that server. Reconnecting to the same server through another address (the HTTPS address, its Tailscale name or its 100.x address) is recognized as the same server, and the messages are sent as usual.
- A message is deleted from the device 30 days after it was written. For its last 7 days the list marks it **Deleted soon**. Editing it or choosing **Send** starts the count again.

- Only messages that have never been sent wait there. A message leaves the list the moment it starts sending.
- If a message was sent but its result is unknown (the connection dropped before the answer), it is not sent again; the App asks the server whether it arrived. The next message waits meanwhile.
- If the server did not accept one, the rest pause. Resend it, put it back in the composer or discard it from "Unsent message" above the composer, then press **Continue sending** in the list.
- While the App is still confirming whether an earlier message from the same composer arrived, you can queue a new one only after that check ends (so the same message is never sent twice).
- Messages left for an archived or deleted project have nowhere to go; they appear separately at the bottom of the list. Copy anything you need, then delete them.
- Connecting to another server deletes the messages that were waiting for the previous server. Reconnecting to the same Mac through another address (its Tailscale address, Mac name or HTTPS address) keeps them and sends them. Up to 50 messages can wait for one server.

Neither leaves the iPhone or goes into device backups, and both are kept in files that cannot be read while the iPhone is locked → [Privacy Policy](../../PRIVACY.md#english)

## On a shared tailnet

On a tailnet shared with a company or family, other people's devices can reach your Mac's server port (7878 by default). They cannot use it without the access code, but it is safer to narrow who can reach it to your own devices with Tailscale's access controls (ACLs) → [Security](../security.en.md#on-a-shared-tailnet)

## Leaving and lost devices

나가기 (Sign out) in the iPhone's settings removes the access code stored on that iPhone, along with that server's last seen state and the messages waiting for the connection (the confirmation says how many; messages meant for another server stay); the server's code and keys stay the same. If you lose the iPhone, remove it from Tailscale and press **끊기** (Disconnect) next to it under **연결된 기기** (Connected devices) in the app on the Mac that runs the server (in a terminal on that Mac: `iamceo auth devices` shows the IDs, then `iamceo auth revoke-device <ID>`). If you cannot tell which row it is, run `iamceo auth revoke-devices` on the Mac to disconnect every device paired by QR, then pair the ones you keep again with a new QR. If it is not listed on its own because it uses the shared access code, replace the access code on the Mac → [Security](../security.en.md#if-you-lose-a-device)
