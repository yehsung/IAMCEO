# IAMCEO native

A SwiftUI client for the existing IAMCEO Bun daemon. The daemon owns the CLI processes, official `core` backend, project state, credentials and orchestration. The app talks directly to its REST API; it does not run a second coordinator or proxy model traffic.

Requires Xcode 16+ / Swift 6 and macOS 14+ or iOS 17+. Native system controls follow Liquid Glass on macOS/iOS 26+. Custom workspace cards use translucent materials and dark violet gradients.

```sh
# From the repository root
# Bundled Mac application, including the daemon and official core runtime
bun run build:native
open dist/native/IAMCEO.app

# Source development client (connect to an existing daemon)
swift run --package-path native IAMCEO
swift test --package-path native

# Explicit sample workspace; read-only and never connects to a daemon
swift run --package-path native IAMCEO --demo

# Generate the macOS + iOS Xcode project
xcodegen generate --spec native/project.yml
open native/IAMCEO.xcodeproj

# Build without developer signing for local validation
xcodebuild -project native/IAMCEO.xcodeproj -scheme IAMCEO-macOS \
  -configuration Debug -derivedDataPath native/DerivedData CODE_SIGNING_ALLOWED=NO build
xcodebuild -project native/IAMCEO.xcodeproj -scheme IAMCEO-iOS \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath native/DerivedData CODE_SIGNING_ALLOWED=NO build
```

The macOS target is a local host application intended for Developer ID distribution, with App Sandbox disabled so its explicit local-host controls can install/start the bundled launchd daemon. The iOS target uses the normal platform sandbox and connects to a Mac remotely.

In the bundled Mac app, choose “이 Mac에서 시작하기” to explicitly prepare the local daemon. Source development clients can connect to a daemon started as documented in the repository README by entering its origin and access code. On the same Mac the default origin is `http://127.0.0.1:7878`. iPhone/iPad loopback points to the device itself; connect through your Mac's HTTPS Tailscale Serve URL instead. Remote origins require HTTPS. Access codes are stored in this device's Keychain, scoped to the endpoint; only the endpoint is stored in UserDefaults. Disconnect removes the saved access code. Use a development team in Xcode for a physical device installation.

The client refreshes bootstrap/project state every three seconds **while foregrounded**. It cancels project reads and clears the old project when switching, and pauses polling when backgrounded. This is polling, not a WebSocket subscription. Network errors remain visible and mutations never report offline success. A retried chat submission preserves its original message ID after a lost acknowledgement. Decision answers include the exact `updatedAt` as `expectedVersion`; a changed decision is rejected by the daemon rather than overwritten.

Home, Inbox, Team, Chat, Files and Settings use the real REST models. Creating projects and members, provider/model changes, decision and todo responses, member actions, authenticated attachment fetch/upload, artifact HTML, activity and terminal screens are supported by the service/store layer. Terminal input requires claiming a manual-control lease; a failed control request clears the local lease and requires claiming again. Only documented terminal keys are allowed. A lease is server-enforced and pauses automatic delivery until released or expired.

Attachment requests use a Bearer header, never a token in the URL. The client refuses foreign-origin attachment URLs and HTTP redirects, so a daemon-supplied file URL cannot forward its access code to another host. Artifact rendering must stay isolated from app credentials and file access.

`--demo` is a deliberate, visibly labeled sample workspace for previews/screenshots. It is read-only; a normal launch has no sample data and requires a successful daemon connection. Unit tests exercise tolerant contract decoding, malformed responses, authorization headers, endpoint/file origin restrictions, explicit null model resets, decision versions and stable IDs across a real URLSession retry with a mocked network response.

The generated Xcode project is reproducible from `project.yml`; regenerate after adding source files. No signing identity or service credential is committed.
