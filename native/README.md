# IAMCEO native

SwiftUI macOS/iOS client for the IAMCEO Bun daemon. The daemon owns domain state, CLI processes and orchestration; the app owns one network synchronization coordinator, not a second model orchestrator.

IAMCEO is **source-available**, under Sustainable Use License 1.0 + IAMCEO Additional Permissions. See [LICENSE](../LICENSE) and [the Korean explanation](../docs/LICENSING.ko.md). The web client is legacy, kept temporarily and scheduled for removal; until then it receives API compatibility maintenance, with no new features.

## Development and isolated validation

Requires Xcode 26 (the code uses the macOS/iOS 26 SDK), XcodeGen and Bun 1.3+. Apps run on macOS 14+ and iOS 17+. System controls use Liquid Glass on supported OS releases and material fallbacks on older systems. Custom workspace cards retain the existing translucent dark violet design.

From the repository root, use the package scripts. Server tests use a temporary IAMCEO home, fake executables, dedicated fixture sockets and dynamic non-7878 ports. Individual fixtures prepare provider homes when needed. XcodeGen runs on a temporary copy with generated files and derived data outside the repository. Swift build/test run sequentially.

```sh
bun run check:ts      # typecheck
bun run test:server   # isolated server tests (temporary home, fake executables)
bun run test:native   # Swift tests
bun run build:check   # unsigned macOS + iOS Simulator builds
bun run check         # all of the above
```

