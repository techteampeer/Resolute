#!/usr/bin/env bash
# Run a guarded GCP migration (gcp/migrations/*.sql). DRY RUN unless --apply.
#
#   gcp/migrate.sh gcp/migrations/20261124000000_charge_and_client_functions.sql
#   CONFIRM_DATABASE=<db> gcp/migrate.sh --apply gcp/migrations/2026...sql
#
# Connection: standard libpq environment (PGHOST, PGPORT, PGUSER, PGDATABASE,
# PGPASSWORD or ~/.pgpass), usually through the Cloud SQL Auth Proxy. PGUSER
# must be a member of the role that owns public.orders (preflight checks it).
#
# Sequence, each step gating the next:
#   1. gcp/preflight.sh            read-only; any FAIL stops here
#   2. the migration, apply=false   full run inside a transaction, ROLLED BACK
#   3. (--apply only) the migration, apply=true   committed
#   4. (--apply only) gcp/preflight.sh --post     must pass
#
# --apply additionally requires
#   CONFIRM_DATABASE   equal to PGDATABASE (typed, not defaulted)
# and, for a protected database (resolute_live, or any in RESOLUTE_PROTECTED_DBS),
#   RESOLUTE_CHANGE_APPROVAL   the reference of the approved change (ADR 0003:
#                              Claudio's cost approval). It is printed, not
#                              checked against anything: it exists so nobody
#                              applies to production by accident or anonymously.
#
# Exit: 0 ok, 2 refused (preflight FAIL / guard / confirmation), 1 error.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
apply=false
app_user="${APP_USER:-resolute_app}"
file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --app-user) app_user="${2:?--app-user needs a value}"; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    -*) echo "migrate.sh: unknown option $1" >&2; exit 1 ;;
    *) file="$1" ;;
  esac
  shift
done
[ -n "$file" ] && [ -f "$file" ] || { echo "migrate.sh: name a migration file" >&2; exit 1; }
case "$file" in
  */supabase/migrations/*|supabase/migrations/*)
    echo "migrate.sh: refusing $file -- supabase/migrations/* must never run against Cloud SQL (CLAUDE.md)." >&2
    exit 2 ;;
esac
: "${PGDATABASE:?set PGDATABASE (and PGHOST/PGPORT/PGUSER)}"

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
protected=false
for p in resolute_live ${RESOLUTE_PROTECTED_DBS:-}; do
  [ "$(lower "$PGDATABASE")" = "$(lower "$p")" ] && protected=true
done

if $apply; then
  if [ "${CONFIRM_DATABASE:-}" != "$PGDATABASE" ]; then
    echo "migrate.sh: --apply needs CONFIRM_DATABASE=$PGDATABASE" >&2
    exit 2
  fi
  if $protected && [ -z "${RESOLUTE_CHANGE_APPROVAL:-}" ]; then
    echo "migrate.sh: $PGDATABASE is protected; --apply needs RESOLUTE_CHANGE_APPROVAL=<approved change reference>" >&2
    exit 2
  fi
fi

echo "==> target: db=$PGDATABASE host=${PGHOST:-local} user=${PGUSER:-$USER} protected=$protected apply=$apply"
$protected && $apply && echo "==> approval reference: $RESOLUTE_CHANGE_APPROVAL"

echo "==> 1/4 preflight (read-only)"
"$here/preflight.sh" --app-user "$app_user"
rc=$?
if [ $rc -ne 0 ]; then
  echo "migrate.sh: preflight exit $rc -- nothing was run" >&2
  [ $rc -eq 2 ] && exit 2 || exit 1
fi

run_migration() { # $1 = true|false
  psql -X -q -v ON_ERROR_STOP=1 -v apply="$1" -v confirm_db="$PGDATABASE" -f "$file"
}

echo "==> 2/4 dry run (rolled back)"
if ! run_migration false; then
  echo "migrate.sh: dry run failed -- nothing was changed" >&2
  exit 2
fi

if ! $apply; then
  echo "==> DRY RUN complete. Re-run with --apply (and CONFIRM_DATABASE) to commit."
  exit 0
fi

echo "==> 3/4 apply"
if ! run_migration true; then
  echo "migrate.sh: apply failed -- the transaction was rolled back" >&2
  exit 2
fi

echo "==> 4/4 post-check (read-only)"
"$here/preflight.sh" --post --app-user "$app_user"
rc=$?
if [ $rc -ne 0 ]; then
  echo "migrate.sh: APPLIED, but the post-check failed (exit $rc). Investigate before using the new functions." >&2
  exit 2
fi
echo "==> done"
