#!/bin/bash
# Creates a self-signed code-signing identity in the login keychain.
#
# Without this, bundle.sh falls back to ad-hoc signing. TCC identifies an
# ad-hoc-signed app by its code hash, so every rebuild looks like a brand-new
# app and silently drops Screen Recording and Accessibility -- the helper then
# reports "denied" after a change that had nothing to do with permissions.
# Signing with a stable certificate makes TCC pin the grants to the certificate
# instead, and they survive rebuilds.
#
# Run once per machine. It touches only your login keychain.
set -euo pipefail

CN="T3 OpenBot Local Signing"
if security find-identity -v -p codesigning | grep -q "$CN"; then
  echo "identity '$CN' already exists"; exit 0
fi

DIR=$(mktemp -d)
PW=t3openbot
CERT="$DIR/cert.pem"

# The system openssl and the legacy PKCS#12 algorithms: OpenSSL 3 defaults to a
# MAC that Apple's `security` cannot read ("MAC verification failed").
/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$CERT" \
  -days 3650 -nodes -subj "/CN=$CN" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

/usr/bin/openssl pkcs12 -export -out "$DIR/id.p12" -inkey "$DIR/key.pem" -in "$CERT" \
  -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -passout "pass:$PW"

security import "$DIR/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PW" -T /usr/bin/codesign -A

# Trusted for code signing, or codesign refuses the identity.
security add-trusted-cert -r trustRoot -p codeSign -k "$HOME/Library/Keychains/login.keychain-db" "$CERT"
rm -rf "$DIR"

security find-identity -v -p codesigning | grep "$CN"
echo "rebuild with 'pnpm build:computer-helper' so the bundle picks up the identity"
