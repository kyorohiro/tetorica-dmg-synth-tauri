#!/bin/sh
set -eu

# Supply these through the shell or a private environment file. No credentials
# are stored in this repository. APPLE_PASSWORD is an app-specific password.
: "${APPLE_SIGNING_IDENTITY:?Set your Developer ID Application signing identity}"
: "${APPLE_ID:?Set your Apple Account email}"
: "${APPLE_TEAM_ID:?Set your Apple Developer Team ID}"
: "${APPLE_PASSWORD:?Set your app-specific notarization password}"
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_PASSWORD
export CI=true

# Install the corresponding Rust targets before invoking this script.
# Pass one or more target triples to build a subset.
if [ "$#" -eq 0 ]; then
  set -- aarch64-apple-darwin x86_64-apple-darwin
fi
for target in "$@"; do
  case "$target" in
    aarch64-apple-darwin|x86_64-apple-darwin) ;;
    *) echo "Unsupported macOS target: $target" >&2; exit 2 ;;
  esac
  npx --no-install tauri build --target "$target" --bundles app,dmg -- --locked
done
