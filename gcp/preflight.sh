#!/usr/bin/env bash
# Read-only schema preflight for a GCP (Cloud SQL) database.
#
#   gcp/preflight.sh            # pre:  is it ready for gcp/migrations/20261124000000?
#   gcp/preflight.sh --post     # post: did that migration land exactly as reviewed?
#   gcp/preflight.sh --app-user resolute_app   # name of the API's login role
#
# Connection comes from the standard libpq environment (PGHOST, PGPORT,
# PGUSER, PGDATABASE, PGPASSWORD or ~/.pgpass, PGSSLMODE ...). Through the
# Cloud SQL Auth Proxy that is usually PGHOST=127.0.0.1.
#
# Safe against production by construction, in three layers:
#   1. the session is opened with default_transaction_read_only=on, so the
#      server refuses any write for the whole connection;
#   2. preflight.sql runs in one explicit READ ONLY transaction, asserts it is
#      read-only, and ROLLS BACK;
#   3. it reads the catalog and aggregate counts only -- no row, name or email
#      is ever selected or printed.
#
# Exit status: 0 = no FAIL (WARN allowed), 2 = at least one FAIL,
#              1 = could not run (connection, permissions, bad arguments).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
phase=pre
app_user="${APP_USER:-resolute_app}"
while [ $# -gt 0 ]; do
  case "$1" in
    --post) phase=post ;;
    --pre) phase=pre ;;
    --app-user) app_user="${2:?--app-user needs a value}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "preflight.sh: unknown argument $1" >&2; exit 1 ;;
  esac
  shift
done
: "${PGDATABASE:?set PGDATABASE (and PGHOST/PGPORT/PGUSER)}"

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30s -c lock_timeout=2s ${PGOPTIONS:-}" \
  psql -X -q -v ON_ERROR_STOP=1 -v phase="$phase" -v app_user="$app_user" \
       -f "$here/preflight.sql" >"$out" 2>&1
rc=$?
cat "$out"

if [ $rc -eq 0 ] && grep -q '^PREFLIGHT_RESULT=PASS$' "$out"; then
  exit 0
elif grep -q '^PREFLIGHT_RESULT=FAIL$' "$out"; then
  exit 2
else
  echo "preflight.sh: did not complete (psql exit $rc)" >&2
  exit 1
fi
