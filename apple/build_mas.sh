#!/bin/zsh
# =============================================================================
# build_mas.sh — Mac App Store build of DungeonScan (App Sandbox mandatory).
#
# Produces a store-uploadable .pkg in ../dist/:
#   xcodegen generate
#     -> install the MAS provisioning profile (read UUID -> ~/Library/MobileDevice)
#     -> xcodebuild archive (Release; "3rd Party Mac Developer Application"
#        signing + DungeonScan.entitlements.mas + Hardened Runtime + the MAS
#        provisioning profile)
#     -> xcodebuild -exportArchive  (method=mac-application -> signed sandboxed .app)
#     -> productbuild --sign "3rd Party Mac Developer Installer"  -> store .pkg
#     -> print next steps (validate + upload via altool / Transporter)
#
#   ./build_mas.sh          full pipeline -> store .pkg in ../dist/
#   ./build_mas.sh --app    stop after the signed sandboxed .app (skip the .pkg)
#
# >>> RUN THIS IN THE MAC'S GUI Terminal.app. <<< (same keychain reason as
# build_devid.sh — the Apple Distribution cert lives in the login keychain.)
#
# CERTS (create ONCE in the Apple Developer portal — Certificates, Identifiers
# & Profiles — then they land in this Mac's keychain):
#   app signing      : "3rd Party Mac Developer Application: Jesus Triana (2Y394P797H)"
#                      On accounts created/refreshed since 2019 the SAME role is
#                      issued as "Apple Distribution: Jesus Triana (2Y394P797H)".
#                      Use whichever name is in your keychain; override below:
#                        export DS_MAS_APP_CERT="Apple Distribution: Jesus Triana (2Y394P797H)"
#   installer signing: "3rd Party Mac Developer Installer: Jesus Triana (2Y394P797H)"
#   team             : 2Y394P797H
#
# PROVISIONING PROFILE — Jesus must create this in the portal (or let Xcode):
#   - App ID: io.github.bandersong.dungeonscan (macOS, explicit).
#   - A "Mac App Store" provisioning profile for that App ID.
#   - Download it and drop it at:
#       ~/DungeonScan/apple/DungeonScan_MAS.provisionprofile
#     The script reads its UUID and installs the copy Xcode expects at
#     ~/Library/MobileDevice/Provisioning Profiles/<UUID>.provisionprofile.
#
# NO notarization step here — App Review replaces notarization for the store.
# NO MLX (so DungeonScan.entitlements.mas drops allow-unsigned-executable-memory):
# a tighter sandbox than ScrubBuddy's MAS build could ship.
# =============================================================================
set -eu
cd "$(dirname "$0")"

# ---- config -----------------------------------------------------------------
SCHEME="DungeonScan"
TEAM_ID="2Y394P797H"
BUNDLE_ID="io.github.bandersong.dungeonscan"
APP_CERT="${DS_MAS_APP_CERT:-3rd Party Mac Developer Application: Jesus Triana (2Y394P797H)}"
PKG_CERT="${DS_MAS_PKG_CERT:-3rd Party Mac Developer Installer: Jesus Triana (2Y394P797H)}"
PROFILE="${DS_MAS_PROFILE:-DungeonScan_MAS.provisionprofile}"
MAS_ENTS="DungeonScan.entitlements.mas"          # app-sandbox + network.client +
                                                  # user-selected.read-write + bookmarks.app-scope

DD="build"
ARCHIVE="$DD/DungeonScan.mas.xcarchive"
EXPORT_DIR="$DD/mas-export"
APP="$EXPORT_DIR/DungeonScan.app"
DIST="../dist"                                    # ~/DungeonScan/dist
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :MARKETING_VERSION' DungeonScan/Info.plist 2>/dev/null || echo 0.1.0)"

APP_ONLY=0
for a in "$@"; do [[ "$a" == "--app" ]] && APP_ONLY=1; done

if [[ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]]; then
  echo "⚠️  ssh session detected — the signing keychain is locked over non-GUI ssh."
  echo "    Run this from Terminal.app on the Mac."
fi

# ---- provisioning profile: read UUID + install where Xcode looks ------------
if [[ ! -f "$PROFILE" ]]; then
  echo "ERROR: MAS provisioning profile not found at $PROFILE" >&2
  echo "       Create a 'Mac App Store' profile for $BUNDLE_ID in the Apple" >&2
  echo "       Developer portal (or Xcode > Settings > Accounts > Download), then" >&2
  echo "       drop it at ~/DungeonScan/apple/DungeonScan_MAS.provisionprofile." >&2
  exit 2
fi
PROFILE_UUID="$(/usr/bin/security cms -D -i "$PROFILE" 2>/dev/null \
  | /usr/bin/plutil -extract UUID raw - 2>/dev/null || true)"
