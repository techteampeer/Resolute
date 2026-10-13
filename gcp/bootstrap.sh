#!/usr/bin/env bash
# Bootstrap resolute_prod on Cloud SQL, then apply the existing schema.
#
# Credentials come from the environment only -- DB_USER, DB_PASS, DB_NAME,
# BUCKET_NAME -- so nothing secret is ever written into this repository. In CI
# these come from GitHub secrets; locally, export them yourself.
#
# Connect through the Cloud SQL Auth Proxy rather than exposing the instance:
#   cloud-sql-proxy "$PROJECT:$REGION:resolute-db-instance" --port 5432 &
set -euo pipefail

: "${DB_USER:?set DB_USER}"
: "${DB_PASS:?set DB_PASS}"
: "${DB_NAME:?set DB_NAME}"          # resolute_prod
: "${BUCKET_NAME:?set BUCKET_NAME}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
ADMIN_USER="${ADMIN_USER:-postgres}"  # only for bootstrap, never for the app

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

echo "==> bootstrapping ${DB_NAME} on ${PGHOST}:${PGPORT}"

# Roles, the auth shim and grants. resolute.app_user is read by the script.
PGOPTIONS="-c resolute.app_user=${DB_USER}" \
  psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$ADMIN_USER" -d "$DB_NAME" \
       -f "$here/01_bootstrap.sql"

# Set the app role's password without it appearing in argv or the shell history,
# and without interpolating it into SQL text where a quote would break out.
psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$ADMIN_USER" -d "$DB_NAME" \
     -v user="$DB_USER" -v pass="$DB_PASS" \
     -c "alter role :\"user\" with password :'pass';"

# The schema itself: the same migrations that run on Supabase, in version order.
for f in "$repo"/supabase/migrations/*.sql; do
  echo "==> $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$ADMIN_USER" -d "$DB_NAME" -f "$f"
done

echo "==> done. Bucket for document storage: ${BUCKET_NAME}"
echo "    The app must connect as ${DB_USER}, never as ${ADMIN_USER}:"
echo "    a superuser bypasses RLS and every access rule in this schema with it."
