# IAMCEO

[한국어](README.ko.md)

A native desk for directing parallel Claude Code and Codex agents. macOS and iOS share Home, Inbox, Team, Conversation and Files; each connects directly to the Mac's IAMCEO daemon.

This working tree introduces **SwiftUI clients and one runtime: herdr-core**, running the official interactive CLIs in persistent terminal holders. Previously published releases may still use the old architecture. Legacy Herdr/headless code remains for historical data and regression tests, not as selectable production backends.

## Build and start

Requires macOS 14+, Xcode with Swift 6, XcodeGen, Bun 1.3+, and your chosen official provider CLI(s), installed and logged in. Current Liquid Glass controls require macOS/iOS 26; earlier systems use materials.

```sh
bun install
bun run build:native
open dist/native/IAMCEO.app
```

Choose **이 Mac에서 시작**. The app bundles the daemon and pinned, checksum-verified Herdr Core.app. It registers the local launchd service only after that action. Provider CLIs and account login remain user-managed. Healthy existing IAMCEO services are reused; conflicting installations are not automatically replaced. Keep the app at a stable path before starting its service.

The app is locally ad-hoc signed, not a notarized public release. Building does not install or start services.

```sh
# Explicit read-only sample workspace
open -n dist/native/IAMCEO.app --args --demo

# Source development without the native bundle
bun run setup:core
bun run start
# Another terminal: addresses and access code
bun bin/iamceo.ts open
```

Data lives in `~/.iamceo`; use `IAMCEO_HOME` for isolation. Existing-database migrations first create a consistent SQLite backup and abort if backup creation fails. Legacy sessions are not silently adopted or terminated.

## iPhone and remote access

Run `xcodegen generate --spec native/project.yml` and select IAMCEO-iOS. Physical devices need a development team/signing setup; see [native instructions](native/README.md).

Connect Mac and phone through Tailscale. Configure **Tailscale Serve HTTPS** to proxy the host's `http://127.0.0.1:7878`, then enter its HTTPS origin and IAMCEO access code in the phone app. Remote native connections require HTTPS; bare `http://100.x.y.z` is rejected. The phone's localhost is not the host. Codes are stored in Keychain.

Closing either app leaves host work running. The Mac must remain awake; sleep, power loss and reboot stop execution. Native clients currently refresh every three seconds while foregrounded. APNs background push is not implemented yet.

## Agent operation

- Chief defaults to Claude; choose Codex at project creation or change an idle member. Leads choose their providers independently.
- Official CLI tools, settings and authentication remain in use. IAMCEO adds invocation-scoped instructions and an MCP bridge, not a replacement model API.
- Provider changes create a fresh session with task handoff. Member/task/decision history remains; hidden model context and provider caches do not transfer. Working sessions and uncertain deliveries block switching. Failed starts show a recoverable error.
- Claude native parallel mode and Codex subagent configuration/instructions are supported as distinct provider capabilities.
- Inbox cards cover decisions and requests for information. CLI trust/permission menus are handled in a member's terminal control sheet. Claiming control pauses automatic delivery for up to five minutes; release when done.
- State comes from OSC 7501. Unknown state or a nonempty draft holds delivery. Uncertain sends are not automatically replayed.
- `iamceo attach <member-id>` attaches directly. Raw external input cannot provide the app's exclusive lease; avoid simultaneous automatic and external typing.

## Configuration and limits

`config.json` supports `port`, `hosts`, `claudeBin`, `codexBin`, `coreBin`, `coreSocket`, and `accessCode`. Overrides: `IAMCEO_CLAUDE_BIN`, `IAMCEO_CODEX_BIN`, `IAMCEO_CORE_BIN`, `IAMCEO_PORT`, `IAMCEO_CORE_SOCKET`, `IAMCEO_HOME`. Service installation preserves resolved executable paths.

The existing permission default remains `bypassPermissions`; change it in Settings if desired. Provider processes run with your host account's privileges. Subscription access and limits follow each provider's policies; IAMCEO does not bypass them.

Core automatic compaction is disabled. New Codex native session IDs are not yet discovered: a lost terminal requires explicit fresh-session handoff from the member detail view instead of guessed resume. Native HTML previews disable scripts and external requests. Windows, Android, APNs, distribution signing and Intel Mac runtime validation remain future work.

## Development

```sh
bun run typecheck
bun test tests
bun run native:test
```

Automated tests use temporary homes and fake providers. Separate real CLI smoke tests may consume account usage. The legacy web interface remains during native transition. See [architecture](docs/architecture.md), [operating model](docs/operating-model.md), [native client](native/README.md), [core attribution](vendor/herdr-core/README.md).

## License

IAMCEO retains [AGPL-3.0-only](LICENSE). This implementation does not change its license. Bundled herdr-core is Apache-2.0; its license, third-party notices and upstream signature are preserved.
