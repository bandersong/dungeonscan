#!/bin/zsh
# DungeonScan — iPad build for TestFlight.
#
# Prereqs (one-time, YOUR Apple Developer account — the GUI/portal bits I can't do):
#   1. App Store Connect -> create an app record for bundle id
#      io.github.bandersong.dungeonscan.ios  (name "DungeonScan", iOS, iPad).
#   2. An Apple Distribution signing certificate in your login keychain
#      (Xcode > Settings > Accounts > Manage Certificates, or automatic signing).
#   3. Set your Team ID below (Apple Developer > Membership > Team ID), or pass it:
#        DEVELOPMENT_TEAM=XXXXXXXXXX zsh build_ios.sh
#
# Run in Terminal.app on the Mac (needs the GUI keychain for signing).

set -e
cd "$(dirname "$0")"
TEAM="${DEVELOPMENT_TEAM:-}"
[ -z "$TEAM" ] && { echo "Set DEVELOPMENT_TEAM=<your 10-char Team ID> and re-run."; exit 1; }

echo "==> regenerating project"
xcodegen generate

ARCHIVE="build/DungeonScan-iOS.xcarchive"
EXPORT="build/ios-export"
rm -rf "$ARCHIVE" "$EXPORT"

echo "==> archiving (Release, generic iOS device)"
xcodebuild -project DungeonScan.xcodeproj -scheme DungeonScan-iOS \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  archive

echo "==> exporting .ipa (app-store)"
cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store</string>
  <key>teamID</key><string>$TEAM</string>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist build/ExportOptions.plist -exportPath "$EXPORT"

echo ""
echo "==> DONE. IPA at: $EXPORT/DungeonScan-iOS.ipa"
echo "    Upload to TestFlight, either:"
echo "      • open the .xcarchive in Xcode > Organizer > Distribute App > TestFlight, OR"
echo "      • xcrun altool --upload-app -f \"$EXPORT/DungeonScan-iOS.ipa\" -t ios \\"
echo "          --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>   (App Store Connect API key)"
echo "    Then add bro as an internal/external tester -> he installs via the TestFlight app."
