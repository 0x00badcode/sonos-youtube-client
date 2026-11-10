#!/bin/sh
set -e
cd "$(dirname "$0")"
swift build -c release
APP=build/SonosTube.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/SonosTube "$APP/Contents/MacOS/"
cp Support/Info.plist "$APP/Contents/"
cp Support/AppIcon.icns "$APP/Contents/Resources/"
codesign --force --sign - "$APP"
echo "Built $APP"
