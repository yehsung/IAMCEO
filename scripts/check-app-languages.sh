#!/usr/bin/env bash
# 빌드된 앱 번들의 언어 폴더 검사(4차 lang-6). Usage: bash scripts/check-app-languages.sh <IAMCEO.app>...
# 앱의 대체 언어(CFBundleDevelopmentRegion)는 en 이다. 문구 파일이 ko.lproj 에 없으면 한국어 기기도 그 파일만은 en.lproj 에서
# 읽는다(파일 단위로 대체). 그래서 en.lproj 의 파일은 모두 ko.lproj 에도 있어야 한다. 없으면 한국어 기기에서 그 파일의 문구
# (복수형 Localizable.stringsdict, 권한 안내 InfoPlist.strings 등)만 영어로 나온다. Mac 번들(Contents/Resources)과 iPhone 번들(맨 위)을 다 본다.
set -euo pipefail
if [ "$#" -eq 0 ]; then printf 'Usage: bash scripts/check-app-languages.sh <IAMCEO.app>...\n' >&2; exit 2; fi
status=0
for app in "$@"; do
  resources="$app/Contents/Resources"
  [ -d "$resources" ] || resources="$app"
  if [ ! -d "$resources/en.lproj" ] || [ ! -d "$resources/ko.lproj" ]; then
    printf 'FAILED: %s has no en.lproj or ko.lproj\n' "$app"; status=1; continue
  fi
  count=0
  for file in "$resources/en.lproj"/*; do
    [ -e "$file" ] || continue
    name=$(basename "$file")
    count=$((count + 1))
    if [ ! -e "$resources/ko.lproj/$name" ]; then
      printf 'FAILED: %s: ko.lproj/%s is missing; Korean devices would read the English %s\n' "$app" "$name" "$name"; status=1
    fi
  done
  if [ "$count" -eq 0 ]; then printf 'FAILED: %s: en.lproj is empty\n' "$app"; status=1; fi
done
if [ "$status" -eq 0 ]; then printf 'app languages: every en.lproj file is also in ko.lproj (%s app(s))\n' "$#"; fi
exit "$status"
