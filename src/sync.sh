#!/usr/bin/env bash
#
# Publish a depot to an S3-compatible bucket (Cloudflare R2).
#
#   ./sync.sh <depot-folder> <rclone-remote>:<bucket>[/prefix]
#   ./sync.sh ../shaderlibrary-assets r2:fernantastic-assets/v1
#
# Uploads dist/ and manifest.json into one flat prefix, which is the layout the
# manifest assumes: manifest.json at the root, variant paths relative to it.
#
# Refuses to publish a depot whose depot.json does not say `"public": true`.
# That flag is set only when every pack's licence has been established, and the
# build enforces the same rule — so a depot holding anything unlicensed cannot
# reach a bucket by fumbling a path here.
set -euo pipefail

DEPOT="${1:?usage: sync.sh <depot-folder> <remote>:<bucket>[/prefix]}"
DEST="${2:?usage: sync.sh <depot-folder> <remote>:<bucket>[/prefix]}"

command -v rclone >/dev/null || { echo "rclone not found — https://rclone.org/downloads/" >&2; exit 1; }
[ -f "$DEPOT/manifest.json" ] || { echo "no manifest.json in $DEPOT — run: npx depot $DEPOT" >&2; exit 1; }

is_public=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$DEPOT/depot.json','utf8')).public===true))")
if [ "$is_public" != "true" ]; then
  echo "REFUSING: $DEPOT/depot.json does not declare \"public\": true." >&2
  echo "A depot is private because something in it may not be redistributed." >&2
  exit 1
fi

# Fail before uploading rather than halfway through: a manifest listing a
# variant that was never encoded would publish a bucket that 404s per frame.
echo "→ verifying manifest against dist/"
node "$(dirname "$0")/build.mjs" "$DEPOT" --manifest-only >/dev/null

echo "→ uploading dist/ to $DEST"
# Immutable: every path is content that only ever gets added to, so a long
# max-age costs nothing and saves the round trip. Version the prefix (…/v1) to
# publish a breaking change rather than mutating what is already out there.
rclone copy "$DEPOT/dist" "$DEST" \
  --header-upload "Cache-Control: public, max-age=31536000, immutable" \
  --transfers 16 --checksum --progress

echo "→ uploading manifest.json"
# Deliberately NOT immutable: this is the one file that changes when the depot
# does, and a stale copy points at variants that may not exist yet.
rclone copy "$DEPOT/manifest.json" "$DEST" \
  --header-upload "Cache-Control: public, max-age=60" \
  --checksum

echo "done. Set the depot's baseUrl to the public URL of $DEST"
