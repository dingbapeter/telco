#!/usr/bin/env bash
# Runs the whole suite against a real Postgres. Set DATABASE_URL to use one
# you already have (CI does). Without it, the script uses the local cluster
# and a database called telco_test, which it wipes and rebuilds from the
# migrations every run, so the migrations are proven on every test run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/telco_test"
  # On a developer machine with the Ubuntu Postgres packages, start the
  # local cluster if it is not running, so the suite can always be run.
  if command -v pg_lsclusters >/dev/null && pg_lsclusters 2>/dev/null | grep -q "main.*down"; then
    pg_ctlcluster 16 main start
  fi
fi

if [ "${TEST_KEEP_DATABASE:-}" != "1" ]; then
  # Only ever wipes a database whose name ends in _test.
  case "$DATABASE_URL" in
    *_test|*_test\?*) ;;
    *) echo "Refusing to wipe a database not named *_test: $DATABASE_URL"; exit 1 ;;
  esac
  node scripts/reset-test-db.ts
fi

exec node --test --test-concurrency=1 --test-reporter=spec "${@:-tests/**/*.test.ts}"
