#!/usr/bin/env bash
# Build a NEW Cloud SQL database from scratch: roles + shims, the existing
# schema, then the Cloud-SQL clean-up and role checks.
#
#   01_bootstrap.sql            roles, auth.uid() shim, identity map, storage stand-in
#   supabase/migrations/*.sql   unchanged, in version order
#   02_post_migrate.sql         drop the Supabase-only parts, assert the app's roles
#
# NEVER run this against resolute_live (production). It applies
# supabase/migrations/*, which CLAUDE.md forbids there; the live database is
# changed only through gcp/preflight.sh (read-only) and gcp/migrate.sh.
#
# Credentials come from the environment only -- DB_USER, DB_PASS, DB_NAME,
# BUCKET_NAME, and PGPASSWORD for ADMIN_USER -- so nothing secret is ever
# written into this repository.
#
# Connect through the Cloud SQL Auth Proxy rather than exposing the instance:
#   cloud-sql-proxy "$PROJECT:$REGION:resolute-db-instance" --port 5432 &
#
# MIGRATIONS_DIR overrides the migrations directory (default
# supabase/migrations). gcp/test/run.sh uses it to build a database shaped like
# an older production snapshot; nothing else should need it.
set -euo pipefail

: "${DB_USER:?set DB_USER}"
: "${DB_PASS:?set DB_PASS}"
: "${DB_NAME:?set DB_NAME}"
: "${BUCKET_NAME:?set BUCKET_NAME}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
ADMIN_USER="${ADMIN_USER:-postgres}"  # only for bootstrap, never for the app

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$repo/supabase/migrations}"

# Refuse before connecting to anything. The list is deliberately explicit and
# case-insensitive; extend RESOLUTE_PROTECTED_DBS rather than removing entries.
PROTECTED="resolute_live ${RESOLUTE_PROTECTED_DBS:-}"
for p in $PROTECTED; do
  if [ "$(printf '%s' "$DB_NAME" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "bootstrap.sh: refusing to run against protected database '$DB_NAME'." >&2
    echo "  It applies supabase/migrations/*, which must never touch production." >&2
    echo "  Use gcp/preflight.sh (read-only) and gcp/migrate.sh for the live database." >&2
    exit 64
  fi
done
if [ "$DB_USER" = "$ADMIN_USER" ]; then
  echo "bootstrap.sh: DB_USER must not be ADMIN_USER ($ADMIN_USER): the app would own the schema and bypass RLS." >&2
  exit 64
fi

shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
if [ "${#migrations[@]}" -eq 0 ]; then
  echo "bootstrap.sh: no migrations in $MIGRATIONS_DIR" >&2
  exit 66
fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$ADMIN_USER" -d "$DB_NAME")

echo "==> bootstrapping ${DB_NAME} on ${PGHOST}:${PGPORT} as ${ADMIN_USER}"

# Roles, the auth shim, the storage stand-in and grants. The script reads
# resolute.app_user.
PGOPTIONS="-c resolute.app_user=${DB_USER}" "${PSQL[@]}" -f "$here/01_bootstrap.sql"

# Set the app role's password without it appearing in argv or the shell history,
# and without interpolating it into SQL text where a quote would break out.
# psql only interpolates :"var" / :'var' in input it READS -- never in -c -- so
# the statement goes in on stdin. (The previous -c form sent ':"user"' to the
# server verbatim and failed with a syntax error, stopping the bootstrap here.)
printf '%s\n' "alter role :\"app_user\" with password :'app_pass';" \
  | "${PSQL[@]}" -v app_user="$DB_USER" -v app_pass="$DB_PASS"

# The schema itself: the same migrations that run on Supabase, in version order.
for f in "${migrations[@]}"; do
  echo "==> $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

# Drop what only made sense on Supabase and assert the roles the API relies on.
# Previously a separate manual step that was easy to skip; skipping it left the
# storage stand-in's policies and the dead signup trigger in place.
echo "==> 02_post_migrate.sql"
PGOPTIONS="-c resolute.app_user=${DB_USER}" "${PSQL[@]}" -f "$here/02_post_migrate.sql"

echo "==> done (${#migrations[@]} migrations). Bucket for document storage: ${BUCKET_NAME}"
echo "    The app must connect as ${DB_USER}, never as ${ADMIN_USER}:"
echo "    the schema owner bypasses RLS on its own tables."
