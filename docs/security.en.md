# Security overview

[한국어](security.md)

What IAMCEO trusts, what it blocks, and what it does not block. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

In one line: **the ways into the server on your Mac from outside are guarded. The AI sessions that run on your Mac as you are not confined.**

## The shape of it

- The IAMCEO server runs on your Mac as your macOS user. There is no server run by IAMCEO.
- The lead, the staff and the HQ agent are the official Claude Code and Codex CLIs, running as the **same macOS user** as the server.
- The app on this Mac and any device you connect by typing the code use the shared access code. A device connected with a QR code gets a key of its own. The iPhone connects over Tailscale.

## What is trusted

| Trusted | Why, and how far |
|---|---|
| Devices on the same tailnet | The server accepts requests from Tailscale addresses. A device that is in your tailnet is assumed to be able to reach the server's port. What stands behind that is the access code. |
| The same macOS user | The server, herdr-core (which holds the terminals), the AI CLIs and the Mac app all run as one user. Any program running as that user can read IAMCEO's data folder (`~/.iamceo`). |
| The AI providers' CLIs, Tailscale, Apple | The CLI handles command permissions and approval prompts, Tailscale handles encryption between devices, Apple handles app signing and notification delivery. |

## What is blocked

**Ways into the server**

- By default the server listens only on this Mac itself (`127.0.0.1`) and on its Tailscale address. The setup command (`iamceo setup`) refuses a value that would listen on every address (`0.0.0.0`). Written directly into `~/.iamceo/config.json` it does open, but even then a request is accepted only when the peer address is this Mac or in the confirmed Tailscale range.
- An address is not taken for Tailscale just because it is in Tailscale's range (100.64.0.0/10); carriers and routers hand out the same range. The server listens on such an address only when it sits on Tailscale's tunnel interface or the `tailscale` command confirms it. If neither does, the server opens on this Mac only and accepts no request from that range.
- Three things are checked on every request before anything else: that the peer address is this Mac or in the Tailscale range (or a range you set yourself), that the name the request was sent to (Host) is an allowed one, and that the origin a browser reports (Origin) matches that name. If any of them fails, the request is refused before authentication is even looked at.
- Authentication is the access code in the request header (Bearer) and nothing else. Cookies and codes in the URL are not accepted. That is why a web page you happen to open cannot quietly send requests to your server.
- The access code is 16 characters without look-alike letters (80 bits), compared in a way that leaks no timing. It is stored in `~/.iamceo/config.json`, readable only by you (0600).
- A device connected with a QR code gets a key of its own (256 bits). The server keeps only a hash of the key in its database, never the key itself, and compares it without leaking timing. Every place that checks the access code (requests, the live connection, terminal views, attachments) uses the same check.
- Attempts with a wrong code or with the key of a device you disconnected, new device connections, disconnections and code changes are recorded. The record holds addresses, times and device names, never a code or key. Entries older than 90 days are deleted. You can see it in Settings → 연결 (Connection) → **연결된 기기** (Connected devices).

**Connecting an iPhone**

- The connection QR does not contain the access code. It carries an 8-character code that works once, for 5 minutes, and a key for that device alone is returned only to the device that presents it. Ten wrong tries from one address within 5 minutes are held off for a while.
- A connection link opened from outside the app first shows the address it leads to and connects only after you confirm. If a Mac is already connected, it says that this would replace it. A link whose address is not a Tailscale address is not opened.
- The iPhone keeps the access code in a Keychain item that stays on that device. The code is never sent to an attachment on another address or along a redirect.
- A notification carries only a fixed sentence and identifiers. Tapping one never answers, approves or types into a terminal for you.
- **Other devices are disconnected only on the Mac that runs the server.** Each device can disconnect only itself; on any other device the 연결된 기기 (Connected devices) list is read-only. A device key works for whoever holds it, so the Mac you actually have in hand is the root of trust: a lost or stolen device cannot disconnect your other devices and lock you out. "The Mac that runs the server" means the request came directly from inside that Mac; a request that arrives through the HTTPS address (`tailscale serve`) does not count. If the released iPhone app 0.2.4 or earlier tries to disconnect another device, it only gets the note "Other devices can be disconnected on the Mac that runs the server" and nothing is disconnected.

**The channel AI sessions use to reach the server**

