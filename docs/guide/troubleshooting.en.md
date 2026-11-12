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
| Engine (herdr-core) | Whether the engine that holds the staff terminals is there and answers | If it stays that way, restart the Mac. If the engine is missing, reinstall the app (`brew reinstall --cask yehsung/tap/iamceo`). |
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

### A usage limit was hit

A usage-limit card arrives in 결재함 (Inbox). If you wait, work continues on its own once the limit clears. To continue now, pick another model on the card or change the staff member's model; the same conversation continues on the new model.

### The network or the AI service is down

The app shows a waiting banner. Nothing you sent is lost; it is delivered once the outage clears. While the server believes an AI service is down, it sends an empty check request to see whether it is back.

### A delivery is left at "도움이 필요함" (needs help)

The server could not confirm whether your message reached the CLI. Press 다시 확인 (check again) first. When unsure, the server never types the same message twice. To resend anyway, accept the duplicate risk and resend.

### A notice that the engine has a problem

The engine that holds the staff terminals is not answering or has the wrong version. If it stays that way, restart the Mac. When the server is back, it reopens the staff that were switched off, lead first, in the same conversations.

### The app and the server do not match

The app shows a notice only when the two really do not match, and it tells the two cases apart:

- **Update the app:** the app is older than the server. Update the iPhone app in the App Store, or install the new Mac app.
- **The server is an older version:** the server is older than the app. Update IAMCEO on the Mac that runs the server.

If you replaced the Mac app with a new version and the server is still running the old one, the app asks once whether to restart the server on the new version. The staff sessions continue through the restart, because the engine holds them. → [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md)

### The iPhone does not connect

First check that Tailscale is on on the Mac; the Mac app tells you when it is off. The rest is in [Connecting an iPhone](iphone.en.md#when-it-does-not-connect).

## Making a diagnostic file

A diagnostic file attached to a question or an issue makes the cause much easier to find.

- **In the app:** 진단 파일 만들기 (make a diagnostic file) under 설정 → AI 모델 → 실행 환경 (when connected on this Mac)
- **On the command line:** `iamceo diagnose`

It creates a folder `~/.iamceo/diagnostics/<time>/` and a `.zip` of the same name. The five most recent are kept.

| Included | Not included |
|---|---|
| Server, engine, CLI and macOS versions (and the app's version when made from the app) | The text of conversations, reports, decisions, to-dos and files |
| The self-check result and the service state | Attachments |
| The end of the server logs (known secrets masked) | The access code, staff keys and push tokens |
| Stall and restart records, the names of crash reports | Environment variable values |
| Backup state; a status summary of the database (IDs, states, times, counts) | |

Logs can still contain file paths and project names. Open the file once before posting it anywhere public. For a vulnerability, do not open a public issue; follow [SECURITY.md](../../SECURITY.md).

## Logs

The server logs are `~/.iamceo/logs/server.log` and `server.err.log`. Each line carries the time it was received, and a full file rolls over to an older one.

## Changing the role rules

You can change the role instructions the lead, staff and HQ agent receive. Copy the defaults out, edit one, and save it under the name the server reads:

```sh
iamceo roles export
cd ~/.iamceo/roles
cp worker.example.md worker.md   # conductor for the lead, root for the HQ agent
# edit worker.md
```

- An edited file (`worker.md`) **replaces the default rules entirely**; they are not merged. Start from the exported default. Improvements to the defaults in later IAMCEO versions do not reach an edited file; after an update, export again and compare.
- No server restart is needed. Sessions already running keep the old rules; put one to sleep and wake it to load the new ones.
- Rules the server enforces (source labels, checking quotes of your words, file path checks) stay in force whatever the file says.
- If the file does not contain the word 승인 (approval), the server log shows a warning.
- With the report language set to English, the line asking for English is added to the end of an edited file too.

The placeholders (`{{PROJECT}}`, `{{NAME}}` and the rest) and the full rules are in the [operating model](../operating-model.md#역할-템플릿-고치기) (Korean).
