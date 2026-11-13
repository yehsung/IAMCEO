# Getting started

[한국어](getting-started.md) · [All user guides](README.md)

IAMCEO is a server that runs on your Mac plus native Mac and iPhone apps. The server starts the official Claude Code and Codex CLIs as a lead and staff, and you give instructions and make decisions in the app. The only server the developer runs is the iPhone notification relay.

> The app's screens follow your device language: English, or Korean on a Korean device. This guide gives each label in Korean with the English label in parentheses, so you can find each button either way.

## Before you start

- [ ] **An Apple Silicon Mac on macOS 14 (Sonoma) or later.** Intel Macs are not supported.
- [ ] **Claude Code, installed and signed in.** Install it from [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once in Terminal and sign in. Without a sign-in, staff stop right after starting.
- [ ] **(Optional) Codex CLI.** To run staff on Codex, install it and run `codex` once in Terminal to sign in.
- [ ] **(For the iPhone) Tailscale.** Install [Tailscale](https://tailscale.com) on the Mac and the iPhone and sign in with the same account. See [Connecting an iPhone](iphone.en.md).
- [ ] **You understand the permission mode.** By default the lead and staff run commands without stopping at approval prompts ("don't ask"). You pick one of three modes on first start. What is blocked and what is not is in [Security](../security.en.md).

AI usage is billed to each CLI's own account and limits. IAMCEO adds no fee.

## Install

```sh
brew install --cask yehsung/tap/iamceo
```

Without Homebrew, use the install script:

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
```

Or download the DMG from the [latest release](https://github.com/yehsung/IAMCEO/releases/latest) and drag the app into Applications.

The install script checks the download against the release's SHA-256, then checks that the app carries the IAMCEO publisher's signature and Apple's notarization. Only then does it install; if a check fails, the app you already have is left untouched. Its messages follow your terminal's language (`LANG`); set `IAMCEO_LANG=en` or `IAMCEO_LANG=ko` to choose.

## First start

1. **Open IAMCEO and press 이 Mac에서 시작 (Start on this Mac).** The server registers as a login item and the app connects. The server starts on its own whenever the Mac starts.
2. **Choose how staff run commands.** 묻지 않기 (Don't ask, preselected), 위험할 때만 묻기 (Ask only when risky) or 매번 묻기 (Ask every time). Change it later in 설정 → 일반 → 권한 (Settings → General → Permissions). A change applies to sessions opened after it.
3. **Create a project.** Press 새 프로젝트 (New project) and pick a working folder; you can also make a new folder or bring in a GitHub repository. With "이 폴더를 신뢰하고 AI가 이 안에서 명령을 실행하게 합니다" (Trust this folder and let the AI run commands in it) on, which is the default, the server answers the folder-trust prompt that the CLI shows the first time in that folder.
4. **Write what you want in 대화 (Chat).** The lead picks the right staff member, hands the work over and tells you in a line or two.
5. **Decisions collect in 결재함 (Inbox), deliverables in 자료 (Files), and your own to-dos on 홈 (Home).** 팀 (Team) shows each staff member as working, idle, waiting for approval or asleep, and opens their real terminal so you can type into it.

To look around before setting up a Mac, press 샘플로 둘러보기 (Explore the sample) on the iPhone app's first screen. In an example company you can send instructions, answer decisions and open files. Changes stay on this iPhone and reset when you leave the sample, and the sample connects to no server. Things that need a real Mac, such as new projects, adding staff and the terminal, are not available in the sample.

## Terms

| Here | Korean label | What it is |
|---|---|---|
| Lead | 총괄 | One per project. Splits the work, hands it to staff and gathers their reports. It does not edit code itself. |
| Staff | 팀장 | A session that does the actual work, one per kind of job. |
| Sub-agent | 서브에이전트 | A helper a staff session starts inside its own CLI. It reports to that staff session only. |
| HQ | 본사 | The entry that belongs to no project. Its agent (본사 AI) creates projects and handles one-off jobs. Its working folder is your home folder. |
| Inbox | 결재함 | Where questions and approvals wait for your answer. |

## Report language

You can choose the language the lead and staff write to you in — reports, decision cards and to-dos. In **설정 → 일반 → 운영 → 보고 언어** (Settings → General → Operation → Report language), pick 한국어 or English.

- The choice applies to sessions opened after it. A staff member that is already working switches once you put it to sleep and wake it.
- This changes only what the lead and staff write. The app's buttons and screens follow the device language: Korean on a Korean device, English elsewhere. To choose for this app alone, use Settings → IAMCEO → Language on the iPhone, or System Settings → General → Language & Region → Applications on the Mac.
- The source labels the server puts on what agents receive (`[대표]`, `[총괄]` and the like) stay as they are in either language. With English, a line explaining what each label means goes into the role instructions.
- The row appears only on a server that has this setting; connected to an older server, it is hidden.

## Usage

See how much the lead and staff have used in **설정 → AI 모델 → 사용량** (Settings → AI models → Usage).

- **Period**: pick today, 7 days or 30 days. **Total** at the top covers the whole period.
- **Break down**: by member, by project or by day. Staff you have closed stay in the list, marked as closed.
- **Claude usage limits · Codex usage limits**: how much of your account's limits (5-hour and weekly) the CLI last reported as used. These are account-wide, so they are not split by member. After a limit resets, it is hidden until a new value arrives.
- The numbers are exactly what the CLIs reported. IAMCEO does not calculate or estimate them.
  - Claude Code reports a cost (in US dollars) and tokens. On a subscription plan, that amount can differ from what you are actually billed.
  - Codex reports tokens only, so tokens appear instead of a cost.
- The server collects the numbers every minute and files them under the day it received them (usage near midnight can land on the next day). Usage older than 90 days is deleted.
- For a session that was already running before this feature, its running total up to that point lands on the day it is first collected.
- This group appears only on a server that collects usage; connected to an older server, it is hidden.

## The command-line tool

A command-line tool ships inside the app. With the app installed, it is here:

```sh
/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo help
```

For everyday use, add a short name to your shell settings (`~/.zshrc`):

```sh
alias iamceo=/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo
```

`iamceo` in these guides means this tool. Its messages follow `LANG`; set `IAMCEO_LANG=en` or `IAMCEO_LANG=ko` to choose. The commands you are most likely to use:

| Command | What it does |
|---|---|
| `iamceo doctor` | Checks this Mac's setup item by item, with a one-line fix for each → [Troubleshooting](troubleshooting.en.md) |
| `iamceo diagnose` | Makes a diagnostic file to attach to a question (no conversation content) |
| `iamceo status` | Server and project status |
| `iamceo open` | Connection address and access code |
| `iamceo backup` | A backup right now, with the server stopped (while it runs, use the backups it makes every day) → [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md) |
| `iamceo upgrade` · `iamceo rollback` | Move to a new version, go back to the previous one |
| `iamceo uninstall` | Stop IAMCEO completely on this Mac |
| `iamceo auth rotate` | Replace the access code (with `--all-devices`, also disconnect every device paired by QR) → [Security](../security.en.md#if-you-lose-a-device) |
| `iamceo auth revoke-devices` | Disconnect every device paired by QR (the shared access code stays) |

## Good to know: your terminal environment does not carry over

The server runs as a login item, so it does not get the environment variables and PATH that your shell start-up files (`~/.zshrc` and the like) set. An MCP server or hook that works in your terminal can fail here. Put such values in the `env` of the CLI's settings file, and write commands as absolute paths. The details are in [What is different](../../README.md#what-is-different) in the README.

## Next

- Stuck: [Troubleshooting](troubleshooting.en.md)
- On the iPhone: [Connecting an iPhone](iphone.en.md)
- New versions, backups, removal: [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md)
