#!/usr/bin/env bash
# Upload packaged installers as GitHub Release *large assets* (up to 2GB).
# Do not git-add dist-desktop — GitHub rejects blobs over 100MB.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

tag="${1:-}"
if [[ -z "$tag" ]]; then
  version="$(node -p "require('./package.json').version")"
  tag="v${version}"
fi

shopt -s nullglob
files=(dist-desktop/detoilo-zalo-*.exe dist-desktop/detoilo-zalo-*.zip dist-desktop/detoilo-zalo-*.dmg)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no installers in dist-desktop/ — run npm run dist:win or dist:mac first" >&2
  exit 1
fi

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "pt-pro-ai/detoilo-zalo-connector")"

if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$repo" --title "detoilo Zalo ${tag}" --generate-notes --verify-tag
fi

echo "Uploading ${#files[@]} large assets to ${repo} ${tag}:"
ls -lh "${files[@]}"
for f in "${files[@]}"; do
  echo "uploading $(basename "$f") ($(du -h "$f" | cut -f1))"
  gh release upload "$tag" "$f" --repo "$repo" --clobber
done
