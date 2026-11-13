# App Store listing — English (en-US)

[한국어](ko.md) · [About these files](README.md)

The text for the iPhone app's English App Store listing, field by field. Each field is the text block under its heading, copied as is. Limits are App Store Connect's; `tests/appstore-listing.test.ts` checks them.

## name

App name (2–30 characters). Same as the Korean listing.

```text
IAMCEO
```

## subtitle

Subtitle (up to 30 characters).

```text
Run your AI coding agents
```

## promotionalText

Promotional text (up to 170 characters; can change without a new version).

```text
Give instructions and answer decisions from your iPhone while your Mac does the work. No Mac yet? Explore the built-in sample.
```

## description

Description (up to 4,000 characters).

```text
IAMCEO lets you run AI coding agents like a company. Several Claude Code and Codex sessions on your Mac work as a lead and staff, and you give instructions and make decisions — from your Mac or from this iPhone.

This app connects to the IAMCEO server running on your own Mac. Your conversations, decisions and files stay on that Mac, and there is no IAMCEO account.

WHAT YOU CAN DO
• Home — see at a glance who is working, who is done and who is waiting for you.
• Inbox — staff questions and approvals arrive as cards with background, the outcome of each option and a recommendation. Answer with a tap.
• Chat — tell the lead what you want. The lead hands the work to the right staff member and reports back.
• Files — open documents, tables, code, images and HTML pages right in the app, not as file paths.
• Team — check each staff member's status and context, and open their live terminal when you need to step in.
• Notifications — get notified on your iPhone when a decision is waiting, a staff member is stuck, or work is done.

TRY IT WITHOUT A MAC
Tap "Explore the sample" on the first screen to walk through an example company. Send instructions, answer decisions and open files. The sample runs entirely on your iPhone and sends nothing anywhere.

WHAT YOU NEED
• A Mac with Apple silicon on macOS 14 or later, running the IAMCEO server (a free download from github.com/yehsung/IAMCEO).
• Claude Code installed and signed in to your own account on that Mac. Codex CLI is optional. Each AI tool runs under your own account and its usage limits.
• Tailscale on both the Mac and the iPhone, to connect them securely.
Then scan the pairing QR code shown in the Mac app.

LANGUAGE
The app is in English and Korean. Change it any time in Settings → General → Language, or, before you connect, from the Language menu at the bottom of the first screen.

PRIVACY
IAMCEO collects no data. There are no ads, analytics or tracking. Notifications go from your Mac straight to Apple, or, if your Mac has no push key of its own, through a small relay run by the developer. No conversation content goes to the relay, and the relay stores nothing it receives.

Claude Code is a product of Anthropic, and Codex is a product of OpenAI. IAMCEO is an independent project and is not affiliated with either company.
```

## keywords

Keywords (up to 100 characters, separated by commas, no spaces after the commas). No trademarks or other apps' names (App Store Review Guideline 2.3.7).

```text
AI agent,coding agent,AI team,developer,remote,approval,inbox,CLI,terminal,automation,workflow
```

## whatsNew

What's New in 0.2.5 (up to 4,000 characters). iPhone 0.2.4 was not released on the App Store, so this also lists its iPhone changes.

```text
• iPhone notifications. Update the IAMCEO server on your Mac to 0.2.5 or later and you'll be notified when a decision or a tool approval is waiting, a staff member is stuck, or work is done.
• The app is now in English, too. Choose the language in Settings → General → Language (or on the first screen before you connect); a new install starts in the language of your App Store country. The sample is in English as well.
• When the connection drops, the app keeps showing the last screen it received, and messages you write while offline are sent in order once you reconnect to the server you wrote them for. Messages over a day old wait for your review, and are deleted after 30 days.
• Allow or deny a staff member's tool approval request from the Inbox.
• See usage (cost and tokens) for the lead and each staff member, and your account's limit usage, in Settings.
• Each device paired with a QR code gets its own key. Disconnect this iPhone here; other devices are disconnected on the Mac that runs the server.
• If Tailscale is off on this iPhone, the app tells you instead of sending, and reconnects when you turn it back on.
• The waiting reason now shows why a staff member actually stopped.
```
