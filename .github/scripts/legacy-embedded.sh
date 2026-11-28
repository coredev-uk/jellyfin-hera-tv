#!/usr/bin/env bash
# Fails unless every file in web-legacy/ is embedded in the plugin DLL named by $1, under the name
# the plugin looks for (legacy/<file>): a build that ran `npm run build:legacy` and still lost the
# legacy assets would ship without them and nothing else would say so.
set -euo pipefail

dll="${1:?usage: legacy-embedded.sh <plugin dll>}"
shopt -s nullglob
files=(web-legacy/*.js web-legacy/*.css)
if [ "${#files[@]}" -eq 0 ]; then
  echo "::error::web-legacy/ is empty: npm run build:legacy did not run, or built nothing"
  exit 1
fi

missing=0
for file in "${files[@]}"; do
  name="legacy/$(basename "$file")"
  if ! grep -aqF "$name" "$dll"; then
    echo "::error::$name is not embedded in $dll"
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1
echo "${#files[@]} legacy assets are embedded in $dll"
