#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_FILE="$PROJECT_ROOT/MediTest.csproj"
DIST_ROOT="$PROJECT_ROOT/dist"
BUNDLE_ID="com.automationturtle95.meditest"
ENTITLEMENTS="$PROJECT_ROOT/assets/macos.entitlements"
LAUNCHER_SOURCE="$SCRIPT_DIR/macos-launcher.m"
ICON_SOURCE="$PROJECT_ROOT/assets/MediTest.png"

log_step() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"
}

log_duration() {
  local label="$1"
  local started_at="$2"
  local finished_at
  local elapsed
  finished_at="$(date +%s)"
  elapsed=$((finished_at - started_at))
  log_step "$label beendet. Dauer: ${elapsed}s"
}

run_logged_phase() {
  local label="$1"
  local timeout_seconds="$2"
  shift 2
  local started_at
  local phase_pid
  local phase_status
  local elapsed
  local timed_out=0

  started_at="$(date +%s)"
  log_step "PHASE $label START"

  "$@" &
  phase_pid=$!
  log_step "PHASE $label PID $phase_pid"

  while kill -0 "$phase_pid" 2>/dev/null; do
    sleep 1
    if kill -0 "$phase_pid" 2>/dev/null; then
      elapsed=$(($(date +%s) - started_at))
      if (( elapsed > 0 && elapsed % 15 == 0 )); then
        log_step "PHASE $label LÄUFT seit ${elapsed}s (PID $phase_pid)"
      fi
      if (( timeout_seconds > 0 && elapsed >= timeout_seconds )); then
        log_step "PHASE $label TIMEOUT nach ${elapsed}s; Prozess $phase_pid wird beendet"
        pkill -TERM -P "$phase_pid" 2>/dev/null || true
        kill "$phase_pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          if ! kill -0 "$phase_pid" 2>/dev/null; then
            break
          fi
          sleep 1
        done
        if kill -0 "$phase_pid" 2>/dev/null; then
          pkill -KILL -P "$phase_pid" 2>/dev/null || true
          kill -KILL "$phase_pid" 2>/dev/null || true
        fi
        timed_out=1
        break
      fi
    fi
  done

  set +e
  wait "$phase_pid"
  phase_status=$?
  set -e

  if (( timed_out == 1 )); then
    phase_status=124
  fi

  log_step "PHASE $label ENDE: Exit-Code $phase_status"
  log_duration "$label" "$started_at"
  return "$phase_status"
}

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
if [[ -n "$SIGNING_KEYCHAIN" ]]; then
  CODESIGN_KEYCHAIN_ARGS=(--keychain "$SIGNING_KEYCHAIN")
fi

if [[ -z "$APP_SIGNING_IDENTITY" ]]; then
  echo "Developer-ID-Signatur fehlt. APPLE_DEVELOPER_ID_APPLICATION muss gesetzt sein." >&2
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
log_step "macOS-Release $VERSION gestartet. Ziel: $MAC_ROOT"
log_step "Artefaktformat: signierte und notarisierte DMGs; PKGs sind optional über BUILD_SIGNED_PKG=true."

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
  log_step "App-Icon wird erstellt: $output_file"
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
  log_step "App-Icon wurde erstellt: $output_file"
}

sign_app_bundle() {
  local app_bundle="$1"
  local app_host="$app_bundle/Contents/Resources/app/MediTest"
  local launcher="$app_bundle/Contents/MacOS/MediTest"

  log_step "Codesign startet für App-Bundle: $app_bundle"
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
  log_step "Codesign abgeschlossen; Signaturprüfung startet: $app_bundle"
  codesign --verify --deep --strict --verbose=2 "$app_bundle"
  log_step "codesign verify erfolgreich: $app_bundle"
}

