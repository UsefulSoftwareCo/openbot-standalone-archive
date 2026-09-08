#!/bin/bash
# Builds the computer helper and assembles it into a signed .app bundle.
#
# The bundle is not cosmetic. TCC records Screen Recording and Accessibility
# against a bundle identifier plus a code signature, so a bare SwiftPM
# executable can never hold either grant -- it has no bundle identifier to
# record against. `swift build` alone produces exactly that, which is why the
# server launches the executable *inside* this bundle rather than the one in
# `.build/release`.
#
# LSUIElement matches the accessory activation policy the helper sets at
# startup: it needs a run loop for CGVirtualDisplay, ScreenCaptureKit and
# Accessibility, but it is a helper and must never take a Dock tile or the
# menu bar.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-dist/T3ComputerHelper.app}"
IDENTITY="T3 OpenBot Local Signing"

swift build -c release --product T3ComputerHelper
BINARY="$(swift build -c release --product T3ComputerHelper --show-bin-path)/T3ComputerHelper"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BINARY" "$APP/Contents/MacOS/T3ComputerHelper"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>T3ComputerHelper</string>
  <key>CFBundleDisplayName</key><string>T3 Computer Helper</string>
  <key>CFBundleIdentifier</key><string>codes.t3.openbot.computer-helper</string>
  <key>CFBundleExecutable</key><string>T3ComputerHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# A stable certificate makes TCC pin the grant to the certificate, so Screen
# Recording and Accessibility survive a rebuild. Ad-hoc signing pins the code
# hash instead, which changes on every build and silently drops both grants --
# workable for one run, useless as a setup. `scripts/make-signing-identity.sh`
# creates the certificate.
if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" "$APP"
  echo "signed with '$IDENTITY'"
else
  codesign --force --sign - "$APP"
  echo "signed ad-hoc: Screen Recording and Accessibility will reset on each rebuild."
  echo "run native/computer-helper/scripts/make-signing-identity.sh once to keep them."
fi

echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
