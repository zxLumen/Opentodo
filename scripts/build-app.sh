#!/usr/bin/env bash
# Build Opentodo.app into dist/ and sign it with a stable identity
# (preferring "Apple Development", falling back to self-signed
# "Opentodo Developer", then ad-hoc) so Keychain/TCC grants persist.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/app"

echo "==> swift build -c release"
swift build -c release

echo "==> ensure stable code-signing identity"
bash "$ROOT/scripts/setup-signing.sh"

# 生成 App 图标（直接渲染"悬浮球"），再打包进 bundle。
echo "==> generate app icon"
ICON_PNG="$ROOT/dist/icon-1024.png"
ICONSET="$ROOT/dist/AppIcon.iconset"
mkdir -p "$ROOT/dist"
".build/release/Opentodo" --export-icon "$ICON_PNG"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
cp "$ICON_PNG" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ROOT/dist/AppIcon.icns"

APP="$ROOT/dist/Opentodo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/plugin"

cp ".build/release/Opentodo" "$APP/Contents/MacOS/Opentodo"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/dist/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# The opentodo plugin provides the opentodo_* tools + context injection; the app
# copies it into its own opencode config dir at runtime (no separate node/MCP).
cp "$ROOT/plugin/opentodo.js" "$APP/Contents/Resources/plugin/opentodo.js"

LIST="$(security find-identity -p codesigning "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null)"
IDENTITY=""
if echo "$LIST" | grep -q "Apple Development"; then
  IDENTITY="Apple Development"
  echo "==> sign with $IDENTITY"
elif echo "$LIST" | grep -q "Opentodo Developer"; then
  IDENTITY="Opentodo Developer"
  echo "==> sign with $IDENTITY"
fi
if [ -n "$IDENTITY" ]; then
  codesign --force --deep --sign "$IDENTITY" "$APP" >/dev/null 2>&1 || true
else
  echo "==> ad-hoc sign"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
fi

echo "built: $APP"

echo "==> package dist/Opentodo.zip (unzip-and-run)"
rm -f "$ROOT/dist/Opentodo.zip"
( cd "$ROOT/dist" && ditto -c -k --sequesterRsrc --keepParent Opentodo.app Opentodo.zip )
echo "zip:   $ROOT/dist/Opentodo.zip"
echo "run:   open '$APP'  (first run from zip: xattr -dr com.apple.quarantine '$APP')"