build_macos_artifact() {
  local runtime="$1"
  local architecture="$2"
  local clang_arch="$3"
  local work_dir="$MAC_ROOT/work-$architecture"
  local publish_dir="$work_dir/publish"
  local app_bundle="$work_dir/Meduvalo.app"
  local dmg_root="$work_dir/dmg-root"
  local dmg_file="$MAC_ROOT/MediTest-Setup-$VERSION-macos-$architecture.dmg"
  local payload_root="$work_dir/payload-root"
  local package_file="$MAC_ROOT/MediTest-Setup-$VERSION-macos-$architecture.pkg"
  local unsigned_package_file="$work_dir/MediTest-Setup-$VERSION-macos-$architecture-unsigned.pkg"
  local diagnostic_package_file="$work_dir/MediTest-Setup-$VERSION-macos-$architecture-no-timestamp.pkg"

  rm -rf "$work_dir" "$dmg_file" "$package_file"
  mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources"

  log_step "dotnet publish startet für $architecture ($runtime)"
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
  log_step "dotnet publish abgeschlossen für $architecture"

  log_step "Release-Ausgabe wird für $architecture bereinigt"
  find "$publish_dir" -type f \( -name "*.pdb" -o -name "*.xml" -o -name "*.dbg" \) -delete
  rm -f "$publish_dir/start-name.json" "$publish_dir/meditest.db" \
    "$publish_dir/OPENAI_API_KEY.txt" "$publish_dir/GEMINI_API_KEY.txt" "$publish_dir/web.config"

  mv "$publish_dir" "$app_bundle/Contents/Resources/app"
  log_step "Nativer Launcher wird für $architecture erstellt"
  clang -arch "$clang_arch" -mmacosx-version-min=11.0 -O2 -fobjc-arc \
    -framework Cocoa -framework WebKit \
    "$LAUNCHER_SOURCE" -o "$app_bundle/Contents/MacOS/MediTest"
  chmod +x "$app_bundle/Contents/MacOS/MediTest" "$app_bundle/Contents/Resources/app/MediTest"
  write_info_plist "$app_bundle/Contents/Info.plist"
  create_app_icon "$app_bundle/Contents/Resources/MediTest.icns"

  sign_app_bundle "$app_bundle"

  log_step "DMG-Erstellung startet für $architecture: $dmg_file"
  mkdir -p "$dmg_root"
  ditto "$app_bundle" "$dmg_root/Meduvalo.app"
  ln -s /Applications "$dmg_root/Applications"
  du -sh "$dmg_root"
  run_logged_phase "hdiutil-create-$architecture" 180 hdiutil create \
    -volname "Meduvalo $VERSION" \
    -srcfolder "$dmg_root" \
    -ov \
    -format UDZO \
    "$dmg_file"
  ls -lh "$dmg_file"

  log_step "DMG-Signierung startet für $architecture"
  run_logged_phase "codesign-dmg-$architecture" 180 codesign \
    --force \
    --timestamp \
    "${CODESIGN_KEYCHAIN_ARGS[@]}" \
    --sign "$APP_SIGNING_IDENTITY" \
    "$dmg_file"
  codesign --verify --strict --verbose=2 "$dmg_file"
  log_step "DMG-Signaturprüfung erfolgreich für $architecture"

  if [[ "${BUILD_SIGNED_PKG:-false}" != "true" ]]; then
    log_step "Optionaler PKG-Build ist deaktiviert; BUILD_SIGNED_PKG=true aktiviert die Installer-Zertifikat-Diagnose."
    return
  fi
  if [[ -z "$INSTALLER_SIGNING_IDENTITY" ]]; then
    echo "BUILD_SIGNED_PKG=true erfordert APPLE_DEVELOPER_ID_INSTALLER." >&2
    exit 1
  fi

  log_step "pkgbuild Eingaben für $architecture:"
  log_step "APP_BUNDLE=$app_bundle"
  log_step "PACKAGE_FILE=$package_file"
  log_step "INSTALLER_IDENTITY=$INSTALLER_SIGNING_IDENTITY"
  ls -ld "$app_bundle"
  du -sh "$app_bundle"

  mkdir -p "$payload_root/Applications"
  ditto "$app_bundle" "$payload_root/Applications/Meduvalo.app"
  log_step "PKG_PAYLOAD_ROOT=$payload_root"
  du -sh "$payload_root"

  run_logged_phase "pkgbuild-root-$architecture" 180 pkgbuild \
    --root "$payload_root" \
    --install-location / \
    --ownership recommended \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    "$unsigned_package_file"
  ls -lh "$unsigned_package_file"

  log_step "Diagnose: productsign ohne Timestamp startet für $architecture"
  run_logged_phase "productsign-no-timestamp-$architecture" 60 productsign \
    --sign "$INSTALLER_SIGNING_IDENTITY" \
    --timestamp=none \
    "$unsigned_package_file" \
    "$diagnostic_package_file"
  pkgutil --check-signature "$diagnostic_package_file"
  rm -f "$diagnostic_package_file"
  log_step "Diagnose: productsign ohne Timestamp erfolgreich für $architecture"

  log_step "Release-Signatur mit vertrauenswürdigem Timestamp startet für $architecture"
  run_logged_phase "productsign-$architecture" 180 productsign \
    --sign "$INSTALLER_SIGNING_IDENTITY" \
    --timestamp \
    "$unsigned_package_file" \
    "$package_file"
  ls -lh "$package_file"
  rm -f "$unsigned_package_file"

  log_step "PKG-Signaturprüfung startet für $architecture"
  pkgutil --check-signature "$package_file"
  log_step "PKG-Signaturprüfung erfolgreich für $architecture"
}

