# Connecting an iPhone

[한국어](iphone.md) · [All user guides](README.md)

The iPhone app reaches the IAMCEO server on your Mac through [Tailscale](https://tailscale.com). No ports are opened and there is no relay. There is no server run by IAMCEO.

## What you need

- **The iPhone app:** [get it on the App Store](https://apps.apple.com/app/id6831782194). iPhone only, iOS 17 or later; iPad is not supported.
- **Tailscale:** install it on the Mac and the iPhone, sign in with the **same account** and turn it on.
- **MagicDNS:** MagicDNS must be on in the DNS settings of the Tailscale admin console (a new tailnet has it on from the start). The iPhone blocks unencrypted connections to numeric `100.x.x.x` addresses, so the app connects through the `<device name>.<tailnet>.ts.net` name.
- **The Mac server must be running.** Press 이 Mac에서 시작 (Start on this Mac) once in the Mac app and the server starts whenever the Mac does.

## Connecting

1. In the Mac app, open **설정 → 연결 → iPhone 연결** (Settings → Connection → Connect iPhone). A pairing QR appears.
2. In the iPhone app's first screen press **QR 스캔** (scan QR), or point the iPhone's own Camera at the QR and tap the banner.
3. The iPhone app shows the address it is about to connect to. Confirm when it is your Mac. If it is already connected to another Mac, it says this would replace it.

The pairing QR does not contain the access code. It holds a code that works once within five minutes, and **a key for that device alone** goes only to the device that used it. When it runs out, press **새 QR 만들기** (new QR). A link whose address is not a Tailscale address is not opened.

## Connected devices

**설정 → 연결 → 연결된 기기** (Settings → Connection → Connected devices) lists what is connected to the server. It looks the same in the Mac app and the iPhone app.

- Each device connected with a QR code has its own row: its name, when it last connected and when it was paired. The device you are using is marked **이 기기** (this device). **끊기** (Disconnect) cuts off that device alone, at once; the others stay connected. To use a disconnected device again, connect it with a new QR.
- The **공용 접속 코드** (shared access code) row is the app on this Mac, any device where the code was typed in, and an iPhone paired before devices had their own keys. That row cannot be cut off one device at a time; changing the access code on the Mac cuts it off. Reconnecting an older iPhone once with a new QR moves it to a row of its own.
- **최근 실패한 시도** (recent failed attempts) counts tries in the last 7 days with a wrong code or the key of a disconnected device. Only the address and time are kept, never the code.

## Notifications

- **Mac:** works. Turn on **설정 → 알림 → Mac 알림** (Settings → Notifications → Mac notifications) in the Mac app. It tells you about new decisions, approval or choice waits, finished and blocked reports, and to-dos for you.
- **iPhone:** a push notification is sent only when your Mac's server holds the **Apple push key that belongs to that iPhone app**. IAMCEO runs no server of its own, so nothing else can send it for you. The iPhone app from the App Store therefore **cannot receive notifications today**. They work only with an iPhone app you build yourself and your own key → [native guide](../../native/README.md#iphone-apns-and-signing)

A notification carries a fixed sentence and identifiers only, never conversation content. Tapping it never answers, approves or types anything for you.

## When it does not connect

Check these in order.

1. **Is Tailscale on on the Mac?** On a Mac an iPhone has been connecting to, Tailscale being off for more than a minute raises a Mac notification and a line in the Mac app. Turn it back on and the iPhone connects again; the line goes away.
2. **Is Tailscale on on the iPhone?** Look at the VPN indicator and the Tailscale app.
3. **Are both devices in the same tailnet?** Each should appear in the other's device list in the Tailscale app.
4. **Is MagicDNS on?** See "What you need" above.
5. **Is the Mac awake?** While the server runs, the Mac does not go to sleep on its own when idle, but closing the lid or putting it to sleep makes it unreachable from the iPhone.
6. **Did you replace the access code, or was this device disconnected?** `iamceo auth rotate` disconnects the devices on the shared access code. Disconnecting this device under Connected devices on another device does the same for it. Connect again with a new QR.

On the Mac, `iamceo doctor` shows the current state in its Tailscale item → [Troubleshooting](troubleshooting.en.md)

## On a shared tailnet

On a tailnet shared with a company or family, other people's devices can reach your Mac's server port (7878 by default). They cannot use it without the access code, but it is safer to narrow who can reach it to your own devices with Tailscale's access controls (ACLs) → [Security](../security.en.md#on-a-shared-tailnet)

## Leaving and lost devices

나가기 (Leave) in the iPhone's settings removes only the access code stored on that iPhone; the server's code and keys stay the same. If you lose the iPhone, remove it from Tailscale and press **끊기** (Disconnect) next to it under **연결된 기기** (Connected devices) in the Mac app. If you cannot tell which row it is, run `iamceo auth revoke-devices` on the Mac to disconnect every device paired by QR, then pair the ones you keep again with a new QR. If it is not listed on its own because it uses the shared access code, replace the access code on the Mac → [Security](../security.en.md#if-you-lose-a-device)
