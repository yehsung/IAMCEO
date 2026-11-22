# App Store listing — English (en-US)

[한국어](ko.md) · [About these files](README.md)

The text for the iPhone app's English App Store listing, field by field. Each field is the text block under its heading, copied as is. Limits are App Store Connect's; `tests/appstore-listing.test.ts` checks them.

## name

App name (2–30 characters). Another developer's app already uses the name "IAMCEO" in this locale, so App Store Connect refuses it; the English name adds a short description.

```text
IAMCEO: AI Coding Team
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

What's New in 0.2.10 (up to 4,000 characters). Fixes made on the server need a Mac server on 0.2.10 or later, so each item says so.

```text
• You can now use Gemini. The lead and staff can run on Google's Antigravity CLI, with approval cards in your Inbox, compaction, resuming after usage limits and signing in from your phone, just like Claude Code and Codex staff. Requires the Antigravity CLI and the IAMCEO server 0.2.10 or later on your Mac.
• Long-running projects open lighter. Finished to-dos and finished work arrive as only the recent ones first, and "Show earlier finished" loads the rest. Requires Mac server 0.2.10 or later.
• The Files tab no longer fills up with a separate copy of every version; earlier versions fold under "Earlier versions", and a deck's original (PPTX or PDF) opens from "Original" under the preview. Requires Mac server 0.2.10 or later.
• When the server can't be reached, iPhone still shows the recent state it saw last.
• Gemini joins Claude Code and Codex in the AI tool picker.
```