- This channel accepts requests from this Mac only. Other devices on the tailnet cannot use it.
- A session can call the server's tools only with a token issued for that session, and the token is tied to its own project.
- Each role has its own set of tools. Staff cannot use the tools that hand out work, and only the HQ agent can create a project.
- Only the server writes the source label on the text an agent receives. A line inside the text that imitates a label is turned into a quote.
- When the lead passes on your words, the server compares them with what you wrote and marks the result. Your answer to a decision is delivered by the server straight to the staff member who asked.
- Agents have no tool that presses an approval prompt. That path exists only on your screen.
- The server answers exactly one prompt on its own. If you said "I trust this folder" when creating a project, the server picks "trust" on the folder-trust prompt the CLI shows in that project's folder. It does so only when the prompt's wording and folder path match exactly, and it records the choice in the activity log. A prompt it cannot read exactly, and every other approval prompt, is left alone.
- With the permission mode set to "ask only when risky" or "ask every time", a Claude Code staff member's tool-permission prompt also appears in the inbox as a "도구 승인" (tool approval) card. The card is posted to this Mac's server by the CLI's official hook, and only the answer you pick in the inbox (allow this one time, or deny) goes back to the CLI through that hook. Agents have no tool that answers or closes the card. With no answer (10 minutes, server off, connection lost) the CLI keeps using its own prompt in the terminal. The card carries only a summary of the command, file path or URL, masks values that look like tokens or passwords, and the raw tool input is not stored. The hook does not put the staff member's key on its command line; it reads it from that staff member's settings file (mode 0600).

**Files**

- A file an agent uploads is accepted only when its real location, after following symbolic links, is inside the working folder. Secret folders such as `~/.ssh`, `.env` files, private keys, shell history and IAMCEO's own settings and database are refused wherever they are. Hard-linked files are refused too.
- HTML pages made by agents open in an isolated frame inside the app: a web view that keeps no storage, with outside requests, cookies, access to the server and navigation to other pages blocked. Attachment responses carry the same isolation marking, so an uploaded HTML file cannot run as script on the server's address.

**Diagnostic files and project exports**

- Making a diagnostic file and exporting a project are accepted only from this Mac. Other devices on the tailnet, the iPhone included, cannot use them.
- A diagnostic file leaves out the text of conversations, reports, decisions, to-dos and files, attachments, the access code, staff keys, push tokens and environment variable values. From the database it copies only listed columns (IDs, states, times, counts), and from the logs only the end, with known secrets masked. Logs can still contain file paths and project names.
- A project export zip contains that project's conversations and original attachments as they are (without the access code, staff keys or internal delivery records). Store and share it with care.

**Install and update**

- The Mac app is signed with a Developer ID and notarized by Apple.
- The install script compares the download with the release's SHA-256 value. It then checks that the app is signed by the IAMCEO publisher and notarized by Apple, and installs nothing if either check fails.
- The bundled herdr-core is used only when it matches the pinned version's SHA-256 value and its maker's signature.
- `iamceo upgrade` uses only an app that passes the same checks as the install script (checksum, publisher signature, Apple notarization). Before replacing anything it rehearses the new version on a copy of the current database, and it returns to the previous version if the new one does not start.
- Once a day the Mac app asks GitHub for the latest release. It only asks; it never downloads or installs.
- The push key (`.p8`) is never put into a backup.

## What is not blocked

Stated plainly.

