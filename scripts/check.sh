#!/usr/bin/env bash
# Public, isolated checks. Usage: bash scripts/check.sh all|ts|server [test files...]|swift|build
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CHECK_TMP=${TMPDIR:-/tmp}
CHECK_ROOT=$(mktemp -d "${CHECK_TMP%/}/iamceo-check.XXXXXX")
cleanup() {
  python3 - "$CHECK_ROOT" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1])
PY
}
trap cleanup EXIT
mkdir -p "$CHECK_ROOT"/{home,iamceo,claude,codex,core-state,core-config,work,bin,tmp}
for name in core claude codex herdr; do
  printf '#!/bin/sh\nprintf "Isolated check: real runtime disabled\\n" >&2\nexit 97\n' > "$CHECK_ROOT/bin/$name"
  chmod +x "$CHECK_ROOT/bin/$name"
done
unset HC_SOCKET HC_SESSION HERDR_SOCKET_PATH CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT CLAUDE_CODE_SESSION_ID
unset BUN_OPTIONS NODE_OPTIONS
export HOME="$CHECK_ROOT/home" TMPDIR="$CHECK_ROOT/tmp"
export IAMCEO_TEST=1 IAMCEO_PORT=0 IAMCEO_HOME="$CHECK_ROOT/iamceo"
export IAMCEO_HERDR_SOCKET="$CHECK_ROOT/no-herdr.sock" IAMCEO_CORE_SOCKET="$CHECK_ROOT/no-core.sock"
export IAMCEO_CORE_BIN="$CHECK_ROOT/bin/core" IAMCEO_CLAUDE_BIN="$CHECK_ROOT/bin/claude" IAMCEO_CODEX_BIN="$CHECK_ROOT/bin/codex"
export HERDR_BIN_PATH="$CHECK_ROOT/bin/herdr" CLAUDE_CONFIG_DIR="$CHECK_ROOT/claude" CODEX_HOME="$CHECK_ROOT/codex"
export XDG_STATE_HOME="$CHECK_ROOT/core-state" XDG_CONFIG_HOME="$CHECK_ROOT/core-config" XDG_CACHE_HOME="$CHECK_ROOT/cache"
export CLANG_MODULE_CACHE_PATH="$CHECK_ROOT/clang" SWIFTPM_MODULECACHE_OVERRIDE="$CHECK_ROOT/swift-module"
ts() { ./node_modules/.bin/tsc --noEmit --incremental false -p .; }
server() {
  if [ "$#" -gt 0 ]; then
    bun test "$@"
  else
    local files=() file
    for file in tests/*.test.ts; do
      case "$file" in tests/herdr.test.ts) continue ;; esac
      files+=("$file")
    done
    bun test "${files[@]}"
  fi
}
swift_check() {
  local args=(--package-path native --build-system native --scratch-path "$CHECK_ROOT/swift-build"
    --cache-path "$CHECK_ROOT/swift-cache" --config-path "$CHECK_ROOT/swift-config" --security-path "$CHECK_ROOT/swift-security")
  swift build "${args[@]}"
  swift test "${args[@]}"
}
build() {
  bun build bin/iamceo.ts --compile --outfile "$CHECK_ROOT/iamceo-bin"
  mkdir -p "$CHECK_ROOT/native"
  cp -R native/Sources native/Configuration native/Resources native/project.yml "$CHECK_ROOT/native/"
  xcodegen generate --spec "$CHECK_ROOT/native/project.yml" --project "$CHECK_ROOT/native" --quiet
  xcodebuild -quiet -project "$CHECK_ROOT/native/IAMCEO.xcodeproj" -scheme IAMCEO-macOS -configuration Debug \
    -derivedDataPath "$CHECK_ROOT/dd-mac" CODE_SIGNING_ALLOWED=NO build
  xcodebuild -quiet -project "$CHECK_ROOT/native/IAMCEO.xcodeproj" -scheme IAMCEO-iOS -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$CHECK_ROOT/dd-ios" CODE_SIGNING_ALLOWED=NO build
}
mode=${1:-all}
if [ "$#" -gt 0 ]; then shift; fi
case "$mode" in
  all) ts; server; swift_check; build ;;
  ts) ts ;;
  server) server "$@" ;;
  swift) swift_check ;;
  build) build ;;
  *) printf 'Usage: bash scripts/check.sh all|ts|server [files...]|swift|build\n' >&2; exit 2 ;;
esac
