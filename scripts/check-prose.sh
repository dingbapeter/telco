#!/usr/bin/env bash
# Fails the build when tracked text contains an em dash or one of the words
# the founder has banned from anything a person reads. The rule lives in
# docs/WORKING_METHOD.md. It is enforced here rather than by memory because a
# rule that depends on someone remembering it is not a rule.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Files that quote the banned words in order to ban them.
exempt='^(docs/WORKING_METHOD\.md|docs/TESTING\.md|docs/WAITING_ON_FOUNDER\.md|scripts/check-prose\.sh)$'

# Vendored or generated content is not ours to rewrite.
skip_dirs='^(vendor/|node_modules/|.*/vendor/|.*/node_modules/)'

em_dash=$(printf '\xe2\x80\x94')
status=0

files=$(git ls-files | grep -Ev "$skip_dirs" | grep -Ev "$exempt" || true)
[ -z "$files" ] && exit 0

if out=$(LC_ALL=C.UTF-8 grep -nF -- "$em_dash" $files 2>/dev/null); then
  echo "Em dash found. Replace it with a full stop, a comma or a colon:"
  echo "$out"
  status=1
fi
if out=$(grep -niF -- '&mdash;' $files 2>/dev/null); then
  echo "HTML em dash entity found:"
  echo "$out"
  status=1
fi

tells='\b(seamless(ly)?|robust(ly|ness)?|leverage[sd]?|leveraging|delv(e|es|ed|ing)|elevat(e|es|ed|ing))\b'
if out=$(LC_ALL=C.UTF-8 grep -niEw -- "$tells" $files 2>/dev/null); then
  echo "Banned word found. Say the plain thing instead:"
  echo "$out"
  status=1
fi

pattern_not_just="it'?s not just [^.]* it'?s"
if out=$(LC_ALL=C.UTF-8 grep -niE -- "$pattern_not_just" $files 2>/dev/null); then
  echo "The 'it is not just X, it is Y' pattern is banned:"
  echo "$out"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Prose check passed on $(echo "$files" | wc -l | tr -d ' ') files."
fi
exit "$status"
