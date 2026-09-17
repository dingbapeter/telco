# Telco

Airtime and data transfer between mobile networks.

The product has not been described in detail yet. Until it is, this repository
holds the standard it will be built to and the decisions still waiting on the
founder.

- `docs/WORKING_METHOD.md` is the standard every change is held to.
- `docs/WAITING_ON_FOUNDER.md` lists every open decision, with a recommendation.
- `docs/TESTING.md` records which deliberate breakages each check catches.

## Checks

`scripts/check-prose.sh` fails when any tracked file contains an em dash or a
banned word. It runs in CI on every push and pull request. Commit messages are
checked too. To have the commit message check run on your own machine before a
commit is made, run this once in your clone:

```
git config core.hooksPath .githooks
```
