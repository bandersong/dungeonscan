#!/bin/zsh
# =============================================================================
# build_devid.sh — Developer-ID (direct-download) build of DungeonScan.
#
# Full signed + notarized + stapled pipeline -> ../dist/:
#   xcodegen generate
#     -> xcodebuild archive (Release, real Developer-ID signing, Hardened
#        Runtime, DungeonScan.entitlements.devid)
#     -> xcodebuild -exportArchive  (signed .app)
#     -> verify (codesign --verify --deep --strict + spctl)
#     -> package DMG (drag-to-Applications) + zip  into ../dist/
#     -> xcrun notarytool submit --wait   (keychain profile mapsmith-notary)
#     -> xcrun stapler staple             (staples the DMG)
#     -> print the Gatekeeper verdict
#
#   ./build_devid.sh          full pipeline -> signed+notarized DMG + zip
#   ./build_devid.sh --app    stop after the signed .app (skip pkg/notarize)
#
# >>> RUN THIS IN THE MAC'S GUI Terminal.app. <<<
# The Developer ID signing identity lives in Jesus's LOGIN keychain, which only
# an interactive / GUI session can unlock on demand. Over non-GUI ssh the
# keychain stays locked, and BOTH codesign (signing) and notarytool (the
# `mapsmith-notary` keychain profile) will fail. The script warns if it detects
# an ssh session, but does not hard-abort — just open Terminal on the Mac.
#
# One-time founder setup (ALREADY DONE on this Mac — recorded for reference):
#   notary keychain profile : `mapsmith-notary`
#                              (xcrun notarytool store-credentials "mapsmith-notary"
#                               --apple-id <APPLE_ID> --team-id 2Y394P797H
#                               --password <APP_SPECIFIC_PW>)
#   Developer ID identity   : "Developer ID Application: Jesus Triana (2Y394P797H)"
#   Team                    : 2Y394P797H
#
# Modeled on ScrubBuddy's build_swift_dmg.sh, but DungeonScan has NO nested
# frameworks/dylibs (no MLX, no SwiftPM), so xcodebuild archive signs the whole
# .app in one pass — there is no inside-out codesign loop to run.
# =============================================================================
set -eu
cd "$(dirname "$0")"

# ---- config (override via env only if a different identity/profile is needed) -
SCHEME="DungeonScan"
TEAM_ID="2Y394P797H"
SIGN_ID="${DUNGEONSCAN_SIGN_ID:-Developer ID Application: Jesus Triana (2Y394P797H)}"
NOTARY_PROFILE="${DUNGEONSCAN_NOTARY_PROFILE:-mapsmith-notary}"
DEVID_ENTS="DungeonScan.entitlements.devid"   # Hardened Runtime only; no sandbox

DD="build"
ARCHIVE="$DD/DungeonScan.xcarchive"
EXPORT_DIR="$DD/export"
APP="$EXPORT_DIR/DungeonScan.app"
DIST="../dist"                                # ~/DungeonScan/dist
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :MARKETING_VERSION' DungeonScan/Info.plist 2>/dev/null || echo 0.1.0)"

APP_ONLY=0
for a in "$@"; do [[ "$a" == "--app" ]] && APP_ONLY=1; done

# ---- GUI-Terminal preflight -------------------------------------------------
if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]]; then
  echo "⚠️  ssh session detected. The login keychain is locked over non-GUI ssh —"
  echo "    codesign + notarytool will likely fail. Run this from Terminal.app on the Mac."
fi

echo "==> [1/6] xcodegen generate…"
xcodegen generate

# Developer-ID export options. method=developer-id needs ONLY the Developer ID
# cert — NO provisioning profile for direct (non-store) distribution.
mkdir -p "$DD"
cat > "$DD/ExportOptions.devid.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>developer-id</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
</dict>
</plist>
EOF

echo "==> [2/6] xcodebuild archive (Release, Developer-ID signing, Hardened Runtime)…"
xcodebuild archive \
  -project DungeonScan.xcodeproj -scheme "$SCHEME" -configuration Release \
  -derivedDataPath "$DD" -archivePath "$ARCHIVE" \
  CODE_SIGN_IDENTITY="$SIGN_ID" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_ENTITLEMENTS="$DEVID_ENTS" \
  ENABLE_HARDENED_RUNTIME=YES \
  > "$DD/archive.log" 2>&1 \
  || { echo "ARCHIVE FAILED — see $DD/archive.log" >&2; tail -25 "$DD/archive.log" >&2; exit 1; }

echo "==> [3/6] exportArchive -> signed .app…"
rm -rf "$EXPORT_DIR"; mkdir -p "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$DD/ExportOptions.devid.plist" \
  -exportPath "$EXPORT_DIR" \
  > "$DD/export.log" 2>&1 \
  || { echo "EXPORT FAILED — see $DD/export.log" >&2; tail -25 "$DD/export.log" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "no .app at $APP" >&2; exit 1; }
