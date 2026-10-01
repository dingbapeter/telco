#!/usr/bin/env bash
# Rebuilds a test database, walks the whole product on a phone-sized
# browser, and leaves a numbered screenshot of every screen.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/telco_test}"
node scripts/reset-test-db.ts > /dev/null
exec node scripts/phone-walkthrough.mjs
