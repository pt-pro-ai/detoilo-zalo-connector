#!/usr/bin/env bash
# Tag the current package.json version and push it to origin.
# GitHub Actions then builds Windows/macOS installers and uploads them
# as GitHub Release large assets (not git blobs).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(node -p "require('./package.json').version")"
tag="v${version}"

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "tag $tag already exists" >&2
  exit 1
fi

git add package.json package-lock.json
if ! git diff --cached --quiet; then
  git commit -m "Release ${tag}"
fi

git tag -a "$tag" -m "detoilo Zalo ${tag}"
git push origin HEAD
git push origin "$tag"
echo "pushed $tag — watch GitHub Actions Release"