Do not use port 7878, your real IAMCEO home/config, herdr sockets or `dist/native` for validation. Do not invoke `build:native`, `setup:core`, install or service kickstart as test gates. See [the operating runbook](../docs/operating-model.md#격리-시험-실행) for isolation requirements and commands. Build, mock tests, unsigned Simulator builds, signing and physical-device acceptance are separate evidence.

For source previews, use an external scratch directory and the explicit read-only demo; it never connects to a daemon:

```sh
NATIVE_PREVIEW_ROOT=$(mktemp -d /private/tmp/iamceo-native-preview.XXXXXX)
swift run --package-path native --scratch-path "$NATIVE_PREVIEW_ROOT/build" \
  --cache-path "$NATIVE_PREVIEW_ROOT/cache" --config-path "$NATIVE_PREVIEW_ROOT/config" \
  --security-path "$NATIVE_PREVIEW_ROOT/security" IAMCEO --demo
```

Normal source clients require an explicitly chosen test daemon origin and access code. Bundled macOS local-host preparation is a separate operational action: “이 Mac에서 시작하기” may install/start a launchd daemon only when selected. Keep development validation on the isolated test host. macOS App Sandbox is disabled for those local-host controls; iOS uses the platform sandbox. Generated Xcode projects are reproducible from `project.yml`; regenerate in a temporary copy for QA. No signing identity or service credential is committed.

## Connection and synchronization

Use the test Mac’s HTTPS Tailscale Serve origin on iPhone/iPad; device loopback is not the Mac. Same-Mac loopback HTTP and existing tailnet HTTP compatibility remain, but endpoint validation does not prove iOS ATS or real network reachability. Prefer HTTPS/WSS. Access codes live in endpoint-scoped Keychain; UserDefaults holds the endpoint and non-secret state. REST/WS requests use Bearer headers. Foreign-origin attachment URLs and HTTP redirects never receive the access code.

The single AppStore coordinator uses `/ws?v=2` epoch/seq invalidations and `/api/sync` snapshots/revisions. It detects gaps, heartbeat high-water and epoch changes, drops stale generations and resynchronizes on reconnect/foreground return. Normal live connections have **no periodic 3-second state or history polling**. Changes coalesce over 250ms, with at most two snapshots per second and one in flight. When the server is slow, event-driven reads back off to twice the last read time (5 seconds at most); owner-initiated refreshes, post-write reads and reconnects do not wait. In-sequence message/activity events apply their payload directly without re-reading history or activity, and a frame whose body cannot be decoded triggers a full re-read without dropping the connection. WS failure uses REST fallback; host failure backs off to 30 seconds. Low power uses 500ms coalescing, one snapshot/second and 10-second successful fallback. Confirmed 401 ends authentication; generic WS failures do not erase credentials.

Aggregate active scenes share one connection. On iOS, inactive/background and lock/protected-data loss stop sockets, reads, fallback and retries. On macOS only background (no visible window) and sleep stop them; an app that is merely not frontmost keeps syncing. Foreground/wake starts a new generation. Host CLI work is independent of app activity; this does not promise work during host sleep/power loss. There is no background polling/silent-push keepalive. Open terminal screens retain a separate active-only 2-second screen read.

## Writes, history and archive

New supported writes declare `X-IAMCEO-Contract: 2`. Settings/member/todo writes send reviewed `If-Match: "<revision>"`; settings send dirty rank leaves only. Decision answers require the exact `updatedAt` string as `expectedVersion`. Fresh-session and terminal actions use stable operation IDs, reviewed session generations and receipt lookup. Terminal adds a reusable claim ID and input sequence. `pending/applied/refused/unknown` are distinct; an unknown Enter/input is never replayed. Old servers retain explicit legacy handling, but transient capability/sync failures must not downgrade previously established strict protection. v1 versionless writes and URL-authenticated WS remain weaker compatibility paths until legacy retirement.

The first chat attempt persists its host namespace, immutable ID, target, text, completed attachment IDs and draft revision. After lost acknowledgement/restart, the app queries the existing message ID before consuming its matching draft. Late uploads/results cannot revive deleted drafts, cross hosts or erase subsequent edits. Batch answers consume only memos accepted for that request; conflicts keep notes. Todo unknown results remain checking and are resolved by state/revision reads.

History is separate from the project snapshot: first 200, previous 100, opaque keyset cursors ordered by binary `(at,id)`. Per-scope single flight, ID deduplication and event/POST overlays preserve current delivery state. Reconnect gaps larger than 200 are bridged through staged pages before committing; failures preserve the old thread/cursor/draft and offer continue/retry. Prepend captures the current visible message and partial offset immediately before applying, and does not add unread counts. Real Mac/iOS keyboard/image/rotation/accessibility behavior still needs device QA beyond automated anchor tests.

The sidebar/project switcher exposes archive and project management. Renaming preserves IDs, drafts, sessions and history. Archive reads use `/archive/state` and `/archive/messages/page`; ordinary state/page still return 404 for archived projects. Legacy `/api/projects/:id/messages` list/around and `/api/messages/:id` single-message reads remain available for archived history under user authentication, without waking sessions. The server also exposes archive list/around and single-message reads at `/api/projects/:id/archive/messages` and `/api/projects/:id/archive/messages/:message`. Archive UI reads chat, decisions, work and files without send/answer/check/member controls; rename/unarchive are separate management actions. It is not an immutable database snapshot: late manual reports/files and legacy todo compatibility remain. Safe archive verifies resumable session identity and actual termination; unresolved Codex identity blocks it. HQ cannot be archived; there is no project deletion API. Unarchive rechecks archived-held delivery only, not a fleet-wide restart.

Delivery panels show automatic checking separately from owner intervention. Only `needsOwner` contributes to Home/office attention. The server automatically corrects receipt evidence and repairs proven pre-write failures; post-write absence never proves safe resend. Owner actions use the server’s allowed actions, version and operation ID. There is no “mark received” action. Plain terminal controls require a 5-minute identity-bound lease that pauses automatic delivery and survives server restart. Manual claim/release alone does not resolve delivery or compaction uncertainty.

## iPhone APNs and signing

To install on your own iPhone, set the iOS bundle ID and `DEVELOPMENT_TEAM` in `native/project.yml` to your own (Push Notifications needs a paid Apple Developer account; otherwise remove the capability). Configure your own APNs key ID, team ID and the absolute path of the `.p8` file in the host’s `apns.json`. Never copy key contents into the repository, app bundle, chat or logs. Server credentials live in the host’s protected `apns.json`/external p8 file, not the app. See the configuration example and operational boundary in [the runbook](../docs/operating-model.md).

`project.yml` declares Push Notifications and `Configuration/iOS.entitlements` uses `aps-environment=$(APNS_ENVIRONMENT)`. Debug `development` maps to API `sandbox`; Release `production` maps to `production`. Info `IAMCEOPushEnvironment` must match the **final signed entitlement**, including export/TestFlight changes. TestFlight uses production. No remote-notification background mode, badge permission or Mac APNs receiver is added; Mac can manage registered iPhones and retains its separate osascript notifications.

Connection alone does not request OS permission. Explicit “이 iPhone에서 알림 받기” requests alert/sound, registers the current OS token and enables the server device. New registration is disabled until opt-in; the four kind preferences default **on**: `decision` (including free-answer asks), `approval_wait` (confirmed permission evidence), `error`, `report_complete`. Unknown/setup blocked state is not an approval notification.

Completion reports group by project/member for a **fixed 120-second window from the first report**, without extension. The server persists the deadline, report IDs, last message and original recipient set. Different members/projects have separate groups; restarts preserve grouping. Opt-out cancels pending recipients, re-enable does not revive them and new devices get no historical group. APNs 200 means Apple acceptance, not a visible banner/read receipt. A post-write unknown is not retried automatically.

Foreground notifications only refresh data, without banner/sound or forced navigation. A tap validates serverId, the saved event target and current membership, then applies one route after project reset. Unknown hosts require the existing connection flow, never an automatic endpoint switch. No tap automatically answers, approves, claims or inputs. Processed decisions show their current state; completion reports use around-message history and group references. Archived destinations follow the archive read flow where allowed, while a target lookup that now returns 404 is shown as unavailable. Offline taps retain a pending destination; offline disconnect reports incomplete revocation and reconciles it on reconnect.

Physical-device signing/trust/Developer Mode, Apple acceptance, banner delivery and tap navigation must be tested separately for sandbox and production, including cold start, lock, multi-window, Tailscale and Wi-Fi/cellular changes. Mock HTTP/2 and Simulator success do not replace physical-device acceptance.

Artifact previews remain nonpersistent WKWebView with JavaScript/external requests disabled. The legacy web renderer has different capabilities. Exact API bodies/results, recovery safeguards, backup/restore (including the stopped-home `restore reconcile` → `restore resume` sequence) and global access-code rotation are documented in [spec.md](../docs/spec.md) and [operating-model.md](../docs/operating-model.md).
