# Getting started

[한국어](getting-started.md) · [All user guides](README.md)

IAMCEO is a server that runs on your Mac plus native Mac and iPhone apps. The server starts the official Claude Code and Codex CLIs as a lead and staff, and you give instructions and make decisions in the app. The only server the developer runs is the iPhone notification relay.

> The app's screens are in English or Korean (see [App language](#app-language)). This guide gives each label in Korean with the English label in parentheses, so you can find each button either way.

## Before you start

- [ ] **An Apple Silicon Mac on macOS 14 (Sonoma) or later.** Intel Macs are not supported.
- [ ] **Claude Code, installed and signed in.** Install it from [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once in Terminal and sign in. Without a sign-in, staff stop right after starting.
- [ ] **(Optional) Codex CLI.** To run staff on Codex, install it and run `codex` once in Terminal to sign in.
- [ ] **(Optional, from 0.2.10) Antigravity CLI.** To run the lead or staff on Gemini, install the [Antigravity CLI](https://antigravity.google/docs/getting-started) and run `agy` once in Terminal to sign in and finish the first-run setup (terms). You do the sign-in and accept the terms yourself; IAMCEO never does it for you.
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

To look around before setting up a Mac, press 샘플로 둘러보기 (Explore the sample) on the iPhone app's first screen. In an example company you can send instructions, answer decisions and open files. Changes stay on this iPhone and reset when you leave the sample, and the sample connects to no server. Things that need a real Mac, such as new projects, adding staff and the terminal, are not available in the sample. The sample company appears in English or Korean, following the app's language.

## Chat: who has your message

After you send a message, a line at the bottom of the conversation (under your last message) names who has it and what they are doing. The server decides it from the delivery records, the staff member's turn starting and ending, and the conversation; the app only shows it. It works the same with Claude Code and Codex.

| The line | What it means |
|---|---|
| (three dots) **Checkout Lead is replying…** | That staff member received your message and their turn is running on it. After a minute the time is added, as in **is working on it · 3 min**. The line goes away when the reply arrives. |
| **Checkout Lead is reading…** | The CLI has the message and the turn is about to start. |
| **is finishing earlier work** | They are busy with earlier work unrelated to your message; yours goes in when that finishes. They have not read it yet. |
| **Waking …** · **Checking that … got it** | A sleeping staff member is being opened, or the result of putting your message in is not known yet. The same message is never put in twice. |
| **is waiting at an approval prompt** · **is waiting for the usage limit to reset** · **stopped with an error**, and so on | Stopped. An approval prompt continues once you answer it in the Inbox or the terminal; a usage limit or an internet outage continues by itself when it clears. |
| **Read, but no reply** under your message | Their turn ran on your message but ended without writing anything in Chat (even after the server asked once more for the result). It stays while they go on to other work, such as reading another staff member's report, and what they write then does not count as the reply. To ask again, send a new message with Reply. |
| **Stopped before replying** under your message | That turn was cut off by an error or the session ending. Check that staff member on the Team screen. When the server has them pick up the cut-off turn (after a usage limit lifts, the internet comes back, or the Mac restarts), it shows "replying" again. |

If you wrote to several staff members, each gets their own line. When the lead hands your request to another staff member instead of answering and ends its turn, that counts as a reply, and Chat shows "the lead handed it to …". The line appears in Chat only, not in the conversation list or on Home. With Reduce Motion (Accessibility) on, the dots stay still. Servers on 0.2.5 or earlier do not show it.

## Terms

| Here | Korean label | What it is |
|---|---|---|
| Lead | 총괄 | One per project. Splits the work, hands it to staff and gathers their reports. It does not edit code itself. |
| Staff | 팀장 | A session that does the actual work, one per kind of job. |
| Sub-agent | 서브에이전트 | A helper a staff session starts inside its own CLI. It reports to that staff session only. |
| HQ | 본사 | The entry that belongs to no project. Its agent (본사 AI) creates projects and handles one-off jobs. Its working folder is your home folder. |
| Inbox | 결재함 | Where questions and approvals wait for your answer. |

## App language

Choose the language of the app's buttons and screens in **설정 → 일반 → 이 기기 → 언어** (Settings → General → This device → Language). It works before you connect to a server, too. On the iPhone, before you connect, use the **언어 · 자동** (Language) menu at the bottom of the first screen.

- **Automatic** (the starting setting): the first time you open the iPhone app from the App Store, it opens in Korean if your App Store country is Korea and in English otherwise. The Mac app, and an iPhone whose App Store country can't be read, follow the device language (Korean on a Korean device, English otherwise). A device updated from 0.2.4 or earlier keeps the language it already shows. The hint under the row says which one Automatic follows: an App Store-country Automatic stays in that language even if you later change the device language, and a device-language Automatic follows the device language.
- **한국어** or **English**: that language, whatever the device language is.
- The new language shows when the app opens again. On the Mac, press **Reopen now**, which appears in the same place; the app closes and opens again (the server and staff keep working). On the iPhone, swipe the app up in the app switcher to close it, then open it again.
- It is the same setting as iPhone Settings → IAMCEO → Language and, on the Mac, System Settings → General → Language & Region → Applications. Whichever you change last wins.
- It is saved on this device only and never sent to the server; the App Store country is read on the device only, too. The language the lead and staff write in is chosen separately in Report language below.

## Report language

You can choose the language the lead and staff write to you in — reports, decision cards and to-dos. In **설정 → 일반 → 운영 → 보고 언어** (Settings → General → Operation → Report language), pick 한국어 or English.

- The choice applies to sessions opened after it. A staff member that is already working switches once you put it to sleep and wake it.
- This changes only what the lead and staff write. The app's buttons and screens follow [App language](#app-language) above.
- The source labels the server puts on what agents receive (`[대표]`, `[총괄]` and the like) stay as they are in either language. With English, a line explaining what each label means goes into the role instructions.
- The row appears only on a server that has this setting; connected to an older server, it is hidden.

## Language of what the server writes

Some text is written by the server itself rather than by the lead or staff: system lines in the chat (for example "The lead handed Checkout a task", or a notice that a run was cut off), the decision cards the server posts (tool approvals, usage limits) and their choices, staff activity lines, the delivery notes under your messages, a staff member's error line, and iPhone notification text (from 0.2.6).

- The server records this text in the report language at the time it is written. When that differs from the app language, the app shows it again in the app language. So with Report language set to Korean and the app in English, this text shows in English.
- What staff write, conversation content, project and staff names, and the original error text a CLI reported are shown as they are.
- iPhone notification text follows that iPhone's app language. After you change the app language and open the app again, the server learns the new one when the app registers the device for notifications again.
- Older apps (0.2.5 and earlier) show the text as the server recorded it.
- A few rare lines (for example error notes that mix in a name or the CLI's own words) still show as the server recorded them.

On a newly installed server, the names it creates first — the HQ project (**본사** / **HQ**) and its lead — and the starting Report language follow the app language when you press **이 Mac에서 시작** (Start on this Mac) in the Mac app (or the terminal's language if you start it from the command line first). Names and settings of a server you already use do not change. A new project's lead is named in the report language at that time ('Checkout 총괄' in Korean, 'Checkout Lead' in English).

## Usage

See how much the lead and staff have used in **설정 → AI 모델 → 사용량** (Settings → AI models → Usage).

- **Period**: pick today, 7 days or 30 days. **Total** at the top covers the whole period.
- **Break down**: by member, by project or by day. Staff you have closed stay in the list, marked as closed.
- **Claude usage limits · Codex usage limits**: how much of your account's limits (5-hour and weekly) the CLI last reported as used. These are account-wide, so they are not split by member. After a limit resets, it is hidden until a new value arrives.
- The numbers are exactly what the CLIs reported. IAMCEO does not calculate or estimate them.
  - Claude Code reports a cost (in US dollars) and tokens. On a subscription plan, that amount can differ from what you are actually billed.
  - Codex reports tokens only, so tokens appear instead of a cost.
  - Gemini (the Antigravity CLI) reports a cost the CLI estimates, and tokens. Its limits appear one line per quota group that Antigravity reports, as the share used.
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
| `iamceo auth devices` · `iamceo auth revoke-device <ID>` | List the devices paired by QR with their IDs, and disconnect one of them (other devices can only be disconnected on the Mac that runs the server) |

## Good to know: your terminal environment does not carry over

The server runs as a login item, so it does not get the environment variables and PATH that your shell start-up files (`~/.zshrc` and the like) set. An MCP server or hook that works in your terminal can fail here. Put such values in the `env` of the CLI's settings file, and write commands as absolute paths. The details are in [What is different](../../README.md#what-is-different) in the README.

## Next

- Stuck: [Troubleshooting](troubleshooting.en.md)
- On the iPhone: [Connecting an iPhone](iphone.en.md)
- New versions, backups, removal: [Upgrade, backup and uninstall](upgrade-backup-uninstall.en.md)
