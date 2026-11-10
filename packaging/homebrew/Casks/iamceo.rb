# Release template: scripts/release-mac.ts writes the real version and digest to dist/release/iamceo.rb.
# Do not publish this template to a tap before generating the notarized DMG.
cask "iamceo" do
  version "0.2.2"
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

  uninstall script: service_cleanup

  zap script: service_cleanup,
      trash:  "~/.iamceo"
end
