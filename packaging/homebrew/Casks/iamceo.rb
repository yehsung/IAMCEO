# Release template: scripts/release-mac.ts writes the real version and digest to dist/release/iamceo.rb.
# Do not publish this template to a tap before generating the notarized DMG.
cask "iamceo" do
  version "0.2.3"
  sha256 "@SHA256@"

  url "https://github.com/yehsung/IAMCEO/releases/download/v#{version}/IAMCEO-#{version}-arm64.dmg"
  name "IAMCEO"
  desc "Operate your AI team from a native Mac app"
  homepage "https://github.com/yehsung/IAMCEO"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "IAMCEO.app"

  # Never use an unconditional launchctl stanza: the old CLI shares this label.
  # Both uninstall and zap inspect the executable before touching a job/plist.
  service_cleanup = {
    executable: "/bin/sh",
    args:       ["-c", <<~SH, "iamceo-uninstall", appdir.to_s],
      set -eu
      plist="$HOME/Library/LaunchAgents/com.iamceo.server.plist"
      [ -f "$plist" ] || exit 0
      [ ! -L "$plist" ] || exit 0
      label=$(/usr/bin/plutil -extract Label raw -o - "$plist" 2>/dev/null || true)
      program=$(/usr/bin/plutil -extract Program raw -o - "$plist" 2>/dev/null || /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$plist" 2>/dev/null || true)
      [ "$label" = com.iamceo.server ] || exit 0
      [ "$program" = "$1/IAMCEO.app/Contents/Resources/runtime/iamceo" ] || exit 0
      domain="gui/$(/usr/bin/id -u)"
      # A loaded job may differ from the file on disk; refuse that case too.
      loaded=$(/bin/launchctl print "$domain/com.iamceo.server" 2>/dev/null || true)
      if [ -n "$loaded" ]; then
        live=$(printf '%s\n' "$loaded" | /usr/bin/sed -n 's/^[[:space:]]*program = //p')
        [ "$live" = "$program" ] || exit 0
        /bin/launchctl bootout "$domain/com.iamceo.server"
      fi
      /bin/rm -f "$plist"
    SH
    sudo:       false,
    must_succeed: true,
  }

  # zap only (`brew uninstall --zap`), never in `uninstall`: the uninstall stanza also runs on every
  # `brew upgrade`, and stopping here would end every AI session on each upgrade.
  # Before zap, brew has already run the uninstall stanza (service_cleanup removed the app-owned plist)
  # and moved the app back to the Caskroom, so the runtime is looked up in staged_path first.
  # `iamceo uninstall --purge --yes` ends every terminal in the session engine, stops the engine and
  # deletes ~/.iamceo. A plist that is still present belongs to another installation (legacy CLI or a
  # source checkout), so nothing is stopped then. If this step fails or finds no runtime, `trash` below
  # still moves the data folder to the Trash.
  full_stop = {
    executable: "/bin/sh",
    args:       ["-c", <<~SH, "iamceo-zap", staged_path.to_s, appdir.to_s],
      set -eu
      plist="$HOME/Library/LaunchAgents/com.iamceo.server.plist"
      if [ -e "$plist" ] || [ -L "$plist" ]; then exit 0; fi
      for app in "$1/IAMCEO.app" "$2/IAMCEO.app"; do
        bin="$app/Contents/Resources/runtime/iamceo"
        [ -x "$bin" ] || continue
        core="$app/Contents/Resources/runtime/Herdr Core.app/Contents/MacOS/herdr-core"
        [ -x "$core" ] || core=""
        exec /usr/bin/env IAMCEO_CORE_BIN="$core" "$bin" uninstall --purge --yes
      done
    SH
    sudo:       false,
    must_succeed: false,
  }

  uninstall script: service_cleanup

  zap early_script: service_cleanup,
      script: full_stop,
      trash:  "~/.iamceo"
end