- **There is no real wall between a staff session and you.** A staff session runs as the same macOS user as the server, so its shell can read the access code and the database in `~/.iamceo`. A program that has the access code can use the server as if it were you. So the Inbox, the owner-quote check and the separation between projects are **guards against mistakes, not isolation.** They catch a lead that misremembers or invents an approval. They do not stop a session that sets out to get around them, including one that has followed instructions hidden in a web page or a file.
- **The default permission mode is "don't ask".** In that mode the CLI shows no approval prompt and uses no sandbox. An agent can do what your user can do. The HQ agent's working folder is your home folder. If you want the CLI to hold back, choose "ask only when risky" or "ask every time" in Settings.
- **"Ask before committing, pushing, deleting or sending anything outside" is an instruction.** It is a promise the agents follow. The server does not intercept those commands.
- **Devices on the shared access code cannot be cut off one at a time.** That covers the app on this Mac, any device you connected by typing the code, and an iPhone connected with a QR code before devices had their own keys. To cut them off you change the code, which cuts off all of them. To make an iPhone removable on its own, reconnect it with a new QR code so it gets its own key.
- **Device keys do not split reading, decisions and terminals.** Any device can do all of them. Only the app on this Mac (on the shared access code) can make a new connection QR, so a device key cannot be used to collect more keys. Changing the shared access code, revoking every device key and disconnecting another device are limited to this Mac.
- **The default connection is not HTTPS.** Encryption between iPhone and Mac relies on Tailscale. Turn on the **HTTPS address** under Settings → Connection → Connect iPhone in the Mac app (the server makes it with `tailscale serve`) and iPhones paired by QR after that have the app's own traffic encrypted as well. iPhones already connected move over only when paired again with a new QR. From the next iPhone app, nothing is sent to a plain address while Tailscale is off; the released iPhone apps 0.2.2 and 0.2.3 do not have this check → [Connecting an iPhone](guide/iphone.en.md#https-address-optional)
- **The iPhone app has no lock of its own.** Someone holding your unlocked iPhone can open the app, give instructions, answer decisions and type into a terminal.
- **Backups contain the shared access code as it is.** Device keys are stored only as hashes. Files in `~/.iamceo/backups` are readable only by you, but file permissions are not encryption. A backup cloned to another Mac (`iamceo restore --clone`) refuses the original devices' keys and uses a new access code.

## If you lose a device

First remove that device from your tailnet in the Tailscale admin console. It can no longer reach the server's port.

**If it was connected with a QR code**, open Settings → 연결 (Connection) → **연결된 기기** (Connected devices) in the app on the Mac that runs the server and press **끊기** (Disconnect) on that device. Its connections close at once and every other device stays connected. If it tries to come back, the attempt shows under 최근 실패한 시도 (Recent failed attempts). Another iPhone or another Mac cannot do this (see "Other devices are disconnected only on the Mac that runs the server" above). You can also disconnect just that device from a terminal on that Mac: list the devices to find its ID, then disconnect it by that ID.

```sh
/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo auth devices
/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo auth revoke-device <ID>
```

If you cannot tell which row it is (for example, every row is called "iPhone"), revoke the keys of every device paired by QR from a terminal on the Mac that runs the server. The shared access code and the devices on it (such as the app on this Mac) stay connected; pair the devices you keep again with a new QR from the Mac app. It is safe to run again.

```sh
/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo auth revoke-devices
```

**If it uses the shared access code** (the 공용 접속 코드 row in that list), change the code. **If you think the code has leaked**, whoever has it may have collected a device key without a QR code, so add `--all-devices` in step 1 to revoke every device key as well:

1. Change the access code in a terminal on the Mac that runs the server. The server must be running, and this works only from that Mac.

   ```sh
   /Applications/IAMCEO.app/Contents/Resources/runtime/iamceo auth rotate
   ```

   If you installed from source and have the `iamceo` command, `iamceo auth rotate` is the same thing. The new code is printed. If the code has leaked, run `iamceo auth rotate --all-devices` instead.
2. At that moment every connection made with the old code, and every unused connection QR, is cut off. Devices that got their own key from a QR code stay connected (with `--all-devices` they are cut off too). Reconnect the Mac app with **이 Mac에서 시작** (Start on this Mac) and any iPhone that was cut off with a new QR.
3. If the command fails or the reply is lost, the code may already have changed. Do not rotate again; check the current code on the same Mac. If you used `--all-devices`, also run `iamceo auth revoke-devices` once more to be sure the device keys are revoked.

   ```sh
   /Applications/IAMCEO.app/Contents/Resources/runtime/iamceo open
   ```

나가기 (Sign out) in the iPhone's settings only deletes the code stored on that iPhone. The server's code and keys stay the same, so it is not a way to cut off a lost device.

## On a shared tailnet

On a tailnet shared with a company or a family, other people's devices can reach your Mac's server port (7878 by default) as well. They cannot use it without the access code, but it is safer to narrow who can reach it in the first place.

- In Tailscale's access controls (ACLs), allow only your own devices to reach port 7878 on this Mac. See the [Tailscale ACL documentation](https://tailscale.com/kb/1018/acls).
- Do not paste the access code into a chat, a screen share or a URL.
- If you have set the server to listen on your local network (LAN) as well, remember that every device on that network can reach the port.