notarize_artifacts() {
  local x64_artifact="$MAC_ROOT/MediTest-Setup-$VERSION-macos-x64.dmg"
  local arm64_artifact="$MAC_ROOT/MediTest-Setup-$VERSION-macos-arm64.dmg"
  local notary_staging="$MAC_ROOT/notary-staging"
  local notary_archive="$MAC_ROOT/MediTest-Setup-$VERSION-macos-notarization.zip"
  local notary_submission_file="$MAC_ROOT/notary-submission.json"
  local notary_result_file="$MAC_ROOT/notary-result.json"

  log_step "Zu notarisierende DMG-Dateien:"
  ls -lh "$x64_artifact" "$arm64_artifact"
  log_step "Gemeinsames Notarisierungsarchiv wird erstellt: $notary_archive"
  rm -rf "$notary_staging"
  rm -f "$notary_archive"
  mkdir -p "$notary_staging"
  cp "$x64_artifact" "$arm64_artifact" "$notary_staging/"
  ditto -c -k --keepParent "$notary_staging" "$notary_archive"
  ls -lh "$notary_archive"

  log_step "Live-Ausgabe von notarytool folgt:"

  submit_notarization() {
    xcrun notarytool submit "$notary_archive" \
      --key "$NOTARY_KEY_FILE" \
      --key-id "$NOTARY_KEY_ID" \
      --issuer "$NOTARY_ISSUER_ID" \
      --wait \
      --timeout 45m \
      --output-format json | tee "$notary_submission_file"
  }

  local submit_status
  if run_logged_phase "notarytool-submit-wait" 3000 submit_notarization; then
    submit_status=0
  else
    submit_status=$?
  fi

  local submission_id
  submission_id="$(plutil -extract id raw -o - "$notary_submission_file" 2>/dev/null || true)"
  if [[ -z "$submission_id" ]]; then
    cat "$notary_submission_file" >&2
    echo "Apple-Notarisierung lieferte keine Submission-ID." >&2
    exit 1
  fi

  local notary_status
  notary_status="$(plutil -extract status raw -o - "$notary_submission_file" 2>/dev/null || true)"
  if [[ "$notary_status" == "Invalid" || "$notary_status" == "Rejected" ]]; then
    xcrun notarytool log "$submission_id" \
      --key "$NOTARY_KEY_FILE" \
      --key-id "$NOTARY_KEY_ID" \
      --issuer "$NOTARY_ISSUER_ID" || true
    echo "Apple-Notarisierung wurde mit Status '$notary_status' beendet." >&2
    exit 1
  fi

  if [[ "$notary_status" == "Accepted" ]]; then
    cp "$notary_submission_file" "$notary_result_file"
  else
    log_step "Apple verarbeitet beide DMGs weiter; Submission-ID-Polling startet: $submission_id"
    local poll_attempt
    for poll_attempt in $(seq 1 390); do
      xcrun notarytool info "$submission_id" \
        --key "$NOTARY_KEY_FILE" \
        --key-id "$NOTARY_KEY_ID" \
        --issuer "$NOTARY_ISSUER_ID" \
        --output-format json > "$notary_result_file"
      notary_status="$(plutil -extract status raw -o - "$notary_result_file")"
      log_step "Notarisierung beider DMGs ($submission_id): Status $notary_status (Prüfung $poll_attempt/390)"

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
  fi

  if [[ "$notary_status" != "Accepted" ]]; then
    echo "Apple-Notarisierung ist nach 240 Minuten noch nicht abgeschlossen. Submission-ID: $submission_id" >&2
    exit 1
  fi

  cat "$notary_result_file"
  log_step "Apple-Notarisierung für beide DMGs akzeptiert; Stapling startet"
  for artifact_file in "$x64_artifact" "$arm64_artifact"; do
    run_logged_phase "stapler-staple-$(basename "$artifact_file")" 180 \
      xcrun stapler staple "$artifact_file"
    run_logged_phase "stapler-validate-$(basename "$artifact_file")" 180 \
      xcrun stapler validate "$artifact_file"

    log_step "Gatekeeper-Prüfung startet: $artifact_file"
    spctl --assess --type open --context context:primary-signature --verbose=4 "$artifact_file"
    log_step "Gatekeeper-Prüfung erfolgreich: $artifact_file"
  done

  rm -rf "$notary_staging"
  rm -f "$notary_archive" "$notary_submission_file" "$notary_result_file"
  rm -rf "$MAC_ROOT/work-x64" "$MAC_ROOT/work-arm64"
  log_step "Notarisierung und Bereinigung für beide DMGs abgeschlossen"
}

log_step "Build und Signierung für Intel x64 startet"
build_macos_artifact "osx-x64" "x64" "x86_64"
log_step "Build und Signierung für Apple Silicon ARM64 startet"
build_macos_artifact "osx-arm64" "arm64" "arm64"

log_step "Gemeinsame Apple-Notarisierung für x64 und ARM64 startet"
notarize_artifacts

log_step "Signierte und notarisierte macOS-Disk-Images sind fertig:"
ls -lh "$MAC_ROOT"/*.dmg
