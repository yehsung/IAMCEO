# Troubleshooting

[한국어](troubleshooting.md) · [All user guides](README.md)

`iamceo` below is the command-line tool inside the app (`/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo`) → [Getting started](getting-started.en.md#the-command-line-tool)

## Start with the self-check

IAMCEO checks its own setup and shows, for each item, its state and a one-line fix.

- **In the app:** 설정 → AI 모델 → **실행 환경** (Settings → AI models → Runtime)
- **On the command line:** `iamceo doctor` (works while the server is down; `iamceo doctor --json` for a machine-readable result; exits with code 1 if any item failed)

| Item | What it checks | When it is a problem |
|---|---|---|
| Server | Whether the IAMCEO server on this Mac answers | Open the IAMCEO app and press 이 Mac에서 시작 (Start on this Mac). |
| Engine (herdr-core) | Whether the engine that holds the staff terminals is there and answers | If it stays that way, restart the Mac. If the engine is missing, reinstall the app (`brew reinstall --cask yehsung/tap/iamceo`). Homebrew stops the server and removes the login item when it reinstalls, so afterwards press 이 Mac에서 시작 (Start on this Mac) in the app once (staff sessions continue). |
| Claude Code | Installed, and signed in | Install it, then run `claude` in Terminal and sign in. |
| Codex | Installed, and signed in (fine if you do not use it) | Run `codex` in Terminal and sign in. |
| CLI versions | Whether IAMCEO has been tested against the installed CLI versions | See "Unverified CLI version" below. |
| Tailscale | Whether there is a Tailscale address the iPhone can reach | Turn on Tailscale from the menu bar. |
| Start at login | Whether the server is registered as a login item | Press 이 Mac에서 시작 in the app again. |
| Backup | When the last daily backup was made | Keep the Mac and server on; a backup is made once a day. If it keeps failing, check free space. |
| Disk space | Free space on the disk that holds the data folder | Free up space in System Settings → General → Storage. |

The sign-in check looks for the sign-in record a CLI leaves, so it can say "not checked". In that case the sign-in is checked when a session starts.

## Common problems

### A staff member stops right after starting

- **Check the sign-in.** Run `claude` (or `codex`) in Terminal; if it asks you to sign in, do so.
- **Check for settings that only work in your terminal.** The server does not get the environment variables and PATH from your shell settings (`~/.zshrc`). An MCP server or hook that relies on a variable such as `${GITHUB_TOKEN}`, or on a command installed through pyenv or mise, fails here. Put values in the `env` of the CLI's settings file and write commands as absolute paths.
- **Open that staff member's terminal from 팀 (Team).** See what is really on screen, and type into it if needed.

### "폴더 신뢰 확인 창을 읽지 못했습니다" (could not read the folder-trust prompt)

The folder-trust prompt the CLI showed did not match the text IAMCEO knows, so nothing was pressed. Press 터미널 열어 직접 답하기 (open the terminal and answer) on the card and answer with the arrow keys and Enter. This often follows a CLI update (see "Unverified CLI version").

### "시작이 늦어지고 있습니다" (the start is taking long)

More than 60 seconds have passed since the staff member was started and the CLI has not reported ready. It is not waiting for an approval. Open the terminal and see what is there; a sign-in screen, an update notice or an unfamiliar prompt are the usual causes.

### Unverified CLI version

When it starts, the server reads the installed Claude Code and Codex versions, records them with the time it first saw each in `~/.iamceo/cli-versions.json`, and checks whether IAMCEO has been tested against each one. For a version it has not been tested against, the CLI versions item in the self-check turns into "unverified CLI version". Most things keep working. But if the CLI changed the text of a prompt, the server may not recognize it and the staff member can stay blocked. Open the terminal and answer it yourself, and update IAMCEO when a new version is out.

### A tool-approval card closed

With the permission mode set to "ask only when risky" or "ask every time", a staff member's tool-permission prompt also appears in 결재함 (Inbox) as a "도구 승인" (tool approval) card. **허용** (Allow) runs it this one time; **거절** (Deny) does not run it and tells the staff member, with your note. Pick one of the two. A note sent without choosing counts as **거절** (Deny). The card closes when you have not answered within 10 minutes, when the prompt was answered in the terminal first, or when the server stops or restarts. A closed card cannot be reopened: if the staff member is still stopped, open that staff member's terminal from the team screen and answer the prompt there. If no card appears at all, check whether that staff member runs in "don't ask" mode or is a Codex staff member (cards appear for Claude Code staff only).

### A usage limit was hit

A usage-limit card arrives in 결재함 (Inbox). If you wait, work continues on its own once the limit clears.

- **A limit on one model only:** pick another model on the card, or change the staff member's model, to continue now. The same conversation continues on the new model.
- **The 5-hour and weekly limits** are shared by every model, so the card offers no model choice. Wait and it continues on its own.

### The network or the AI service is down

The app shows a waiting banner. Nothing you sent is lost; it is delivered once the outage clears. While the server believes an AI service is down, it sends an empty check request to see whether it is back.

### A delivery is left at "전달 확인 필요" (delivery needs checking)

The server could not confirm whether your message reached the CLI. Press 다시 확인 (check again) first. When unsure, the server never types the same message twice. To resend anyway, accept the duplicate risk and resend.

### A notice that the engine has a problem

The engine that holds the staff terminals is not answering or has the wrong version. If it stays that way, restart the Mac. When the server is back, it reopens the staff that were switched off, lead first, in the same conversations.

### The app and the server do not match

The app shows a notice only when the two really do not match, and it tells the two cases apart:

- **Update the app:** the app is older than the server. Update the iPhone app in the App Store, or install the new Mac app.
- **The server is an older version:** the server is older than the app. Update IAMCEO on the Mac that runs the server.

If you replaced the Mac app with a new version through the install script or a DMG and the server is still running the old one, the app asks once whether to restart the server on the new version. The staff sessions continue through the restart, because the engine holds them. After a Homebrew upgrade or reinstall there is no such question: the server is down, so press 이 Mac에서 시작 (Start on this Mac) in the app once. → [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md)

### The iPhone does not connect

First check that Tailscale is on on the Mac; the Mac app tells you when it is off. The rest is in [Connecting an iPhone](iphone.en.md#when-it-does-not-connect).

If the iPhone app says "이 iPhone의 Tailscale이 꺼져 있어 보내지 않았습니다" (Tailscale is off on this iPhone, nothing was sent), turn Tailscale on in the iPhone's Tailscale app; it reconnects by itself. If the Mac app says the **HTTPS 주소** (HTTPS address) cannot be turned on, follow the row's message (usually: turn on HTTPS certificates in the Tailscale admin console) → [Connecting an iPhone](iphone.en.md#https-address-optional)

## Making a diagnostic file

A diagnostic file attached to a question or an issue makes the cause much easier to find.

- **In the app:** 진단 파일 만들기 (make a diagnostic file) under 설정 → AI 모델 → 실행 환경 (when connected on this Mac)
- **On the command line:** `iamceo diagnose`

It creates a folder `~/.iamceo/diagnostics/<time>/` and a `.zip` of the same name. The five most recent are kept.

| Included | Not included |
|---|---|
| Server, engine, CLI and macOS versions (and the app's version when made from the app), the versions of apps that connected | The text of conversations, reports, decisions, to-dos and files |
| The self-check result and the service state | Attachments |
| The end of the server logs (known secrets masked) | The access code, staff keys and push tokens |
| Stall and restart records, the names of crash reports | Environment variable values |
| Backup state; a status summary of the database (IDs, states, times, counts); setting values | |
| The connection addresses (including the Tailscale address) and port; the paths of the data folder and the executables (which include your user name) | |

The logs and the summary can still contain file paths with your user name, the Tailscale address and project names. Open the file once before posting it anywhere public. For a vulnerability, do not open a public issue; follow [SECURITY.md](../../SECURITY.md).

## Logs

The server logs are `~/.iamceo/logs/server.log` and `server.err.log`. Each line carries the time it was received, and a full file rolls over to an older one.

## Changing the role rules

You can add rules to the role instructions the lead, staff and HQ agent receive, or replace them entirely. In file names the lead is `conductor`, staff is `worker` and the HQ agent is `root`.

**Add rules (recommended).** Write only the rules you want to add in `~/.iamceo/roles/<kind>.extra.md`. They go at the very end of the rules (without a heading of their own they go under "이 Mac에서 더한 규칙", rules added on this Mac), and you keep getting improvements to the defaults when IAMCEO updates. With the report language set to English, these rules still apply as written.

```sh
mkdir -p ~/.iamceo/roles
printf '%s\n' '## Our team rules' '- Run the tests before opening a PR.' > ~/.iamceo/roles/worker.extra.md
```

**Replace them.** Copy the defaults out, edit one, and save it under the name the server reads:

```sh
iamceo roles export
cd ~/.iamceo/roles
cp worker.example.md worker.md   # conductor for the lead, root for the HQ agent
# edit worker.md, keeping its first line
```

- An edited file (`worker.md`) **replaces the default rules entirely**; they are not merged. Start from the exported default. Improvements to the defaults in later IAMCEO versions do not reach an edited file.
- The first line of an exported file is a marker that records which defaults it came from. When an update changes the defaults, the self-check in Settings (`iamceo doctor`) shows "Edited role rules" as needing attention, and the server log says so too. Export again, carry your edits over, and replace the first line with the new file's to clear it. If you only added rules, move them to `worker.extra.md` and drop `worker.md` instead.
- `worker.extra.md` is added to the end of `worker.md` too when both exist.
- No server restart is needed. Sessions already running keep the old rules; put one to sleep and wake it to load the new ones.
- Rules the server enforces (source labels, checking quotes of your words, file path checks) stay in force whatever the file says.
- If a replacement file does not contain the word 승인 (approval), the server log and the self-check show a warning.
- With the report language set to English, the line asking for English is added at the very end of edited rules too.
- Edited instructions (`~/.iamceo/roles`) are not in backups. Copy that folder yourself when you move to a new Mac or restore. → [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md#starting-a-new-mac-from-a-backup)

The placeholders (`{{PROJECT}}`, `{{NAME}}` and the rest) and the full rules are in the [operating model](../operating-model.md#역할-템플릿-고치기) (Korean).
