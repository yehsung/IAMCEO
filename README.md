# IAMCEO

[한국어](README.ko.md)

A desk for running several Claude Code sessions as a team. You start a server on your own computer, then give work and answer questions from a browser through five screens: Home, Inbox, Team, Conversation and Files. You do not have to keep watching a terminal, and it works from a phone.

- **Home**: what you need to do today. Your to-dos (one line each, an arrow unfolds the details), pending decisions, team status, what the AI does next, recent reports and files, and a **지금 판 정리** (tidy board now) button
- **Inbox**: two sides, to decide and decided. Picking an option does not send it; you press confirm. Sessions stopped at a permission prompt show at the top under **승인 대기** (awaiting approval) with the prompt text, and you approve or reject them with the same pick-then-confirm (herdr only; folder trust and other menus are cleared in the terminal). Cards the AI closed show as "닫힘 · reason" (closed) and can be reopened
- **Team**: status of the lead and workers, current task, context %, work board, model and effort per worker
- **Conversation**: reports and your messages, with delivery status
- **Files**: what the sessions upload. Documents, artifacts (a single HTML page), images, PDFs, tables, code, video and audio each get their own view

A project that is not connected (no lead and the runner is off, the backend is down, or the server connection dropped) locks the input box and decision buttons and shows the reason and what to do next. The server also refuses with 409. Your draft stays. Checking off your own to-dos works regardless.

You talk to the lead. The lead hands work to workers. See the [operating model](docs/operating-model.md) for the rules and the [architecture](docs/architecture.md) for the structure. Both are in Korean, as is the app's interface.

Status: 0.1.0, early. Claude Code only. macOS only (Apple Silicon and Intel). The interface is in Korean.

## Requirements

| Item | Needed | Version run |
|---|---|---|
| macOS | Yes (Apple Silicon or Intel) | Darwin 27 |
| Claude Code (`claude`, logged in) | Yes | 2.1.316 |
| herdr | Optional | 0.9.3 (protocol 22) |
| Tailscale | For phone access | |

