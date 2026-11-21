#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/apps/web/android"
API_DIR="$PROJECT_ROOT/apps/api"
GRADLE_FILE="$ANDROID_DIR/app/build.gradle"
SDK_PATH="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUMP_VERSION="${BUMP_VERSION:-0}"

if [[ "${1:-}" == "--bump" ]]; then
  BUMP_VERSION=1
fi

if [[ ! -d "$SDK_PATH/platforms" ]]; then
  echo "Android SDK not found at $SDK_PATH" >&2
  exit 1
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  for JDK_HOME_CANDIDATE in "$HOME"/.gradle/jdks/*/*/Contents/Home; do
    if [[ -x "$JDK_HOME_CANDIDATE/bin/java" ]]; then
      JAVA_HOME="$JDK_HOME_CANDIDATE"
      break
    fi
  done
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "Java 17 is required to build the Android update." >&2
  exit 1
fi

read -r VERSION_CODE VERSION_NAME < <(python3 - "$GRADLE_FILE" "$BUMP_VERSION" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); s=p.read_text(); bump=sys.argv[2]=='1'
code_match=re.search(r'versionCode\s+(\d+)',s)
name_match=re.search(r'versionName\s+"([^"]+)"',s)
if not code_match or not name_match: raise SystemExit('Could not read Android version from build.gradle')
code=int(code_match.group(1)); name=name_match.group(1)
if bump:
 code+=1
 parts=re.match(r'^(\d+)\.(\d+)\.(\d+)$',name)
 name=f'{parts.group(1)}.{parts.group(2)}.{int(parts.group(3))+1}' if parts else f'1.0.{code}'
 s=re.sub(r'versionCode\s+\d+',f'versionCode {code}',s,count=1)
 s=re.sub(r'versionName\s+"[^"]+"',f'versionName "{name}"',s,count=1)
 p.write_text(s)
print(code,name)
PY
)

if [[ "$BUMP_VERSION" != "1" ]]; then
  echo "Building v$VERSION_NAME without a version bump. Pass --bump when publishing a new release."
fi

API_URL="${VITE_API_URL:-https://book-for-aslin.onrender.com/api}"
export JAVA_HOME
export ANDROID_HOME="$SDK_PATH"
export ANDROID_SDK_ROOT="$SDK_PATH"
export PATH="$JAVA_HOME/bin:$PATH"
export VITE_API_URL="$API_URL"

cd "$PROJECT_ROOT"
npm --workspace apps/api run build
npm --workspace apps/web run build
(cd "$PROJECT_ROOT/apps/web" && npx cap sync android)
(cd "$ANDROID_DIR" && ./gradlew clean assembleDebug --no-daemon)

APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APK_OUTPUT="$PROJECT_ROOT/ForYouBooks-release-test.apk"
cp "$APK_SOURCE" "$APK_OUTPUT"
SHA256="$(shasum -a 256 "$APK_OUTPUT" | awk '{print $1}')"

if [[ "$BUMP_VERSION" == "1" ]]; then
  python3 - "$API_DIR/data/updates/latest.json" "$VERSION_CODE" "$VERSION_NAME" "$SHA256" <<'PY'
import datetime,json,sys
path,code,name,digest=sys.argv[1:]
try:
 with open(path) as f: previous=json.load(f)
except Exception: previous={}
record={'versionCode':int(code),'versionName':name,'sha256':digest,'publishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mandatory':bool(previous.get('mandatory',False))}
with open(path,'w') as f:
 json.dump(record,f,indent=2)
 f.write('\n')
PY
  echo "its you v$VERSION_NAME is ready at $APK_OUTPUT."
  echo "Upload that APK to the URL set in APP_UPDATE_APK_URL, then confirm /api/app/update reports v$VERSION_NAME."
else
  echo "its you v$VERSION_NAME is ready at $APK_OUTPUT. Update metadata was not changed."
fi
