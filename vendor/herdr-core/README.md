# herdr-core dependency

IAMCEO uses the upstream **herdr-core 0.1.18**, protocol generation **1**, as its terminal runtime. Official interactive Claude Code and Codex CLI programs run in core-owned PTYs; IAMCEO is the client and domain coordinator.

- Upstream repository: [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core).
- Reviewed source: [`c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a`](https://github.com/herdrdev/herdr-core/tree/c6b316f87c33e6f2ab1a1ceea3e3461e2b6bb61a).
- Binary release and target archive SHA-256 values: [release-lock.json](release-lock.json). This is a reviewed repository pin, not a mutable online `latest` lookup.
- Upstream license: **Apache License 2.0**, reproduced in [LICENSE](LICENSE). Bundled component attributions and licenses are reproduced in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES), including Ghostty's libghostty-vt and other upstream dependencies.

This directory contains dependency metadata and notices. The installed upstream bundle lives under `.runtime/herdr-core/0.1.18/` and is not committed as a source fork. IAMCEO's own license remains unchanged; the core and its dependencies retain their respective licenses and notices.

## Local setup and packaging

From the repository root, run `bun run setup:core`. [scripts/setup-core.ts](../../scripts/setup-core.ts) selects the pinned macOS/Linux target, verifies the downloaded archive against the checked-in SHA-256, checks archive paths and required notices, validates the executable version, then publishes the local installation. It records archive and executable hashes in `verified.json`; a changed or incomplete installation is rejected. Setup does not start a core, register a service, replace a global CLI, or update a running daemon. Windows is present in the upstream release lock but this setup script does not install it.

On macOS, the selected executable is the signed upstream `Herdr Core.app/Contents/MacOS/herdr-core`. Setup and native packaging verify the app with `codesign --verify --strict`, requiring identifier `dev.herdr.core`, an Apple signing anchor, and Developer Team `2W9652Q7QR`. Treat that pinned signing identity as part of dependency review, not a value to loosen when validation fails.

[scripts/build-native.ts](../../scripts/build-native.ts) copies the upstream app bundle into IAMCEO's runtime resources, preserves its executable hash and vendor signature, and includes LICENSE, THIRD-PARTY-NOTICES, release-lock.json and verification metadata. It does not recursively re-sign the core with IAMCEO's identity. Local ad-hoc signing of the outer IAMCEO app is separate from Developer ID distribution or notarization.

Normal IAMCEO serve startup uses its own `HC_SESSION=iamceo`, socket and XDG state/config roots. CLI programs retain their normal user HOME/XDG configuration. IAMCEO shutdown disconnects and leaves holder-owned programs running. Installation and packaging must never stop, replace or upgrade unrelated user daemons.

## Updating the pin

1. Select a specific upstream release and resolve its source commit. Review the upstream changes, license/notices, security behavior and generation-1 schema compatibility. Update the source SHA/version in this document together with the release lock.
2. Obtain the release archives and SHA-256 values through the upstream release channel, independently verify the chosen artifacts and macOS signing identity, then replace the explicit URLs/checksums in release-lock.json. Do not download and accept an unreviewed `latest` manifest at application startup.
3. Refresh LICENSE and THIRD-PARTY-NOTICES from that release if upstream changed them. Preserve their text and include them in distributed runtime resources. This dependency update does not authorize changing IAMCEO's license.
4. Install into a separate versioned `.runtime/herdr-core/<version>/` directory. Do not overwrite a verified existing version or invoke a global `hc update`, `server restart` or `server stop` as part of setup/build. Explicitly plan any live-session handover separately.
5. Run core client/runner and server contract tests, typecheck, and native tests/builds. In an isolated IAMCEO_HOME/HC_SESSION/socket/XDG environment, verify both official CLIs start, native OSC 7501 status arrives, app/server disconnect preserves the PTYs, reconnect joins the same terminal, and uncertain input is not replayed. Use fake models for delivery tests; real paid prompts require their own explicit authorization.
6. Review the resulting release diff and bundled notices/signature/hash checks before distributing the new app. Keep the old runtime available until the deliberate upgrade and rollback plan has been completed.

The upstream socket grants the current OS user powerful terminal control. Keep its directories private; do not publish or forward the raw socket as an unauthenticated remote API. IAMCEO's authenticated REST API is a separate boundary, described in [docs/spec.md](../../docs/spec.md).
