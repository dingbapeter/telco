# Telco

Airtime and data transfer between Nigerian mobile networks. A sender moves
airtime from their own network to a number on another network, and pays a
fee set in the command centre.

The working name is Telco. Suggested names are in
`docs/WAITING_ON_FOUNDER.md`, item 20.

## Where to read

- `docs/WORKING_METHOD.md` is the standard every change is held to.
- `docs/PRODUCT.md` is what the product does and why it is built this way.
- `docs/CODES.md` answers what a person actually dials, and who makes each
  kind of code.
- `docs/WAITING_ON_FOUNDER.md` lists every open decision, with a
  recommendation for each.
- `docs/DEPLOY.md` is how to put it on a server, step by step.
- `docs/MONEY.md` is the page that says what is ours and what it earned.
- `docs/TESTING.md` records which deliberate breakages each check catches.
- `docs/SECURITY.md` is the security position and what was found and fixed.
- `docs/BRIDGE.md`, `docs/PROVIDER.md`, `docs/RETAIL.md`, `docs/DATA.md`,
  `docs/AGENTS.md`, `docs/AGENT_API.md`, `docs/SELLBACK.md` and
  `docs/TELCOS.md` cover the phone bridge, the top-up provider, selling
  airtime, selling data, agents and shops, the interface their own software
  uses, buying airtime and data back from people, and the networks.

## Running it

Node 22 and Postgres 16. No build step: the TypeScript runs as it is.

```
npm install
npm run migrate      # needs DATABASE_URL
npm start
```

## Checks

```
npm run check        # prose, types and the whole suite
npm run mutations    # breaks the code on purpose, one way at a time
npm run browsers     # the pages on Chromium, WebKit and Firefox
```

`scripts/check-prose.sh` fails when any tracked file contains an em dash or a
banned word. It runs in CI on every push and pull request. Commit messages are
checked too. To have the commit message check run on your own machine before a
commit is made, run this once in your clone:

```
git config core.hooksPath .githooks
```
