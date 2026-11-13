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

This app connects to the IAMCEO server running on your own Mac. Your conversations, decisions and files stay on that Mac. There is no IAMCEO account and no IAMCEO cloud.

WHAT YOU CAN DO
• Home — see at a glance who is working, who is done and who is waiting for you.
• Inbox — staff questions and approvals arrive as cards with background, the outcome of each option and a recommendation. Answer with a tap.
• Chat — tell the lead what you want. The lead hands the work to the right staff member and reports back.
• Files — open documents, tables, code, images and HTML pages right in the app, not as file paths.
• Team — check each staff member's status and context, and open their live terminal when you need to step in.

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
IAMCEO collects no data. There are no ads, analytics or tracking.

Claude Code is a product of Anthropic, and Codex is a product of OpenAI. IAMCEO is an independent project and is not affiliated with either company.
```

## keywords

Keywords (up to 100 characters, separated by commas, no spaces after the commas). No trademarks or other apps' names (App Store Review Guideline 2.3.7).

```text
AI agent,coding agent,AI team,developer,remote,approval,inbox,CLI,terminal,automation,workflow
```

## whatsNew

What's New in 0.2.5 (up to 4,000 characters).

```text
• Choose the app's language in Settings → General → Language, or on the first screen before you connect. A new install starts in the language of your App Store country; an updated app keeps the language you've been using.
• The sample is now in English, too.
• Messages you wrote while offline are sent only to the server you wrote them for. Messages over a day old wait for your review before they are sent, and are deleted after 30 days.
• On iPhone, the list of connected devices is read-only. Disconnect this iPhone here; other devices are disconnected on the Mac that runs the server.
```
