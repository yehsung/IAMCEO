#!/bin/sh
# IAMCEO 설치: curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
# GitHub 릴리스에서 이 맥에 맞는 실행 파일을 받아 SHA-256 을 맞춰 보고 ~/.local/bin/iamceo 에 둔다. 다시 실행하면 새 판으로 바꾼다.
#   IAMCEO_INSTALL_DIR  둘 폴더 (기본 ~/.local/bin)
#   IAMCEO_VERSION      받을 판, 예: v0.1.0 (기본 최신)
#   IAMCEO_DOWNLOAD_URL 받을 곳을 통째로 바꾼다 (시험용. 이 주소 아래에 iamceo-darwin-* 와 SHA256SUMS 가 있어야 한다)
set -eu

REPO="yehsung/IAMCEO"
DIR="${IAMCEO_INSTALL_DIR:-$HOME/.local/bin}"
LABEL="com.iamceo.server"

say() { printf '%s\n' "$*"; }
die() { printf 'iamceo 설치 실패: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "지금은 macOS 에서만 됩니다."
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64)
    # Rosetta 로 돌아가는 터미널이면 실제 칩은 Apple Silicon 이다.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi ;;
  *) die "모르는 CPU 입니다: $(uname -m)" ;;
esac
ASSET="iamceo-darwin-$ARCH"

if [ -n "${IAMCEO_DOWNLOAD_URL:-}" ]; then
  BASE="$IAMCEO_DOWNLOAD_URL"
elif [ -n "${IAMCEO_VERSION:-}" ]; then
  BASE="https://github.com/$REPO/releases/download/$IAMCEO_VERSION"
else
  BASE="https://github.com/$REPO/releases/latest/download"
fi

command -v curl >/dev/null 2>&1 || die "curl 이 필요합니다."
command -v shasum >/dev/null 2>&1 || die "shasum 이 필요합니다."

TMP="$(mktemp -d "${TMPDIR:-/tmp}/iamceo-install.XXXXXX")"
trap 'rm -f "$TMP/$ASSET" "$TMP/SHA256SUMS"; rmdir "$TMP" 2>/dev/null || true' EXIT

say "받는 중: $BASE/$ASSET"
curl -fL --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET" || die "실행 파일을 받지 못했습니다: $BASE/$ASSET"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || die "SHA256SUMS 를 받지 못했습니다."

WANT="$(awk -v f="$ASSET" '$2 == f { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$WANT" ] || die "SHA256SUMS 에 $ASSET 이 없습니다."
GOT="$(shasum -a 256 "$TMP/$ASSET" | awk '{ print $1 }')"
[ "$WANT" = "$GOT" ] || die "SHA-256 이 맞지 않습니다. 받은 파일이 깨졌거나 바뀌었습니다."

chmod +x "$TMP/$ASSET"
VERSION="$("$TMP/$ASSET" version 2>/dev/null)" || die "받은 실행 파일이 이 맥에서 돌지 않습니다."

mkdir -p "$DIR"
# 돌고 있는 실행 파일을 덮어쓰지 않고 새 파일로 바꿔 넣는다(서비스가 쓰는 중이어도 안전).
mv -f "$TMP/$ASSET" "$DIR/iamceo.new"
mv -f "$DIR/iamceo.new" "$DIR/iamceo"
say "설치했습니다: $DIR/iamceo ($VERSION)"

# 이 실행 파일로 등록된 서비스가 있으면 새 판으로 다시 켠다.
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ] && grep -qF "<string>$DIR/iamceo</string>" "$PLIST"; then
  if launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then say "서비스를 새 판으로 다시 켰습니다."; fi
fi

case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    say ""
    say "$DIR 이 PATH 에 없습니다. 셸 설정(~/.zshrc 등)에 아래 줄을 넣고 새 터미널을 여세요:"
    say "  export PATH=\"$DIR:\$PATH\""
    ;;
esac

if ! command -v claude >/dev/null 2>&1; then
  say ""
  say "claude 명령이 없습니다. 직원을 띄우려면 Claude Code 를 설치하고 로그인하세요: https://code.claude.com/docs/en/setup"
fi

say ""
say "다음:"
say "  iamceo setup             실행 방식(herdr 또는 headless)·포트·접근 범위"
say "  iamceo service install   로그인할 때 켜지고 죽으면 다시 켜지는 서비스로 등록"
say "  iamceo open              접속 주소와 접속 코드"
