#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/apps/web/android"
API_DIR="$PROJECT_ROOT/apps/api"
GRADLE_FILE="$ANDROID_DIR/app/build.gradle"
SDK_PATH="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

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

LOCAL_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$LOCAL_IP" ]]; then
  echo "Connect this Mac to the Wi-Fi used by the phone, then run the update build again." >&2
  exit 1
fi

read -r NEXT_CODE NEXT_NAME < <(python3 - "$GRADLE_FILE" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); s=p.read_text()
code=re.search(r'versionCode\s+(\d+)',s)
name=re.search(r'versionName\s+"([^"]+)"',s)
if not code or not name: raise SystemExit('Could not read Android version from build.gradle')
next_code=int(code.group(1))+1
next_name=f'1.0.{next_code}'
s=re.sub(r'versionCode\s+\d+',f'versionCode {next_code}',s,count=1)
s=re.sub(r'versionName\s+"[^"]+"',f'versionName "{next_name}"',s,count=1)
p.write_text(s)
print(next_code,next_name)
PY
)

export JAVA_HOME
export ANDROID_HOME="$SDK_PATH"
export ANDROID_SDK_ROOT="$SDK_PATH"
export PATH="$JAVA_HOME/bin:$PATH"
export VITE_API_URL="http://$LOCAL_IP:4000/api"

cd "$PROJECT_ROOT"
npm --workspace apps/api run build
npm --workspace apps/web run build
(cd "$PROJECT_ROOT/apps/web" && npx cap sync android)
(cd "$ANDROID_DIR" && ./gradlew clean assembleDebug --no-daemon)

UPDATE_DIR="$API_DIR/data/updates"
mkdir -p "$UPDATE_DIR"
APK_SOURCE="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
cp "$APK_SOURCE" "$UPDATE_DIR/latest.apk"
SHA256="$(shasum -a 256 "$UPDATE_DIR/latest.apk" | awk '{print $1}')"
python3 - "$UPDATE_DIR/latest.json" "$NEXT_CODE" "$NEXT_NAME" "$SHA256" <<'PY'
import json,sys,datetime
path,code,name,digest=sys.argv[1:]
with open(path,'w') as f:
 json.dump({'versionCode':int(code),'versionName':name,'sha256':digest,'publishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},f,indent=2)
 f.write('\n')
PY

echo "its you v$NEXT_NAME is ready and published to the laptop update server."
