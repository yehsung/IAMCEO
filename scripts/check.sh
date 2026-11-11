#!/usr/bin/env bash
# Public, isolated checks. Usage: bash scripts/check.sh all|ts|server [test files...]|swift|build
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CHECK_TMP=${TMPDIR:-/tmp}
CHECK_ROOT=$(mktemp -d "${CHECK_TMP%/}/iamceo-check.XXXXXX")
cleanup() {
  # Tests create read-only dirs on purpose. A cleanup failure must never change the checks' exit status.
  python3 - "$CHECK_ROOT" <<'PY' || printf 'check: could not remove %s\n' "$CHECK_ROOT" >&2
import os, shutil, sys
def unlock(func, path, _exc):
    os.chmod(os.path.dirname(path), 0o700)
    if os.path.isdir(path) and not os.path.islink(path):
        os.chmod(path, 0o700)
    func(path)
shutil.rmtree(sys.argv[1], onerror=unlock)
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
report() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY" || true; fi
}
# Without arguments every file runs in its own process: a leaked timer or handle in one file cannot fail
# another, and a failure names its file. A failed file is re-run once in a fresh process. Failing twice
# fails the gate; passing the second time is reported as FLAKY, never hidden. IAMCEO_TEST_RETRY=0 turns
# the re-run off. The default per-test limit is 30 s (slow CI runners); explicit per-test limits still apply.
server() {
  if [ "$#" -gt 0 ]; then
    bun test "$@"
    return
  fi
  local limit=${IAMCEO_TEST_TIMEOUT_MS:-30000} file total=0
  local failed=() flaky=() broken=()
  for file in tests/*.test.ts; do
    total=$((total + 1))
    bun test --timeout="$limit" "./$file" || failed+=("$file")
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    for file in "${failed[@]}"; do
      if [ "${IAMCEO_TEST_RETRY:-1}" = 0 ]; then broken+=("$file"); continue; fi
      printf '\n== re-run in a fresh process: %s\n' "$file"
      if bun test --timeout="$limit" "./$file"; then flaky+=("$file"); else broken+=("$file"); fi
    done
  fi
  report "server tests: $total files, ${#broken[@]} failed, ${#flaky[@]} flaky"
  if [ "${#flaky[@]}" -gt 0 ]; then
    for file in "${flaky[@]}"; do report "FLAKY: $file (failed once, passed on re-run)"; done
  fi
  if [ "${#broken[@]}" -gt 0 ]; then
    for file in "${broken[@]}"; do report "FAILED: $file"; done
    return 1
  fi
}
# A skipped native test is not a passed one: list every skip. With IAMCEO_REQUIRE_APPKIT_TESTS=1 (a run
# outside the sandbox) a skipped drag-and-drop upload test fails the check.
swift_check() {
  local args=(--package-path native --build-system native --scratch-path "$CHECK_ROOT/swift-build"
    --cache-path "$CHECK_ROOT/swift-cache" --config-path "$CHECK_ROOT/swift-config" --security-path "$CHECK_ROOT/swift-security")
  local log="$CHECK_ROOT/swift-test.log" status=0 skipped
  swift build "${args[@]}"
  swift test "${args[@]}" 2>&1 | tee "$log" || status=$?
  skipped=$(sed -n "s/^Test Case '-\[\(.*\)\]' skipped .*/\1/p" "$log" | sort -u)
  if [ -n "$skipped" ]; then
    report "SKIPPED native tests ($(printf '%s\n' "$skipped" | wc -l | tr -d ' ')):"
    report "$skipped"
  fi
  if [ "$status" -ne 0 ]; then return "$status"; fi
  if [ "${IAMCEO_REQUIRE_APPKIT_TESTS:-0}" = 1 ] && printf '%s\n' "$skipped" | grep -q 'MacAttachmentUploadTests '; then
    report "FAILED: drag-and-drop upload tests were skipped; run outside the sandbox"
    return 1
  fi
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
