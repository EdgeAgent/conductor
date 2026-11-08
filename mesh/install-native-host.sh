#!/bin/sh
# Install the Conductor mesh native-messaging host for this user.
# Usage: ./install-native-host.sh [chrome-extension-id ...]
# Default allowed origins: the published Conductor item + common dev IDs.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="ca.edgeagency.meshnode"
ORIGINS='"chrome-extension://gfbfkjbimihafobafnnnbncgjepccafe/"'
for id in "$@"; do ORIGINS="$ORIGINS, \"chrome-extension://$id/\""; done
MANIFEST="{\"name\": \"$HOST_NAME\", \"description\": \"Edge Agency Mesh daemon for Conductor\", \"path\": \"$DIR/native-host.sh\", \"type\": \"stdio\", \"allowed_origins\": [$ORIGINS]}"
for base in "$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts" "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; do
  case "$base" in "$HOME/Library"*) [ -d "$(dirname "$base")" ] || continue ;; esac
  mkdir -p "$base"
  printf '%s' "$MANIFEST" > "$base/$HOST_NAME.json"
  echo "installed: $base/$HOST_NAME.json"
done
echo "Done. Enroll this machine's node with:  node \"$DIR/daemon.mjs\" enroll --name \"$(hostname)\""
echo "Then start the node with:               node \"$DIR/daemon.mjs\" serve"
echo "Windows: register HKCU\\\\Software\\\\Google\\\\Chrome\\\\NativeMessagingHosts\\\\$HOST_NAME to point at a .json like the above (path = native-host.bat). See README."
