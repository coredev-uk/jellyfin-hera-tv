#!/usr/bin/env bash
# Prints Jellyfin's plugin repository manifest for Hera TV to stdout.
#
#   manifest.sh <releases.json>
#
# <releases.json> is GitHub's list-releases output (`gh api --paginate repos/<repo>/releases`, one or
# more concatenated arrays). Every published v* release that carries a hera-tv_<version>.zip becomes
# a version, newest first. Package fields come from meta.json at the repo root, so the catalogue entry
# is the one the current source describes. The checksum (MD5, as Jellyfin verifies it) and targetAbi
# are read from the zip itself, so they can't drift from what is served.
#
# ASSET_DIR=<dir> reads zips from <dir>/<asset name> instead of downloading them (dry runs, tests).
# Needs bash, jq, unzip, md5sum and curl.
set -euo pipefail

releases=${1:?usage: manifest.sh <releases.json>}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

jq -s '[.[][]
  | select(.draft == false and .prerelease == false and (.tag_name | test("^v[0-9]")))
  | . as $r
  | ([.assets[] | select(.name | test("^hera-tv_.+\\.zip$"))][0]) as $a
  | select($a != null)
  | {tag: .tag_name, body: (.body // ""), published: .published_at, name: $a.name, url: $a.browser_download_url}]
  | sort_by(.published) | reverse' "$releases" > "$work/releases.json"

echo '[]' > "$work/versions.json"
while IFS=$'\t' read -r tag name url; do
  zip="$work/$name"
  if [[ -n ${ASSET_DIR:-} ]]; then cp "$ASSET_DIR/$name" "$zip"; else curl -fsSL --retry 3 -o "$zip" "$url"; fi
  checksum=$(md5sum "$zip" | cut -d' ' -f1)
  abi=$(unzip -p "$zip" meta.json | jq -r .targetAbi)
  jq --arg tag "$tag" --arg sum "$checksum" --arg abi "$abi" --slurpfile all "$work/releases.json" '
    ($all[0][] | select(.tag == $tag)) as $r
    | . + [{
        version: ($tag | ltrimstr("v")),
        changelog: $r.body,
        targetAbi: $abi,
        sourceUrl: $r.url,
        checksum: $sum,
        timestamp: $r.published
      }]' "$work/versions.json" > "$work/next.json"
  mv "$work/next.json" "$work/versions.json"
done < <(jq -r '.[] | [.tag, .name, .url] | @tsv' "$work/releases.json")

jq --slurpfile versions "$work/versions.json" '[{
    guid, name, description, overview, owner, category,
    versions: $versions[0]
  }]' "$root/meta.json"
