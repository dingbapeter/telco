# Testing record

Every suite in this repository is mutation-checked before it is trusted: the
thing it guards is broken on purpose, one way at a time, the suite is confirmed
to go red, and the breakage is put back. This file records what each check
caught. When a mutation does not turn a check red, the finding is written here
before anything is changed.

## Prose check (`scripts/check-prose.sh`)

Checked on 17 September 2026 against a staged README.md.

| Breakage introduced | Result |
| --- | --- |
| An em dash character in prose | Red. Reported file and line. |
| The HTML entity for an em dash | Red. Reported file and line. |
| The words "robust" and "seamless" in one sentence | Red. Reported file and line. |
| The sentence "It's not just fast, it's cheap." | Red. Reported file and line. |
| No breakage | Green. Reported the number of files checked. |

Known limits, recorded rather than hidden:

- The check reads tracked files only. An untracked file is not checked until it
  is staged or committed, which is the point at which it matters.
- The banned word list is the founder's list. "Delve", "elevate" and
  "leverage" are matched in their common inflections. Words used inside a
  quoted rule about the words themselves are exempt by file path, not by
  context, so a new file that needs to quote them must be added to the exempt
  list in the script.
- A three-item list where two would do cannot be checked by a machine. That
  one stays a review rule.

## Commit message check (`scripts/check-commit-messages.sh`)

Checked on 17 September 2026 by committing a message containing an em dash
with the hook installed. The hook refused the commit. The CI step checks the
pushed range, so a commit made on a machine without the hook is still caught.
