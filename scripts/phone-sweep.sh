#!/usr/bin/env bash
# Seeds a test database, starts the server, runs the phone sweep, stops it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/telco_test}"
export PORT=3994
export PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
node scripts/reset-test-db.ts > /dev/null
eval "$(node scripts/seed-for-sweep.ts)"
node src/main.ts > "${SHOTS_DIR:-phone-shots}.server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health" > /dev/null && break; sleep 0.2; done
node scripts/phone-sweep.mjs
