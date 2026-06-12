#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_FILE="$PROJECT_ROOT/MediTest.csproj"
DIST_ROOT="$PROJECT_ROOT/dist"
BUNDLE_ID="com.automationturtle95.meditest"
ENTITLEMENTS="$PROJECT_ROOT/assets/macos.entitlements"
LAUNCHER_SOURCE="$SCRIPT_DIR/macos-launcher.c"
ICON_SOURCE="$PROJECT_ROOT/assets/MediTest.png"

VERSION="${VERSION:-$(sed -n 's:.*<Version>\([^<]*\)</Version>.*:\1:p' "$PROJECT_FILE" | head -n 1)}"
if [[ -z "$VERSION" ]]; then
  echo "Keine <Version> in $PROJECT_FILE gefunden." >&2
  exit 1
fi

APP_SIGNING_IDENTITY="${APPLE_DEVELOPER_ID_APPLICATION:-}"
INSTALLER_SIGNING_IDENTITY="${APPLE_DEVELOPER_ID_INSTALLER:-}"
NOTARY_KEY_ID="${APPLE_API_KEY_ID:-}"
NOTARY_ISSUER_ID="${APPLE_API_ISSUER_ID:-}"
NOTARY_KEY_FILE="${APPLE_API_KEY_FILE:-}"
SIGNING_KEYCHAIN="${APPLE_SIGNING_KEYCHAIN:-}"

CODESIGN_KEYCHAIN_ARGS=()
PKGBUILD_KEYCHAIN_ARGS=()
if [[ -n "$SIGNING_KEYCHAIN" ]]; then
  CODESIGN_KEYCHAIN_ARGS=(--keychain "$SIGNING_KEYCHAIN")
  PKGBUILD_KEYCHAIN_ARGS=(--keychain "$SIGNING_KEYCHAIN")
fi

if [[ -z "$APP_SIGNING_IDENTITY" || -z "$INSTALLER_SIGNING_IDENTITY" ]]; then
  echo "Developer-ID-Signatur fehlt. APPLE_DEVELOPER_ID_APPLICATION und APPLE_DEVELOPER_ID_INSTALLER muessen gesetzt sein." >&2
  exit 1
fi
if [[ -z "$NOTARY_KEY_ID" || -z "$NOTARY_ISSUER_ID" || -z "$NOTARY_KEY_FILE" || ! -f "$NOTARY_KEY_FILE" ]]; then
  echo "Notarisierungsdaten fehlen. APPLE_API_KEY_ID, APPLE_API_ISSUER_ID und APPLE_API_KEY_FILE muessen gesetzt sein." >&2
  exit 1
fi

RELEASE_ROOT="$DIST_ROOT/MediTest-$VERSION"
MAC_ROOT="$RELEASE_ROOT/macos"
rm -rf "$MAC_ROOT"
mkdir -p "$MAC_ROOT"

write_info_plist() {
  local output_file="$1"
  cat > "$output_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>de</string>
  <key>CFBundleDisplayName</key>
  <string>Meduvalo</string>
  <key>CFBundleExecutable</key>
  <string>MediTest</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key>
  <string>MediTest</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Meduvalo</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.education</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
}

create_app_icon() {
  local output_file="$1"
  local iconset_dir
  iconset_dir="$(dirname "$output_file")/MediTest.iconset"
  rm -rf "$iconset_dir"
  mkdir -p "$iconset_dir"

  sips -z 16 16 "$ICON_SOURCE" --out "$iconset_dir/icon_16x16.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$iconset_dir/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$ICON_SOURCE" --out "$iconset_dir/icon_32x32.png" >/dev/null
  sips -z 64 64 "$ICON_SOURCE" --out "$iconset_dir/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$ICON_SOURCE" --out "$iconset_dir/icon_128x128.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$ICON_SOURCE" --out "$iconset_dir/icon_256x256.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$ICON_SOURCE" --out "$iconset_dir/icon_512x512.png" >/dev/null
  sips -z 1024 1024 "$ICON_SOURCE" --out "$iconset_dir/icon_512x512@2x.png" >/dev/null
  iconutil -c icns "$iconset_dir" -o "$output_file"
  rm -rf "$iconset_dir"
}

sign_app_bundle() {
  local app_bundle="$1"
  local app_host="$app_bundle/Contents/Resources/app/MediTest"
  local launcher="$app_bundle/Contents/MacOS/MediTest"

  while IFS= read -r -d '' file_path; do
    if file "$file_path" | grep -q "Mach-O"; then
      if [[ "$file_path" == "$app_host" ]]; then
        continue
      fi
      codesign --force --timestamp --options runtime "${CODESIGN_KEYCHAIN_ARGS[@]}" \
        --sign "$APP_SIGNING_IDENTITY" "$file_path"
    fi
  done < <(find "$app_bundle/Contents/Resources/app" -type f -print0)

  codesign --force --timestamp --options runtime "${CODESIGN_KEYCHAIN_ARGS[@]}" --entitlements "$ENTITLEMENTS" \
    --sign "$APP_SIGNING_IDENTITY" "$app_host"
  codesign --force --timestamp --options runtime "${CODESIGN_KEYCHAIN_ARGS[@]}" \
    --sign "$APP_SIGNING_IDENTITY" "$launcher"
  codesign --force --timestamp --options runtime "${CODESIGN_KEYCHAIN_ARGS[@]}" \
    --sign "$APP_SIGNING_IDENTITY" "$app_bundle"
  codesign --verify --deep --strict --verbose=2 "$app_bundle"
}

