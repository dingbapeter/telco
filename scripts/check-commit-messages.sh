#!/usr/bin/env bash
# The em dash ban covers commit messages too. On a push CI checks every
# commit in the range; locally the commit-msg hook checks the one being made.
set -euo pipefail
range="${1:-HEAD~1..HEAD}"
em_dash=$(printf '\xe2\x80\x94')
bad=0
while IFS= read -r sha; do
  msg=$(git log -1 --format=%B "$sha")
  if printf '%s' "$msg" | LC_ALL=C.UTF-8 grep -qF -- "$em_dash"; then
    echo "Commit $sha has an em dash in its message."
    bad=1
  fi
done < <(git rev-list "$range")
exit "$bad"