if [[ -z "$PROFILE_UUID" ]]; then
  echo "ERROR: could not read UUID from $PROFILE — is it a valid .provisionprofile?" >&2
  exit 2
fi
PROFILES_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILES_DIR"
cp "$PROFILE" "$PROFILES_DIR/$PROFILE_UUID.provisionprofile"
echo "==> provisioning profile $PROFILE_UUID installed -> $PROFILES_DIR"

echo "==> xcodegen generate…"
xcodegen generate

# ---- MAS export options ------------------------------------------------------
mkdir -p "$DD"
cat > "$DD/ExportOptions.mas.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>mac-application</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key>
    <string>$PROFILE_UUID</string>
  </dict>
</dict>
</plist>
EOF

echo "==> xcodebuild archive (Release; Apple Distribution + MAS profile)…"
xcodebuild archive \
  -project DungeonScan.xcodeproj -scheme "$SCHEME" -configuration Release \
  -derivedDataPath "$DD" -archivePath "$ARCHIVE" \
  CODE_SIGN_IDENTITY="$APP_CERT" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_ENTITLEMENTS="$MAS_ENTS" \
  ENABLE_HARDENED_RUNTIME=YES \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID" \
  > "$DD/mas_archive.log" 2>&1 \
  || { echo "ARCHIVE FAILED — see $DD/mas_archive.log" >&2; tail -25 "$DD/mas_archive.log" >&2; exit 1; }

echo "==> exportArchive (mac-application) -> signed sandboxed .app…"
rm -rf "$EXPORT_DIR"; mkdir -p "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$DD/ExportOptions.mas.plist" \
  -exportPath "$EXPORT_DIR" \
  > "$DD/mas_export.log" 2>&1 \
  || { echo "EXPORT FAILED — see $DD/mas_export.log" >&2; tail -25 "$DD/mas_export.log" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "no .app at $APP" >&2; exit 1; }
echo "    exported: $APP ($(du -sh "$APP" | cut -f1))"

echo "==> verify (codesign --deep --strict) + entitlements…"
codesign --verify --deep --strict --verbose=2 "$APP" && echo "    ✓ codesign --verify passed"
echo "    entitlements on the signed sandboxed app (sandbox=true, no allow-unsigned):"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null \
  | grep -A1 -E 'app-sandbox|network.client|user-selected|bookmarks.app-scope|allow-unsigned' \
  | sed 's/^/      /' || true

[[ $APP_ONLY == 1 ]] && { echo "done (signed sandboxed .app only): $APP"; exit 0; }

# ---- productbuild -> store .pkg ---------------------------------------------
echo "==> productbuild -> store .pkg (signed with the Installer cert)…"
mkdir -p "$DIST"
PKG="$DIST/DungeonScan-${VERSION}-mas.pkg"
productbuild \
  --component "$APP" /Applications \
  --sign "$PKG_CERT" \
  --product "$ARCHIVE/Info.plist" \
  "$PKG" > "$DD/productbuild.log" 2>&1 \
  || { echo "PRODUCTBUILD FAILED — see $DD/productbuild.log" >&2; tail -25 "$DD/productbuild.log" >&2; exit 1; }
echo "    ✓ .pkg: $PKG ($(du -sh "$PKG" | cut -f1))"

# ---- next steps: validate + upload ------------------------------------------
cat <<EOF

================ MAS UPLOAD — NEXT STEPS ================
0) Build .pkg ready: $PKG

1) VALIDATE (preferred: App Store Connect API key — create one in
   App Store Connect > Users and Access > Keys, download + keep the .p8):
     xcrun altool --validate-app \\
       -f "$PKG" -t macos \\
       --apiKey  <APP_STORE_KEY_ID> \\
       --apiIssuer <APP_STORE_ISSUER_ID>

   (or Apple ID + app-specific password):
     xcrun altool --validate-app -f "$PKG" -t macos \\
       -u <APPLE_ID> -p <APP_SPECIFIC_PASSWORD>

2) UPLOAD (same credential form; altool wraps iTMSTransporter):
     xcrun altool --upload-app -f "$PKG" -t macos \\
       --apiKey <APP_STORE_KEY_ID> --apiIssuer <APP_STORE_ISSUER_ID>

   — OR drag $PKG into the Transporter.app and click Deliver.

3) App Store Connect: DungeonScan app > new build appears from the upload >
   add screenshots + metadata + privacy label (Data Not Collected) >
   Submit for Review. Full list in ../MAS_CHECKLIST.md.

   NOTE: `xcrun notarytool` is NOT used here — it is for the Developer-ID
   channel only. Store builds are validated by App Review, not notarization.
=========================================================
EOF
echo "DONE."