[Bun](https://bun.sh) is needed only to build from source.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
```

It downloads the prebuilt binary for your Mac from the latest GitHub release, checks its SHA-256 and puts it at `~/.local/bin/iamceo`. If `~/.local/bin` is not on your PATH, the script prints the line to add.

Options are environment variables, given to `sh`:

| Variable | What it does |
|---|---|
| `IAMCEO_INSTALL_DIR` | Install into another folder |
| `IAMCEO_VERSION=v0.1.0` | Pin a version instead of the latest |

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | IAMCEO_VERSION=v0.1.0 sh
```

Run the same command again to update. If the launchd service (`iamceo service install`) points at that binary, it is restarted. Check the result with `iamceo version`.

### From source

Needs Bun 1.3 or later.

```sh
git clone https://github.com/yehsung/IAMCEO
cd IAMCEO
bun install
bun link          # creates ~/.bun/bin/iamceo, runs from source
```

Or run `bun run build` instead of `bun link` to get one file, `dist/iamceo`, screens included. Put it on your PATH yourself. A built binary only changes after you run `bun run build` again.

### Uninstall

```sh
iamceo service uninstall   # if you installed the service
rm ~/.local/bin/iamceo     # or the file in IAMCEO_INSTALL_DIR
```

Data stays in `~/.iamceo`. Delete that folder to remove everything: projects, the access code and logs.

## First run

```sh
iamceo setup              # asks for backend, port and access range. Enter takes the default
iamceo service install    # starts the server now and at every login, restarts it if it dies. Default port 7878
iamceo open               # shows the addresses and the access code
```

The service is the usual way to keep it running (see [Run as a service](#run-as-a-service)). To run it in the foreground instead, use `iamceo serve` and run `iamceo open` in another terminal. Stop it with Ctrl+C.

1. Open an address from `iamceo open` in a browser.
2. Enter the access code. The device remembers it.
3. If you skipped `setup`, the screen asks for the backend.
4. Create a project (name, folder).
5. Type in the input box. If there is no lead yet, the server starts one and delivers your message.

**본사** (headquarters) in the left list belongs to no project. Its AI does one-off work and creates projects for you.

`setup` also runs without questions:

```sh
iamceo setup --backend headless --port 7878 --hosts local
```

Check state with `iamceo status`. It tells you if the server is off.

## With herdr or without

Chosen once for the whole server. Roles, rules, tools and screens are the same. What differs is where a session runs.

| | With herdr (`herdr`) | Without (`headless`) |
|---|---|---|
| A worker is | One herdr pane | One `claude -p --resume` turn per input |
| Watch and type in a terminal | Yes | No |
| Terminal contents on the Team screen | Yes | No |
| Approval prompts | Appear in the pane and show as "at approval prompt" on screen. Approve or reject from the Inbox or Team screen, or clear them in the pane | Not shown (`--permission-prompts none`) |
| Take over a running session as a worker | Yes | No |
| Setup | Install (`brew install herdr`) and run herdr | None |

**Choose herdr if you want to touch the terminal yourself, headless if the screens are enough.** You can switch in Settings, but only while no session is working.

Notes for herdr:

- Each project gets one workspace, and panes are added to it. They are created on your running herdr server (`~/.config/herdr/herdr.sock`). Use `IAMCEO_HERDR_SOCKET` for a different one.
- The first time a git repository is opened, Claude Code shows a folder trust prompt. The server does not answer it for you. Choose `Yes, I trust this folder` in that pane. Messages are held until then.
- If the protocol is not 22, you get a warning and it keeps trying.

## Phone access (Tailscale)

1. Install Tailscale on the server computer and the phone, and log in to the same account.
2. Start the server. It opens the Tailscale address automatically. If Tailscale comes up later than the server, the address opens within 30 seconds.
3. Open `http://100.x.y.z:7878`, as shown by `iamceo open`, in the phone's browser.
4. Enter the access code.

On a phone the tabs are at the bottom, and tapping the title switches projects. On touch devices Enter makes a new line and the send button sends.

To open it to other devices on the same network, run `iamceo setup --hosts lan` and restart the server. You can also list addresses (`--hosts 127.0.0.1,192.168.0.10`). `0.0.0.0` is refused.

## Attach a CLI you started (`iamceo join`)

Registers a Claude Code session of your own as a worker. The server must be on, and you must be on the same computer.

```sh
cd <project folder or below>
iamceo join --name writer --role "writes docs"
```

The project is found from the folder. If you are elsewhere, use `--project name`. It prints two things:

1. A `claude mcp add iamceo ...` command. Run it once in that folder. It contains a token, so keep it private.
2. A rules file path.
   - Starting fresh: `claude --append-system-prompt-file <rules file>`
   - Already running: reconnect with `/mcp`, then tell the session to read and follow that file.

The server does not manage a session attached this way.

- It fetches its own instructions with the `wait` tool. `ask` returns when the answer arrives.
- It cannot be compacted, put to sleep or reopened.
- A tool call shows it as working, 5 quiet minutes as idle, 30 quiet minutes as not visible. You can remove it from the roster on screen.

If you change the server port, run `join` again. Running it again with the same name continues the same worker.

**A session already running in a herdr pane** can instead be taken over with **기존 세션 편입** (adopt existing session) on the Team screen. It becomes a server-managed worker, and this happens only when you press the button.

### How adopting works

It needs the herdr backend; otherwise the same dialog shows the `join` command above. The dialog first shows the session's screen and any warnings. Pressing the button does this:

- The pane stays. It is not moved, renamed or closed. The server recognises it by session ID.
- Model, effort and permissions stay as they were. The rank values in Settings do not overwrite them.
- It joins as a worker only. The operating rules go in as the first prompt (any text left in the input box is cleared first) and the project's runner turns on. From then on the last text of each turn is reported to the conversation and the lead.
- A running session cannot get MCP attached, so it cannot post decision cards or files. **도구 붙여 다시 열기** (reopen with tools) reopens it in a new pane in the project tab with full arguments.
- **편입 해제** (release) undoes it. Conversation and session stay, and the session is told once, when idle, that the rules no longer apply. If this adoption turned the runner on and no sessions remain, it turns off.

People set up their AI differently, so conflicts are handled like this:

| Situation | What happens |
|---|---|
| Working, at an approval prompt, no session ID, input box not found | Refused. Try again later |
| Already a worker in any project (including asleep), or a CLI other than Claude | Refused |
| Signs of another conductor (rule files on the command line, pane name, SendMessage or orchestra skill in the log) | Warning only |
| Running outside the project folder | Warning only |
| Text in the input box | Warning. The text is cleared when the session joins, then the rules go in |

What remains: the session's own CLAUDE.md and skills stay active and may overlap with the new rules. Rules are text, not a lock. If another conductor keeps typing into that pane, there are two conductors. When you see the warning, stop the other conductor first or start a new session for the job.

## Run as a service

Starts at login and restarts if it dies, through launchd (macOS).

```sh
iamceo service install --dry-run   # shows the file and command first
iamceo service install             # ~/Library/LaunchAgents/com.iamceo.server.plist
iamceo service uninstall           # removes it. Data stays
```

Logs are in `~/.iamceo/logs/`. The plist records the executable path and the `IAMCEO_*` variables at install time. If you move the binary, install again.

## Configuration

`~/.iamceo/config.json`:

| Key | Environment variable | Default |
|---|---|---|
| `accessCode` | | Generated on first run |
| `port` | `IAMCEO_PORT` | 7878 |
| `hosts` | | 127.0.0.1 + Tailscale address |
| `claudeBin` | `IAMCEO_CLAUDE_BIN` | `claude` |
| `herdrSocket` | `IAMCEO_HERDR_SOCKET` | `~/.config/herdr/herdr.sock` |

Move the data folder itself with `IAMCEO_HOME`. Environment variables win over the file. Restart the server after changes.

There is one Settings screen and it applies to every project. Nothing is set per project (renaming, moving and archiving projects also happen here).

- Backend
- Three permission modes: bypass (`bypassPermissions`, default), auto (`auto`), approve everything (`default`). Headless applies them from the next turn, herdr when the pane is next opened
- Model and effort per rank: manager (lead and HQ AI), team lead (worker sessions), staff (subagents). Unset means the CLI default. One worker can override them in its detail view on the Team screen
- Concurrent turns (4), awake worker limit (8), auto compact threshold (70% of context), Mac notifications
- Board tidy interval (off, 3 hours, 6 hours, 12 hours, daily; default 6 hours)

## Board tidy

The lead (the HQ AI for HQ) keeps the inbox, your to-dos, the work board and the current status from going stale. It tidies whenever it gets a report, an answer or a message from you, and the server also asks for a tidy once per interval.

| Tool | Who | What it does |
|---|---|---|
| `board` | lead, HQ AI | One view of open decisions, unfinished to-dos, the work board, the current status and the last tidy time |
| `ask_close` | lead, HQ AI; a worker only its own cards | Closes a decision card with a reason. `decided` (you already decided) must carry your own words, which the server matches against your messages. `obsolete` is for cards no longer needed. The worker who asked is told without being woken |
| `todo_close` | lead, HQ AI; a worker only its own requests | Closes a to-do as `done` (only with evidence that you did it) or `dropped` (no longer needed). Dropped to-dos leave Home |

- It never answers for you. A card you have not decided is not closed on a guess; when unsure it stays.
- The periodic tidy only goes in when the lead is already running and idle, the interval has passed, and decisions, to-dos, the work board or the conversation changed since the last tidy. It never starts a lead or wakes workers to tidy. If nothing changed, nothing is posted.
- **지금 판 정리** (tidy board now) on Home asks right away (starting the lead if it is missing or asleep). It is locked while the project is not connected.
- A card the AI closed goes back to the to-decide side with **다시 열기** (reopen) in the decided list.

## Commands

| Command | What it does |
|---|---|
| `iamceo serve` | Start the server |
| `iamceo setup` | Backend, port, access range |
| `iamceo open` | Addresses and access code |
| `iamceo status` | Server and project state |
| `iamceo join` | Register a CLI you started |
| `iamceo service install\|uninstall` | Add or remove the launchd service |
| `iamceo roles export` | Export role templates |
| `iamceo import <dump.json>` | Import a dump from the earlier board. New users do not need this |
| `iamceo mcp` | MCP bridge. Sessions call it |
| `iamceo version` | Print the version |

## Access and security

- By default it listens only on 127.0.0.1 and the Tailscale address. Other IPs get 403.
- Screens and API require the access code, shown by `iamceo open`. Only you can read `config.json`.
- There is no HTTPS. Encryption is left to Tailscale. With `--hosts lan`, traffic on that network is plain text.

## Known limits

- **It is not a sandbox.** Sessions run as your OS user. The server's file tools refuse secret folders, `.env` and private keys, but they cannot stop a session's Bash. The `bypassPermissions` mode leaves this risk fully exposed.
- Claude Code only. Codex and Gemini CLI do not work.
- macOS only. Release binaries are built for macOS, and the launchd service, HEIC conversion (`sips`) and Mac notifications are macOS features.
- The Intel (`darwin-x64`) binary is built but has not been run on an Intel Mac yet.
- The interface is Korean and dark mode only. There is no iOS app, only the web screens.
- The refraction effect shows only in Chromium browsers.
- `join` works only on the server's computer (its connection address is local).
- Attachments are limited to 50MB per file.
- Messages sent from the screens are delivered after that session's turn ends, in either backend. The stop button on the Team screen can cut a turn. Headless has no terminal view.

## Development

```sh
bun run dev         # restarts the server on changes
bun test tests      # never calls real claude. herdr tests start an isolated server
bun run typecheck
```

Tests always point `IAMCEO_HOME` at a temporary folder. `tests/integrated.browser.ts` runs one flow from an imported project through the gate, decisions, home, artifact, adopt and settings; `IAMCEO_SHOTS=docs/shots bun test ./tests/integrated.browser.ts` regenerates the screenshots. `tests/e2e-real/artifact.ts` checks with real Claude that a worker uploads a comparison table as an artifact. The full runs with real Claude are `IAMCEO_E2E_REAL=1 bun tests/e2e-real/headless.ts` and `tests/e2e-real/herdr-full.ts`, and they cost money.

### Release

Bump `version` in `package.json`, commit, then tag `vX.Y.Z` and push the tag. The GitHub Actions workflow `.github/workflows/release.yml` builds `iamceo-darwin-arm64` and `iamceo-darwin-x64` plus `SHA256SUMS`, and publishes the release. `bun run build:release` makes the same files locally in `dist/release/`. `install.sh` always takes the latest release.

## License

[AGPL-3.0](LICENSE). Copyright (C) 2026 yehsung.

You can use, change and share it freely. If you run a changed version as a service for other people, you must offer them its source under the same license. Running it on your own computer, changed or not, asks nothing of you.