echo "    exported: $APP ($(du -sh "$APP" | cut -f1))"

echo "==> [4/6] verify (codesign --deep --strict + spctl)…"
# Signature integrity passes pre-notarization; spctl assess only passes AFTER
# notarization (step 6), so its pre-notarize result is shown tolerantly.
codesign --verify --deep --strict --verbose=2 "$APP" && echo "    ✓ codesign --verify passed"
codesign -dvvv "$APP" 2>&1 | grep -E 'Authority=|TeamIdentifier=|flags=|Timestamp=' | sed 's/^/    /' || true
spctl --assess --type execute --verbose=4 "$APP" 2>&1 | sed 's/^/    /' || true
echo "    (pre-notarization spctl is expected to reject; it passes after step 6.)"

[[ $APP_ONLY == 1 ]] && { echo "done (signed .app only): $APP"; exit 0; }

# ---- package DMG (drag-to-Applications) + zip -------------------------------
echo "==> [5/6] package DMG + zip into $DIST/…"
mkdir -p "$DIST"
DMG="$DIST/DungeonScan-${VERSION}.dmg"
ZIP="$DIST/DungeonScan-${VERSION}.zip"
STAGE="$DIST/dmg-stage"

# DMG: .app + /Applications symlink (drag-to-install), UDZO compressed.
VOL="DungeonScan"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"

# Professional styled DMG: an icon-view window with the app on the left and an
# Applications folder on the right to drag onto. Needs Finder (a GUI session);
# the first run may show a one-time "Terminal wants to control Finder" prompt —
# click OK. Falls back to a plain (still drag-to-Applications) DMG if styling
# can't run. Guarded command-by-command so `set -e` can't abort the release.
make_styled_dmg() {
  local rw="$DIST/rw.dmg" dev=""
  rm -f "$rw"
  hdiutil create -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$rw" >/dev/null || return 1
  dev=$(hdiutil attach -readwrite -noverify -noautoopen "$rw" 2>/dev/null | egrep '^/dev/' | head -1 | awk '{print $1}')
  [[ -n "$dev" ]] || { rm -f "$rw"; return 1; }
  sleep 1
  osascript >/dev/null 2>&1 <<OSA || true
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 140, 720, 470}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 104
    try
      set position of item "DungeonScan.app" of container window to {140, 160}
      set position of item "Applications" of container window to {380, 160}
    end try
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
  sync; sleep 1
  hdiutil detach "$dev" >/dev/null 2>&1 || { sleep 2; hdiutil detach "$dev" -force >/dev/null 2>&1; }
  hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG" >/dev/null || { rm -f "$rw"; return 1; }
  rm -f "$rw"
  [[ -f "$DMG" ]]
}

if make_styled_dmg; then
  echo "    DMG (styled): $DMG ($(du -sh "$DMG" | cut -f1))"
else
  echo "    (styled DMG unavailable — building a plain drag-to-Applications DMG)"
  rm -f "$DMG"
  hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  echo "    DMG (plain): $DMG ($(du -sh "$DMG" | cut -f1))"
fi

# ZIP: ditto preserves bundle layout + extended attrs. NEVER use zip(1) — it
# strips resource forks and breaks the code signature.
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "    ZIP: $ZIP ($(du -sh "$ZIP" | cut -f1))"

# ---- notarize (zip) + staple (dmg) ------------------------------------------
echo "==> [6/6] notarize (zip) + staple (dmg) via keychain profile '$NOTARY_PROFILE'…"
echo "    submitting $DMG to Apple (uploads; a few minutes)…"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
echo "    stapling the DMG…"
xcrun stapler staple "$DMG" && echo "    ✓ DMG stapled"

# The notarization ticket is keyed to the signed .app, so it covers BOTH the
# DMG (stapled below — offline-clean) and the ZIP (online ticket check). zips
# cannot be stapled; the DMG is the canonical primary download.
rm -rf "$STAGE"

# ---- Gatekeeper verdict ------------------------------------------------------
echo ""
echo "================ GATEKEEPER VERDICT ================"
echo "-- .app:"
spctl -a -vvvv "$APP" 2>&1 | sed 's/^/   /' || true
echo "-- DMG:"
spctl -a -vvvv "$DMG" 2>&1 | sed 's/^/   /' || true
echo "-- staple (DMG):"
xcrun stapler validate "$DMG" 2>&1 | sed 's/^/   /' || true
echo "   ZIP ($ZIP): notarized via online ticket (zips are not stapleable)."
echo "===================================================="
echo "DONE. Ship $DMG (stapled) as the primary download; $ZIP as a fallback."