build_package() {
  local runtime="$1"
  local architecture="$2"
  local clang_arch="$3"
  local work_dir="$MAC_ROOT/work-$architecture"
  local publish_dir="$work_dir/publish"
  local app_bundle="$work_dir/Meduvalo.app"
  local package_file="$MAC_ROOT/MediTest-Setup-$VERSION-macos-$architecture.pkg"

  rm -rf "$work_dir" "$package_file"
  mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources"

  dotnet publish "$PROJECT_FILE" \
    --configuration Release \
    --runtime "$runtime" \
    --self-contained true \
    --output "$publish_dir" \
    -p:Version="$VERSION" \
    -p:AssemblyVersion="$VERSION.0" \
    -p:FileVersion="$VERSION.0" \
    -p:InformationalVersion="$VERSION" \
    -p:DebugType=none \
    -p:DebugSymbols=false \
    -p:PublishReadyToRun=false

  find "$publish_dir" -type f \( -name "*.pdb" -o -name "*.xml" -o -name "*.dbg" \) -delete
  rm -f "$publish_dir/start-name.json" "$publish_dir/meditest.db" \
    "$publish_dir/OPENAI_API_KEY.txt" "$publish_dir/GEMINI_API_KEY.txt" "$publish_dir/web.config"

  mv "$publish_dir" "$app_bundle/Contents/Resources/app"
  clang -arch "$clang_arch" -mmacosx-version-min=11.0 -O2 \
    "$LAUNCHER_SOURCE" -o "$app_bundle/Contents/MacOS/MediTest"
  chmod +x "$app_bundle/Contents/MacOS/MediTest" "$app_bundle/Contents/Resources/app/MediTest"
  write_info_plist "$app_bundle/Contents/Info.plist"
  create_app_icon "$app_bundle/Contents/Resources/MediTest.icns"

  sign_app_bundle "$app_bundle"

  pkgbuild \
    "${PKGBUILD_KEYCHAIN_ARGS[@]}" \
    --sign "$INSTALLER_SIGNING_IDENTITY" \
    --timestamp \
    --component "$app_bundle" \
    --install-location /Applications \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    "$package_file"

  pkgutil --check-signature "$package_file"
}

notarize_package() {
  local architecture="$1"
  local package_file="$MAC_ROOT/MediTest-Setup-$VERSION-macos-$architecture.pkg"
  local work_dir="$MAC_ROOT/work-$architecture"
  local notary_submission_file="$work_dir/notary-submission.json"
  local notary_result_file="$work_dir/notary-result.json"

  if ! xcrun notarytool submit "$package_file" \
    --key "$NOTARY_KEY_FILE" \
    --key-id "$NOTARY_KEY_ID" \
    --issuer "$NOTARY_ISSUER_ID" \
    --output-format json > "$notary_submission_file"; then
    cat "$notary_submission_file" >&2
    exit 1
  fi

  printf 'Notarisierung %s eingereicht:\n' "$architecture"
  cat "$notary_submission_file"
  local submission_id
  submission_id="$(plutil -extract id raw -o - "$notary_submission_file")"
  if [[ -z "$submission_id" ]]; then
    echo "Apple-Notarisierung lieferte keine Submission-ID." >&2
    exit 1
  fi

  local notary_status=""
  local poll_attempt
  for poll_attempt in $(seq 1 240); do
    xcrun notarytool info "$submission_id" \
      --key "$NOTARY_KEY_FILE" \
      --key-id "$NOTARY_KEY_ID" \
      --issuer "$NOTARY_ISSUER_ID" \
      --output-format json > "$notary_result_file"
    notary_status="$(plutil -extract status raw -o - "$notary_result_file")"
    printf 'Notarisierung %s (%s): Status %s (Pruefung %s/240)\n' \
      "$architecture" "$submission_id" "$notary_status" "$poll_attempt"

    if [[ "$notary_status" == "Accepted" ]]; then
      break
    fi
    if [[ "$notary_status" == "Invalid" || "$notary_status" == "Rejected" ]]; then
      xcrun notarytool log "$submission_id" \
        --key "$NOTARY_KEY_FILE" \
        --key-id "$NOTARY_KEY_ID" \
        --issuer "$NOTARY_ISSUER_ID" || true
      echo "Apple-Notarisierung wurde mit Status '$notary_status' beendet." >&2
      exit 1
    fi
    sleep 30
  done

  if [[ "$notary_status" != "Accepted" ]]; then
    echo "Apple-Notarisierung ist nach 120 Minuten noch nicht abgeschlossen. Submission-ID: $submission_id" >&2
    exit 1
  fi

  cat "$notary_result_file"
  xcrun stapler staple "$package_file"
  xcrun stapler validate "$package_file"
  spctl --assess --type install --verbose=4 "$package_file"

  rm -rf "$work_dir"
}

build_package "osx-x64" "x64" "x86_64"
build_package "osx-arm64" "arm64" "arm64"

notarize_package "x64" &
x64_notary_pid=$!
notarize_package "arm64" &
arm64_notary_pid=$!

x64_notary_status=0
arm64_notary_status=0
wait "$x64_notary_pid" || x64_notary_status=$?
wait "$arm64_notary_pid" || arm64_notary_status=$?

if (( x64_notary_status != 0 || arm64_notary_status != 0 )); then
  echo "Mindestens eine Apple-Notarisierung ist fehlgeschlagen." >&2
  exit 1
fi

echo "Signierte und notarisierte macOS-Pakete:"
ls -lh "$MAC_ROOT"/*.pkg
