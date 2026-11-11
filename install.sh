#!/bin/sh
# IAMCEO 설치: curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
# Apple Silicon, macOS 14+. IAMCEO_VERSION=v0.2.0 pins a release.
# IAMCEO_DOWNLOAD_URL overrides the release asset directory (also accepts file:// for tests).
# IAMCEO_INSTALL_DIR overrides /Applications; tests must also supply an isolated HOME and PATH.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'IAMCEO 설치 실패: %s\n' "$*" >&2; exit 1; }
# Both languages: a failed signature check is the one error a non-Korean reader must not misread.
die2() { printf 'IAMCEO 설치 실패: %s\nIAMCEO install failed: %s\n' "$1" "$2" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die 'macOS에서만 설치할 수 있습니다.'
case "$(uname -m)" in
  arm64) ;;
  x86_64) [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ] || die 'Apple Silicon(arm64) Mac이 필요합니다.' ;;
  *) die 'Apple Silicon(arm64) Mac이 필요합니다.' ;;
esac
OS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
case "$OS_MAJOR" in ''|*[!0-9]*) die 'macOS 버전을 확인하지 못했습니다.' ;; esac
[ "$OS_MAJOR" -ge 14 ] || die 'macOS Sonoma(14) 이상이 필요합니다.'
DIR=${IAMCEO_INSTALL_DIR:-/Applications}
case "$DIR" in /*) ;; *) die 'IAMCEO_INSTALL_DIR은 절대 경로여야 합니다.' ;; esac
APP="$DIR/IAMCEO.app"
LABEL=com.iamceo.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# The publisher's Developer ID Application certificate (Apple team MQ2KQK37WD) and the app's bundle identifier.
# SHA256SUMS comes from the same release as the DMG, so a matching checksum only proves the download is intact.
# This requirement proves who signed the app; the Gatekeeper assessment proves Apple notarized it. A file fetched
# with curl carries no quarantine flag, so macOS would not run either check on its own at first launch.
SIGN_REQUIREMENT='=identifier "com.iamceo.native.mac" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "MQ2KQK37WD"'
for tool in curl shasum hdiutil ditto plutil pgrep codesign spctl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool 명령이 필요합니다."
done

# Inspect only; never unload an app-owned (or unrecognized) launchd job.
if [ -f "$PLIST" ]; then
  PROGRAM=$(plutil -extract Program raw -o - "$PLIST" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$PLIST" 2>/dev/null || true)
  SERVICE_LABEL=$(plutil -extract Label raw -o - "$PLIST" 2>/dev/null || true)
  if [ "$SERVICE_LABEL" = "$LABEL" ]; then
    case "$PROGRAM" in
      "$HOME/.local/bin/"*)
        say '이전 CLI 서비스가 등록돼 있습니다. 먼저 아래 명령으로 해제한 뒤 설치를 다시 실행하세요:'
        say "  \"$HOME/.local/bin/iamceo\" service uninstall"
        die '기존 서비스와 데이터는 변경하지 않았습니다.' ;;
    esac
  fi
elif [ -x "$HOME/.local/bin/iamceo" ]; then
  say '이전 CLI 실행 파일이 있습니다. 이번 설치는 Mac 앱을 설치합니다.'
fi
check_running() {
  if [ -e "$APP" ] && pgrep -x IAMCEO >/dev/null 2>&1; then
    die 'IAMCEO 앱을 종료한 뒤 다시 실행하세요. 실행 중인 앱은 덮어쓰지 않습니다.'
  fi
}
check_running

VERSION=${IAMCEO_VERSION:-}
if [ -n "$VERSION" ]; then
  VERSION=${VERSION#v}
  printf '%s\n' "$VERSION" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'IAMCEO_VERSION은 v0.2.0 같은 정식 버전이어야 합니다.'
fi
if [ -n "${IAMCEO_DOWNLOAD_URL:-}" ]; then
  BASE=${IAMCEO_DOWNLOAD_URL%/}
elif [ -n "$VERSION" ]; then
  BASE="https://github.com/yehsung/IAMCEO/releases/download/v$VERSION"
else
  BASE='https://github.com/yehsung/IAMCEO/releases/latest/download'
fi
TMP=$(mktemp -d "${TMPDIR:-/tmp}/iamceo-install.XXXXXX")
MOUNTED=0
STAGE=
INSTALLED=0
cleanup() {
  STATUS=$?
  trap - 0
  if [ "$MOUNTED" = 1 ]; then
    if ! hdiutil detach "$TMP/mount" >/dev/null; then
      say "디스크 마운트를 해제하지 못했습니다: $TMP/mount" >&2
      [ "$STATUS" -ne 0 ] || STATUS=1
    else
      MOUNTED=0
    fi
  fi
  if [ -n "$STAGE" ]; then
    # Roll back if moving the replacement into place failed.
    if [ "$INSTALLED" = 0 ] && [ -d "$STAGE/previous.app" ] && [ ! -e "$APP" ]; then
      mv "$STAGE/previous.app" "$APP" || say "이전 앱 복원 필요: $STAGE/previous.app" >&2
    fi
    if [ "$INSTALLED" = 1 ] || [ ! -e "$STAGE/previous.app" ]; then
      find "$STAGE" -depth -delete || true
    fi
  fi
  # Never recurse through a mounted volume, even when detach fails.
  if [ "$MOUNTED" = 0 ]; then
    find "$TMP" -depth -delete || true
  fi
  [ "$STATUS" -eq 0 ] || say '설치를 완료하지 못했습니다. 위 오류를 확인한 뒤 다시 실행하세요.' >&2
  exit "$STATUS"
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$TMP/mount"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || die 'SHA256SUMS를 받지 못했습니다.'
if [ -n "$VERSION" ]; then
  ASSET="IAMCEO-$VERSION-arm64.dmg"
else
  ASSET=$(awk '$2 ~ /^IAMCEO-[0-9]+\.[0-9]+\.[0-9]+-arm64\.dmg$/ {print $2}' "$TMP/SHA256SUMS")
  [ "$(printf '%s\n' "$ASSET" | wc -l | tr -d ' ')" = 1 ] && [ -n "$ASSET" ] || die '최신 릴리스에 설치 가능한 Mac DMG가 하나 있어야 합니다. v0.1.0 CLI 릴리스는 지원하지 않습니다.'
  VERSION=${ASSET#IAMCEO-}
  VERSION=${VERSION%-arm64.dmg}
fi
WANT=$(awk -v f="$ASSET" '$2 == f {print $1}' "$TMP/SHA256SUMS")
printf '%s\n' "$WANT" | /usr/bin/grep -Eq '^[a-fA-F0-9]{64}$' || die "SHA256SUMS에 유효한 $ASSET 체크섬이 없습니다."
[ "$(printf '%s\n' "$WANT" | wc -l | tr -d ' ')" = 1 ] || die '체크섬 항목이 중복돼 있습니다.'
say "받는 중: $BASE/$ASSET"
curl -fL --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET" || die 'DMG를 받지 못했습니다.'
GOT=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
[ "$(printf '%s' "$WANT" | tr 'A-F' 'a-f')" = "$GOT" ] || die 'SHA-256이 맞지 않습니다.'
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$TMP/mount" "$TMP/$ASSET" >/dev/null || die 'DMG를 마운트하지 못했습니다.'
MOUNTED=1
[ -d "$TMP/mount/IAMCEO.app" ] && [ ! -L "$TMP/mount/IAMCEO.app" ] || die 'DMG에 IAMCEO.app이 없습니다.'
# Verify on the read-only mount, before anything is read from the bundle or written to the install folder:
# a failure here leaves the installed app exactly as it was.
say '서명과 공증을 확인하는 중입니다. (Verifying the signature and notarization.)'
codesign --verify --deep --strict -R "$SIGN_REQUIREMENT" "$TMP/mount/IAMCEO.app" >/dev/null || die2 \
  '받은 앱의 서명이 IAMCEO 배포자의 것이 아니거나, 서명한 뒤에 앱이 바뀌었습니다. 아무것도 설치하거나 바꾸지 않았습니다.' \
  'The downloaded app is not signed by the IAMCEO publisher, or it was modified after signing. Nothing was installed or changed.'
spctl -a -t execute "$TMP/mount/IAMCEO.app" >/dev/null || die2 \
  'macOS가 받은 앱을 통과시키지 않았습니다(Apple 공증 확인 실패). 아무것도 설치하거나 바꾸지 않았습니다.' \
  'macOS Gatekeeper rejected the downloaded app (Apple notarization check failed). Nothing was installed or changed.'
APP_VERSION=$(plutil -extract CFBundleShortVersionString raw -o - "$TMP/mount/IAMCEO.app/Contents/Info.plist") || die '앱 버전을 읽지 못했습니다.'
[ "$APP_VERSION" = "$VERSION" ] || die 'DMG 이름과 앱 버전이 다릅니다.'
mkdir -p "$DIR" || die "$DIR 폴더를 만들 수 없습니다."
STAGE=$(mktemp -d "$DIR/.iamceo-install.XXXXXX") || die "$DIR 쓰기 권한이 필요합니다."
ditto "$TMP/mount/IAMCEO.app" "$STAGE/IAMCEO.app" || die '앱을 복사하지 못했습니다.'
check_running
[ ! -L "$APP" ] || die '설치 대상이 심볼릭 링크입니다. 직접 확인하세요.'
[ ! -e "$APP" ] || [ -d "$APP" ] || die '설치 대상이 앱 폴더가 아닙니다. 직접 확인하세요.'
if [ -e "$APP" ]; then mv "$APP" "$STAGE/previous.app" || die '이전 앱을 보관하지 못했습니다.'; fi
mv "$STAGE/IAMCEO.app" "$APP" || die '앱을 설치하지 못했습니다.'
INSTALLED=1
hdiutil detach "$TMP/mount" >/dev/null || die 'DMG를 해제하지 못했습니다.'
MOUNTED=0
open "$APP" || die "앱은 설치됐습니다. $APP 을 직접 여세요."
say "설치했습니다: $APP ($VERSION)"
say '다음: 앱에서 ‘이 Mac에서 시작’을 선택하세요. 기존 CLI 로그인과 프로젝트 데이터는 그대로 사용합니다.'
