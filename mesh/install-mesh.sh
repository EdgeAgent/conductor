#!/bin/sh
# Conductor Mesh — one-command install (macOS / Linux)
# Downloads the Agent Mesh daemon (the engine behind Conductor Mesh Mode),
# registers the Chrome Native Messaging host, and enrolls this machine.
set -e
ZIP_URL="https://github.com/EdgeAgent/conductor/releases/download/mesh-v1.0.0/conductor-mesh-v1.0.0.zip"
DEST="$HOME/.conductor-mesh"
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
command -v openssl >/dev/null || echo "warning: openssl not found — certificate issuance needs it"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
curl -fsSL "$ZIP_URL" -o "$TMP/mesh.zip"
unzip -qo "$TMP/mesh.zip" -d "$DEST"
rm -rf "$TMP"
sh "$DEST/install-native-host.sh"
node "$DEST/daemon.mjs" enroll --name "$(hostname -s)"
echo ""
echo "Mesh engine installed in $DEST"
echo "Start this machine's node:  node \"$DEST/daemon.mjs\" serve"
echo "Then install Conductor from the Chrome Web Store and open its Mesh tab."
