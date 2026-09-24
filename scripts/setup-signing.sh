#!/usr/bin/env bash
# Create a stable self-signed code-signing identity "Opentodo Developer" in the
# login keychain. Once signed with a stable identity, Keychain and TCC
# (Documents folder, etc.) access grants survive rebuilds, so the amount of
# re-prompting drops to a single "always allow".
#
# Idempotent: no-op if the identity already exists.
# Run once:   bash scripts/setup-signing.sh
set -euo pipefail

IDENTITY="Opentodo Developer"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "signing identity already present: $IDENTITY"
  exit 0
fi

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

# 清掉旧的残缺身份（如缺少 codeSigning EKU 的），避免重装残留。
for hash in $(security find-certificate -c "$IDENTITY" -Z "$KEYCHAIN" 2>/dev/null | grep 'SHA-1' | awk '{print $3}'); do
  security delete-certificate -Z "$hash" "$KEYCHAIN" 2>/dev/null || true
done

echo "==> generating self-signed identity: $IDENTITY"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -subj "/CN=$IDENTITY" >/dev/null 2>&1
openssl pkcs12 -export -legacy \
  -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/identity.p12" -passout pass:temp >/dev/null 2>&1

security import "$DIR/identity.p12" -k "$KEYCHAIN" -P temp \
  -A -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1

echo "created signing identity: $IDENTITY (login keychain)"
echo "tip: keep your login keychain alive; deleting it invalidates past grants."