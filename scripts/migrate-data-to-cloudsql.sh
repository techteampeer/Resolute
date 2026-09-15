#!/usr/bin/env bash
# Copy the portal's data from Supabase into Cloud SQL.
#
# Uses pg_dump/psql rather than hand-built INSERTs: it round-trips jsonb, arrays,
# enums, timestamps with time zone and sequence positions faithfully, and a
# mistake in any one of those is the kind that surfaces weeks later as a wrong
# total on an invoice.
#
# Run AFTER gcp/bootstrap.sh (schema) and BEFORE scripts/link-firebase-users.mjs
# (accounts). Order matters: the profiles carry uuids that every policy and
# foreign key depends on, and the Firebase accounts are bound to them afterwards.
#
# Usage:
#   SOURCE_URL='postgresql://postgres:PASS@db.<ref>.supabase.co:5432/postgres' \
#   TARGET_URL='postgresql://postgres:PASS@127.0.0.1:5432/resolute_prod' \
#   ./scripts/migrate-data-to-cloudsql.sh            # dry run: dumps and reports
#   … --apply                                        # actually loads
#
# Reach Cloud SQL through the Auth Proxy:
#   cloud-sql-proxy resolute-508323:us-central1:resolute-db-instance --port 5432 &
set -euo pipefail

: "${SOURCE_URL:?set SOURCE_URL (the Supabase connection string)}"
: "${TARGET_URL:?set TARGET_URL (Cloud SQL, usually through the Auth Proxy)}"
APPLY="${1:-}"

# pg_dump refuses to dump from a server newer than itself, and Supabase runs
# Postgres 17 — a distro pg_dump 16 stops with "aborting because of server
# version mismatch" after you have already typed the credentials. Check first,
# and allow an explicit path so a machine with several versions installed can
# point at the right one:
#   PG_BIN=/usr/lib/postgresql/17/bin ./scripts/migrate-data-to-cloudsql.sh
PG_BIN="${PG_BIN:-}"
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
PSQL="${PG_BIN:+$PG_BIN/}psql"

dump_major=$("$PG_DUMP" --version | grep -oE '[0-9]+' | head -1)
src_major=$("$PSQL" "$SOURCE_URL" -Atqc "show server_version_num" | cut -c1-2)
if [ "$dump_major" -lt "$src_major" ]; then
  echo "pg_dump is $dump_major but the source server is $src_major." >&2
  echo "Install a matching client (postgresql-client-$src_major) or set PG_BIN." >&2
  exit 1
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# In dependency order. auth.users first: profiles.id is a foreign key to it, and
# every RLS policy is built on those uuids.
TABLES=(
  "auth.users"
  public.clients
  public.profiles
  public.vendors
  public.orders
  public.fulfillments
  public.support_messages
  public.order_events
  public.vendor_payouts
  public.subscriptions
  public.notification_types
  public.notification_preferences
  public.notification_outbox
)

echo "==> dumping from source"
# --data-only: the schema already exists, built from supabase/migrations/.
# --column-inserts is deliberately NOT used; COPY is faster and exact.
# auth.users is dumped separately because on Supabase it carries dozens of
# GoTrue columns that do not exist in the Cloud SQL stand-in — only the identity
# mapping is wanted.
"$PG_DUMP" "$SOURCE_URL" --data-only --no-owner --no-privileges \
  $(printf -- '--table=%s ' "${TABLES[@]:1}") \
  > "$OUT/public.sql"

"$PSQL" "$SOURCE_URL" -Atq -F'|' -c \
  "select id, coalesce(email,'') from auth.users order by id" > "$OUT/users.txt"

echo "    public tables: $(grep -c '^COPY' "$OUT/public.sql" || true) COPY blocks"
echo "    auth.users:    $(wc -l < "$OUT/users.txt") rows"

if [ "$APPLY" != "--apply" ]; then
  echo
  echo "DRY RUN — nothing was written to the target."
  echo "Dump left in $OUT (removed on exit); re-run with --apply to load."
  trap - EXIT
  echo "Inspect it at: $OUT"
  exit 0
fi

echo "==> loading into target"
{
  # session_replication_role = replica disables triggers AND foreign-key checks
  # for this session. Both matter:
  #   - notify_on_order_event() fires on every order_events insert and would
  #     enqueue a notification per historic row, filling the outbox with mail
  #     about things that happened weeks ago.
  #   - the guard triggers (payout/subscription/payment) would judge migrated
  #     rows as if someone were making the change now.
  #   - FK checks would force a stricter ordering than the dump guarantees.
  # It does NOT disable RLS, which is why the load runs as the schema owner.
  echo "set session_replication_role = replica;"
  echo "begin;"

  # Clear what we are about to load, so the script is re-runnable and so
  # migration-seeded reference data does not collide.
  #
  # notification_types is the one that bites: the migrations insert all seven
  # types, so a data-only load of it fails on the primary key
  # ("duplicate key value violates unique constraint notification_types_pkey")
  # and takes the whole transaction with it. Production's rows are the ones
  # wanted -- they carry any later edits -- so the seeded copies go first.
  #
  # CASCADE is not needed and not used: session_replication_role = replica has
  # already disabled the foreign keys, and naming every table explicitly means
  # this cannot quietly empty something that was not on the list.
  printf 'truncate %s restart identity;\n' "$(IFS=,; echo "${TABLES[*]}")"

  # Identity mapping first. firebase_uid stays null: the accounts do not exist
  # yet and are bound by link-firebase-users.mjs afterwards.
  while IFS='|' read -r id email; do
    [ -z "$id" ] && continue
    printf "insert into auth.users (id, email) values (%s, %s) on conflict (id) do nothing;\n" \
      "$(printf "'%s'" "$id")" \
      "$( [ -z "$email" ] && echo NULL || printf "'%s'" "${email//\'/\'\'}" )"
  done < "$OUT/users.txt"

  cat "$OUT/public.sql"

  echo "commit;"
  echo "set session_replication_role = default;"
} | "$PSQL" "$TARGET_URL" -v ON_ERROR_STOP=1 -q

echo "==> resynchronising sequences"
# A sequence left at 1 after a data load hands out ids that already exist, and
# the first person to create an order hits a duplicate-key error.
"$PSQL" "$TARGET_URL" -Atq -c "
  select format('select setval(%L, coalesce((select max(%I) from %I.%I), 0) + 1, false);',
                s.seq, a.attname, n.nspname, c.relname)
    from pg_class sc
    join pg_depend d on d.objid = sc.oid and d.deptype = 'a'
    join pg_class c on c.oid = d.refobjid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
    cross join lateral (select n.nspname || '.' || sc.relname as seq) s
   where sc.relkind = 'S' and n.nspname in ('public','auth');
" | "$PSQL" "$TARGET_URL" -v ON_ERROR_STOP=1 -q

echo "==> verifying"
for t in "${TABLES[@]}"; do
  src=$("$PSQL" "$SOURCE_URL" -Atqc "select count(*) from $t")
  dst=$("$PSQL" "$TARGET_URL" -Atqc "select count(*) from $t")
  printf '  %-34s source %-6s target %-6s %s\n' "$t" "$src" "$dst" \
    "$( [ "$src" = "$dst" ] && echo OK || echo MISMATCH )"
done

echo
echo "Next: node scripts/link-firebase-users.mjs   (dry run, then --apply)"
