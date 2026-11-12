#!/usr/bin/env bash
# Public, isolated checks. Usage: bash scripts/check.sh all|ts|server [test files...]|compat|swift|ios|build
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
CHECK_TMP=${TMPDIR:-/tmp}
CHECK_ROOT=$(mktemp -d "${CHECK_TMP%/}/iamceo-check.XXXXXX")
# iPhone 시험 단계(ios_check)가 쥔 것: 이 Mac 전체의 잠금, 이 단계가 켠 시뮬레이터, 돌고 있는 xcodebuild.
# 어떻게 끝나든(성공·실패·Ctrl-C·종료 신호) cleanup 이 푼다.
ios_lock="" ios_booted="" ios_child=""
ios_release() {
  if [ -n "$ios_child" ]; then kill "$ios_child" 2>/dev/null || true; wait "$ios_child" 2>/dev/null || true; ios_child=""; fi
  # 이 단계가 켠 기기만 끈다(처음에 꺼져 있던 것). 끄지 못해도 결과는 바꾸지 않는다.
  if [ -n "$ios_booted" ]; then xcrun simctl shutdown "$ios_booted" >/dev/null 2>&1 || true; ios_booted=""; fi
  if [ -n "$ios_lock" ]; then rm -f "$ios_lock/owner"; rmdir "$ios_lock" 2>/dev/null || true; ios_lock=""; fi
}
cleanup() {
  ios_release
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
  if [ "$status" -ne 0 ]; then
    # The server rule, for native tests: the tests that failed run once more in a fresh process. Failing twice fails
    # the gate; passing the second time is reported as FLAKY, never hidden. A failure that names no test (a compile
    # error, a crash) is not retried. IAMCEO_TEST_RETRY=0 turns the re-run off.
    local failed again count name retry="$CHECK_ROOT/swift-retry.log" filters=()
    local pick="s/^Test Case '-\\[\\(IAMCEOTests\\.[A-Za-z0-9_]*\\) \\([A-Za-z0-9_]*\\)\\]' failed .*/\\1\\/\\2/p"
    failed=$(sed -n "$pick" "$log" | sort -u)
    if [ -z "$failed" ] || [ "${IAMCEO_TEST_RETRY:-1}" = 0 ]; then
      if [ -n "$failed" ]; then report "FAILED native tests:"; report "$failed"; fi
      return "$status"
    fi
    count=$(printf '%s\n' "$failed" | wc -l | tr -d ' ')
    while IFS= read -r name; do filters+=(--filter "^${name}\$"); done <<EOF_FAILED
$failed
EOF_FAILED
    printf '\n== re-run in a fresh process: %s native test(s)\n' "$count"
    status=0
    swift test "${args[@]}" "${filters[@]}" 2>&1 | tee "$retry" || status=$?
    again=$(sed -n "$pick" "$retry" | sort -u)
    if [ "$status" -ne 0 ] || [ -n "$again" ] || ! grep -Eq "Executed $count tests?, with (.* and )?0 failures" "$retry"; then
      report "FAILED native tests (failed twice):"; report "${again:-$failed}"
      return 1
    fi
    report "native tests: $count flaky"
    while IFS= read -r name; do report "FLAKY: $name (failed once, passed on re-run)"; done <<EOF_FLAKY
$failed
EOF_FLAKY
  fi
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
# 출시 앱 호환(D5): 서버가 실제 응답과 실시간 사건을 파일로 남기고(tests/compat-dump.test.ts),
# 출시 태그에서 꺼낸 그 앱의 해석 코드가 그것을 풀어 본다(scripts/compat-decoders/run.ts).
# 출시 태그(git fetch --tags, CI 는 checkout 에 fetch-depth: 0)와 Swift 도구가 있어야 한다.
compat() {
  local out="$CHECK_ROOT/compat"
  mkdir -p "$out/dump"
  IAMCEO_COMPAT_OUT="$out/dump" bun test --timeout=60000 ./tests/compat-dump.test.ts
  bun scripts/compat-decoders/run.ts "$out/dump" "$out/work"
}
# E8: 같은 앱 시험(native/Tests)을 iPhone 시뮬레이터에서 돌린다(native/project.yml 의 IAMCEO-iOS-Tests 계획).
# 시뮬레이터는 이 Mac 에 있는 것 중에서 고른다. IAMCEO_IOS_SIMULATOR(UDID 나 이름)가 있으면 그것, 없으면 이름이 "iPhone "
# 으로 시작하는 기기 가운데 꺼져 있는 것(누가 보고 있을 수 있는 켜진 기기는 뒤로), 가장 새 iOS 순이다.
# 부팅은 xcodebuild 가 한다. 이미 떠 있던 시뮬레이터는 끄거나 지우지 않고, 이 단계가 띄운 기기만 끝나면 다시 끈다.
# 실패한 시험만 한 번 더 돌려(test-without-building) 통과하면 FLAKY 로 남긴다. IAMCEO_TEST_RETRY=0 은 재실행을 끈다.
# IAMCEO_IOS_OPTIONAL=1(check.sh all)이면 iPhone 시뮬레이터가 없을 때 실패 대신 SKIPPED 로 알린다.
# 이 Mac 에서 동시에 돈 두 실행이 같은 기기를 고르고 먼저 끝난 쪽이 끄지 않게, 고르기부터 끄기까지 이 Mac 전체의 잠금
# (IAMCEO_IOS_LOCK, 기본 /tmp/iamceo-check-ios.lock. TMPDIR 은 실행마다 달라 쓰지 않는다)을 쥔다. 기다리는 시간은
# IAMCEO_IOS_LOCK_WAIT_S(기본 3600초). 강제로 끝난(kill -9) 실행이 남긴 잠금은 그 프로세스가 없으면 치운다.
# 실패하면 실패한 시험의 오류 줄(assert 문구·file:line)을 보이고 전체 기록을 CHECK_TMP 에 남긴다.
pick_simulator() {
  python3 -c '
import json, re, sys
want = sys.argv[1]
rows = []
for runtime, devices in json.load(open(sys.argv[2]))["devices"].items():
    m = re.search(r"SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$", runtime)
    if not m:
        continue
    version = tuple(int(x or 0) for x in m.groups())
    rows += [(version, d) for d in devices if d.get("isAvailable", True)]
if want:
    rows = [r for r in rows if want in (r[1]["udid"], r[1]["name"])]
else:
    rows = [r for r in rows if r[1]["name"].startswith("iPhone ")]
rows.sort(key=lambda r: (not want and r[1]["state"] != "Shutdown", tuple(-x for x in r[0]), r[1]["name"]))
if not rows:
    sys.exit(1)
version, device = rows[0]
print("\t".join([device["udid"], device["state"], "%s (iOS %d.%d)" % (device["name"], version[0], version[1])]))
' "${IAMCEO_IOS_SIMULATOR:-}" "$1"
}
ios_take_lock() {
  local dir=${IAMCEO_IOS_LOCK:-/tmp/iamceo-check-ios.lock} limit=${IAMCEO_IOS_LOCK_WAIT_S:-3600} waited=0 holder
  until mkdir "$dir" 2>/dev/null; do
    holder=$(cat "$dir/owner" 2>/dev/null || true)
    # 주인이 없는 잠금(강제 종료로 남은 것)은 치운다. 치우는 쪽은 한 번에 하나(.takeover)이고, 그 안에서 주인을 다시 본다.
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null && mkdir "$dir.takeover" 2>/dev/null; then
      if [ "$(cat "$dir/owner" 2>/dev/null || true)" = "$holder" ]; then
        rm -f "$dir/owner"; rmdir "$dir" 2>/dev/null || true
        printf 'iPhone tests: removed a lock left by an ended run (pid %s)\n' "$holder"
      fi
      rmdir "$dir.takeover" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$limit" ]; then
      report "FAILED: another iPhone test run on this Mac still holds $dir${holder:+ (pid $holder)} after ${limit}s"
      return 1
    fi
    if [ "$waited" -eq 0 ]; then printf 'iPhone tests: waiting for another run on this Mac to finish (%s%s)\n' "$dir" "${holder:+, pid $holder}"; fi
    sleep 2
    waited=$((waited + 2))
  done
  ios_lock=$dir
  printf '%s\n' "$$" > "$dir/owner"
}
# xcodebuild 를 뒤에서 돌리고 기다린다. 기다리는 중에 온 Ctrl-C·종료 신호를 바로 받아 cleanup 이 xcodebuild 를 멈추고 기기를 끈다.
ios_run() {
  local out=$1 code=0
  shift
  "$@" > "$out" 2>&1 &
  ios_child=$!
  wait "$ios_child" || code=$?
  ios_child=""
  return "$code"
}
# 이름 있는 실패의 까닭: 실패한 시험의 오류 줄(assert 문구와 file:line)과 충돌 알림. 전체 기록은 CHECK_ROOT 밖에 남긴다.
ios_failure_details() {
  local kept lines
  lines=$(grep -h -E ": error: |^Test Case '-\[.*\]' failed|encountered an error|crashed|Restarting after unexpected exit" "$@" 2>/dev/null | head -n 80 || true)
  if [ -n "$lines" ]; then printf '%s\n' "$lines"; fi
  if kept=$(mktemp "${CHECK_TMP%/}/iamceo-ios-test.XXXXXX"); then
    cat "$@" > "$kept" 2>/dev/null || true
    report "iPhone test log: $kept"
  fi
}
ios_check() {
  local devices="$CHECK_ROOT/simulators.json" picked udid state name log="$CHECK_ROOT/ios-test.log" status=0
  local project="$CHECK_ROOT/ios/native/IAMCEO.xcodeproj" derived="$CHECK_ROOT/dd-ios-test" failed skipped count retry="$CHECK_ROOT/ios-retry.log"
  # 신호를 받으면 exit 로 바꿔 EXIT 의 cleanup(xcodebuild 멈춤·켠 기기 끄기·잠금 풀기)을 돌린다. 이 단계에서만.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  ios_take_lock || { trap - INT TERM HUP; return 1; }
  xcrun simctl list devices available -j > "$devices"
  if ! picked=$(pick_simulator "$devices"); then
    ios_release; trap - INT TERM HUP
    if [ "${IAMCEO_IOS_OPTIONAL:-0}" = 1 ] && [ -z "${IAMCEO_IOS_SIMULATOR:-}" ]; then
      report "SKIPPED iPhone tests: no iPhone simulator on this Mac (Xcode → Settings → Components)"
      return 0
    fi
    report "FAILED: no iPhone simulator ${IAMCEO_IOS_SIMULATOR:+named $IAMCEO_IOS_SIMULATOR }on this Mac"
    return 1
  fi
  IFS=$'\t' read -r udid state name <<EOF_PICKED
$picked
EOF_PICKED
  printf 'iPhone simulator: %s, %s\n' "$name" "$state"
  # 시험은 #filePath 로 저장소의 다른 파일(shared/artifact-kit.ts)도 읽는다: 같은 배치로 복사한다.
  mkdir -p "$CHECK_ROOT/ios/native"
  cp -R native/Sources native/Configuration native/Resources native/Tests native/project.yml "$CHECK_ROOT/ios/native/"
  cp -R shared "$CHECK_ROOT/ios/shared"
  xcodegen generate --spec "$CHECK_ROOT/ios/native/project.yml" --project "$CHECK_ROOT/ios/native" --quiet
  local run=(xcodebuild -project "$project" -scheme IAMCEO-iOS-Tests -configuration Debug
    -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO)
  # 처음에 꺼져 있던 기기는 xcodebuild 가 켠다: 어떻게 끝나든 cleanup 이 끄도록 적어 둔다.
  if [ "$state" = Shutdown ]; then ios_booted=$udid; fi
  ios_run "$log" "${run[@]}" test || status=$?
  local pick="s/^Test Case '-\\[\\(IAMCEOTests\\.[A-Za-z0-9_]*\\) \\([A-Za-z0-9_]*\\)\\]' failed .*/\\1\\/\\2/p"
  failed=$(sed -n "$pick" "$log" | sort -u)
  skipped=$(sed -n "s/^Test Case '-\[\(.*\)\]' skipped .*/\1/p" "$log" | sort -u)
  if [ -n "$skipped" ]; then
    report "SKIPPED iPhone tests ($(printf '%s\n' "$skipped" | wc -l | tr -d ' ')):"
    report "$skipped"
  fi
  if [ "$status" -ne 0 ] && [ -n "$failed" ] && [ "${IAMCEO_TEST_RETRY:-1}" != 0 ]; then
    local filters=() again
    count=$(printf '%s\n' "$failed" | wc -l | tr -d ' ')
    while IFS= read -r name_; do filters+=("-only-testing:IAMCEOTests-iOS/${name_#IAMCEOTests.}"); done <<EOF_FAILED
$failed
EOF_FAILED
    printf '\n== re-run on the simulator: %s iPhone test(s)\n' "$count"
    local again_status=0
    ios_run "$retry" "${run[@]}" test-without-building "${filters[@]}" || again_status=$?
    again=$(sed -n "$pick" "$retry" | sort -u)
    if [ "$again_status" -eq 0 ] && [ -z "$again" ] && grep -Eq "Executed $count tests?, with 0 failures" "$retry"; then
      status=0
      report "iPhone tests: $count flaky"
      while IFS= read -r name_; do report "FLAKY: $name_ (failed once, passed on re-run)"; done <<EOF_FLAKY
$failed
EOF_FLAKY
    else
      failed=${again:-$failed}
    fi
  fi
  # 켠 기기를 끄고 잠금을 푼다(다음 실행이 기다리지 않게 결과 알림보다 먼저).
  ios_release
  trap - INT TERM HUP
  if [ "$status" -ne 0 ]; then
    if [ -n "$failed" ]; then
      report "FAILED iPhone tests:"; report "$failed"
      if [ -s "$retry" ]; then ios_failure_details "$log" "$retry"; else ios_failure_details "$log"; fi
    else report "FAILED: the iPhone test run did not finish (build error or crash); last lines:"; tail -n 40 "$log"; fi
    return "$status"
  fi
  report "iPhone tests: $(grep -Eo 'Executed [0-9]+ tests?, with [0-9]+ failures?' "$log" | tail -n 1) on $name"
}
mode=${1:-all}
if [ "$#" -gt 0 ]; then shift; fi
case "$mode" in
  all) ts; server; compat; swift_check; IAMCEO_IOS_OPTIONAL=1 ios_check; build ;;
  ts) ts ;;
  server) server "$@" ;;
  compat) compat ;;
  swift) swift_check ;;
  ios) ios_check ;;
  build) build ;;
  *) printf 'Usage: bash scripts/check.sh all|ts|server [files...]|compat|swift|ios|build\n' >&2; exit 2 ;;
esac
