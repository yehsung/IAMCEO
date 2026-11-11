# Security overview

[한국어](security.md)

What IAMCEO trusts, what it blocks, and what it does not block. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

In one line: **the ways into the server on your Mac from outside are guarded. The AI sessions that run on your Mac as you are not confined.**

## The shape of it

- The IAMCEO server runs on your Mac as your macOS user. There is no server run by IAMCEO.
- The lead, the staff and the HQ agent are the official Claude Code and Codex CLIs, running as the **same macOS user** as the server.
- The Mac app and the iPhone app connect to the server with one access code. The iPhone connects over Tailscale.

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

**Connecting an iPhone**

- The connection QR does not contain the access code. It carries an 8-character code that works once, for 5 minutes, and the access code is returned only to the device that presents it. Ten wrong tries from one address within 5 minutes are held off for a while.
- A connection link opened from outside the app first shows the address it leads to and connects only after you confirm. If a Mac is already connected, it says that this would replace it. A link whose address is not a Tailscale address is not opened.
- The iPhone keeps the access code in a Keychain item that stays on that device. The code is never sent to an attachment on another address or along a redirect.
- A notification carries only a fixed sentence and identifiers. Tapping one never answers, approves or types into a terminal for you.

**The channel AI sessions use to reach the server**

- This channel accepts requests from this Mac only. Other devices on the tailnet cannot use it.
- A session can call the server's tools only with a token issued for that session, and the token is tied to its own project.
- Each role has its own set of tools. Staff cannot use the tools that hand out work, and only the HQ agent can create a project.
- Only the server writes the source label on the text an agent receives. A line inside the text that imitates a label is turned into a quote.
- When the lead passes on your words, the server compares them with what you wrote and marks the result. Your answer to a decision is delivered by the server straight to the staff member who asked.
- Agents have no tool that presses an approval prompt. That path exists only on your screen.
- The server answers exactly one prompt on its own. If you said "I trust this folder" when creating a project, the server picks "trust" on the folder-trust prompt the CLI shows in that project's folder. It does so only when the prompt's wording and folder path match exactly, and it records the choice in the activity log. A prompt it cannot read exactly, and every other approval prompt, is left alone.

**Files**

- A file an agent uploads is accepted only when its real location, after following symbolic links, is inside the working folder. Secret folders such as `~/.ssh`, `.env` files, private keys, shell history and IAMCEO's own settings and database are refused wherever they are. Hard-linked files are refused too.
- HTML pages made by agents open in an isolated frame inside the app: a web view that keeps no storage, with outside requests, cookies, access to the server and navigation to other pages blocked. Attachment responses carry the same isolation marking, so an uploaded HTML file cannot run as script on the server's address.

**Install and update**

- The Mac app is signed with a Developer ID and notarized by Apple.
- The install script compares the download with the release's SHA-256 value. It then checks that the app is signed by the IAMCEO publisher and notarized by Apple, and installs nothing if either check fails.
- The bundled herdr-core is used only when it matches the pinned version's SHA-256 value and its maker's signature.
- The push key (`.p8`) is never put into a backup.

## What is not blocked

Stated plainly.

- **There is no real wall between a staff session and you.** A staff session runs as the same macOS user as the server, so its shell can read the access code and the database in `~/.iamceo`. A program that has the access code can use the server as if it were you. So the Inbox, the owner-quote check and the separation between projects are **guards against mistakes, not isolation.** They catch a lead that misremembers or invents an approval. They do not stop a session that sets out to get around them, including one that has followed instructions hidden in a web page or a file.
- **The default permission mode is "don't ask".** In that mode the CLI shows no approval prompt and uses no sandbox. An agent can do what your user can do. The HQ agent's working folder is your home folder. If you want the CLI to hold back, choose "ask only when risky" or "ask every time" in Settings.
- **"Ask before committing, pushing, deleting or sending anything outside" is an instruction.** It is a promise the agents follow. The server does not intercept those commands.
- **There is one access code per server.** Devices do not get their own. You cannot cut off a single device, and the server keeps no record of who connected when.
- **The default connection is not HTTPS.** Encryption between iPhone and Mac relies on Tailscale. If you connect through an HTTPS address made with Tailscale Serve, the app's own traffic is encrypted as well.
- **The iPhone app has no lock of its own.** Someone holding your unlocked iPhone can open the app, give instructions, answer decisions and type into a terminal.
- **Backups contain the access code as it is.** Files in `~/.iamceo/backups` are readable only by you, but file permissions are not encryption.

## If you lose a device

If a device that holds the access code (an iPhone, another Mac) is lost, or you think the code has leaked:

1. Remove that device from your tailnet in the Tailscale admin console. It can no longer reach the server's port.
2. Change the access code in a terminal on the Mac that runs the server. The server must be running, and this works only from that Mac.

   ```sh
   /Applications/IAMCEO.app/Contents/Resources/runtime/iamceo auth rotate
   ```

   If you installed from source and have the `iamceo` command, `iamceo auth rotate` is the same thing. The new code is printed.
3. At that moment every connection made with the old code, and every unused connection QR, is cut off. Reconnect the Mac app with **이 Mac에서 시작** (Start on this Mac) and the iPhone with a new QR.
4. If the command fails or the reply is lost, the code may already have changed. Do not rotate again; check the current code on the same Mac.

   ```sh
   /Applications/IAMCEO.app/Contents/Resources/runtime/iamceo open
   ```

나가기 (Leave) in the iPhone's settings only deletes the code stored on that iPhone. The server's code stays the same, so it is not a way to cut off a lost device.

## On a shared tailnet

On a tailnet shared with a company or a family, other people's devices can reach your Mac's server port (7878 by default) as well. They cannot use it without the access code, but it is safer to narrow who can reach it in the first place.

- In Tailscale's access controls (ACLs), allow only your own devices to reach port 7878 on this Mac. See the [Tailscale ACL documentation](https://tailscale.com/kb/1018/acls).
- Do not paste the access code into a chat, a screen share or a URL.
- If you have set the server to listen on your local network (LAN) as well, remember that every device on that network can reach the port.
