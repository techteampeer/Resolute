#!/usr/bin/env bash
# =====================================================================
# Disposable PostgreSQL 15 verification of the GCP database package
# =====================================================================
#   bash gcp/test/run.sh            # needs docker, psql, node + services/api deps
#   KEEP=1 bash gcp/test/run.sh     # leave the container running afterwards
#
# Starts a throwaway postgres:15 container bound to 127.0.0.1 on a random port
# with random passwords, and NEVER talks to anything else: every PG*
# variable inherited from the caller is unset first, so a stray PGHOST cannot
# point this at a real database. resolute_live is never contacted.
#
# Cloud SQL is emulated where it matters: the schema is built and owned by
# `cloudsql_owner` -- LOGIN CREATEROLE CREATEDB, NOT a superuser, exactly the
# attributes Cloud SQL gives its built-in user -- and the app connects as the
# NOINHERIT `resolute_app` login. The superuser is used only for the steps a
# Cloud SQL operator cannot do themselves (creating the BYPASSRLS service_role)
# and for creating databases/roles that model the platform.
#
# Two schema shapes:
#   prod     every supabase migration EXCEPT the four resolute_live lacks
#            (ADR 0003 / B4 "Still open"); the target functions are absent
#   lineage  every migration (the Supabase lineage on main); they are present
#
# THE ORDER IS THE POINT: each database is seeded with populated, production-
# shaped data (identities.sql + fixtures.sql) BEFORE the migration runs, the
# data is fingerprinted before and after, and the verification suite refuses
# to run against an empty orders table. A copy with NO orders is migrated too,
# to prove that the suite then exits nonzero instead of "passing".
#
# Exit: 0 everything passed, 1 something failed, 2 could not set up.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gcp="$(dirname "$here")"
repo="$(dirname "$gcp")"
MIGRATION="$gcp/migrations/20261124000000_charge_and_client_functions.sql"
# The four migrations resolute_live does not carry (docs/specs/B4, "Still open").
NOT_IN_PROD="20261104000000_admin_create_client.sql 20261105000000_resolve_order_charge.sql 20261105010000_profile_client_code_fk.sql 20261117000000_charge_notifications.sql"

# ── never inherit a connection ─────────────────────────────────────────────
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE \
      PGPASSFILE PGOPTIONS PGSSLMODE DATABASE_URL DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME \
      APP_USER CONFIRM_DATABASE RESOLUTE_CHANGE_APPROVAL RESOLUTE_PROTECTED_DBS

die() { echo "run.sh: $*" >&2; exit 2; }
command -v docker >/dev/null || die "docker is required"
command -v psql >/dev/null || die "psql is required"
command -v node >/dev/null || die "node is required"
[ -d "$repo/services/api/node_modules/pg" ] || die "services/api dependencies missing: npm ci --prefix services/api"

IMAGE="${GCP_TEST_PG_IMAGE:-postgres:15}"
NAME="resolute-gcp-test-$$-$RANDOM"
rnd() { od -An -N12 -tx1 /dev/urandom | tr -d ' \n'; }
SUPER_PW="$(rnd)"
OWNER_PW="$(rnd)"
APP_PW="app'$(rnd)"     # a quote on purpose: bootstrap.sh must set it safely
REVIEW_PW="$(rnd)"
OUT_PW="$(rnd)"
WORK="$(mktemp -d)"

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: container $NAME left running on 127.0.0.1:${PORT:-?} (superuser platform_admin / $SUPER_PW)"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting $IMAGE as $NAME (127.0.0.1, random port)"
docker run -d --name "$NAME" -e POSTGRES_USER=platform_admin -e POSTGRES_PASSWORD="$SUPER_PW" \
  -e POSTGRES_DB=postgres -p 127.0.0.1::5432 "$IMAGE" >/dev/null || die "docker run failed"
PORT=""
for _ in $(seq 1 30); do
  PORT="$(docker port "$NAME" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://')"
  [ -n "$PORT" ] && break; sleep 1
done
[ -n "$PORT" ] || die "no port mapping"
export PGHOST=127.0.0.1 PGPORT="$PORT"

as_super() { PGUSER=platform_admin PGPASSWORD="$SUPER_PW" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
as_owner() { PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
val() { local db="$1"; shift; PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" psql -X -Atq -v ON_ERROR_STOP=1 -d "$db" -c "$*"; }

for _ in $(seq 1 60); do as_super -d postgres -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
ver="$(as_super -d postgres -Atc 'show server_version_num')" || die "server never became ready"
[ "${ver:0:2}" = 15 ] || die "expected PostgreSQL 15 (production is 15), got $ver"
echo "==> PostgreSQL $(as_super -d postgres -Atc 'show server_version') ready on 127.0.0.1:$PORT"

# ── result bookkeeping ─────────────────────────────────────────────────────
PASS=0; FAIL=0; LAST_OUT=""; LAST_RC=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | tail -30 | sed 's/^/        | /'; }
run() { LAST_OUT="$("$@" 2>&1)"; LAST_RC=$?; }
# expect <exit|nonzero> <description> <command...>
expect() {
  local want="$1" desc="$2"; shift 2
  run "$@"
  if [ "$want" = nonzero ]; then
    if [ "$LAST_RC" -ne 0 ]; then ok "$desc (exit $LAST_RC)"; else bad "$desc (expected a nonzero exit, got 0)" "$LAST_OUT"; fi
  elif [ "$LAST_RC" -eq "$want" ]; then ok "$desc"
  else bad "$desc (expected exit $want, got $LAST_RC)" "$LAST_OUT"; fi
}
says() { if grep -qE -- "$2" <<<"$LAST_OUT"; then ok "$1"; else bad "$1 (output lacks /$2/)" "$LAST_OUT"; fi; }
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected: $3"$'\n'"got:      $2"; fi; }
section() { printf '\n── %s ──\n' "$1"; }

# Everything an existing customer row lives in, hashed. Equal before and after
# the migration == the migration modified no existing data.
fingerprint() {
  val "$1" "select md5(string_agg(t, '|' order by t)) from (
      select 'orders '   || md5(coalesce(string_agg(x::text, ',' order by x.id), ''))  t from public.orders x
      union all select 'clients '  || md5(coalesce(string_agg(x::text, ',' order by x.code), '')) from public.clients x
      union all select 'profiles ' || md5(coalesce(string_agg(x::text, ',' order by x.id), ''))  from public.profiles x
      union all select 'events '   || md5(coalesce(string_agg(x::text, ',' order by x.id), ''))  from public.order_events x
      union all select 'outbox '   || md5(coalesce(string_agg(x::text, ',' order by x.id), ''))  from public.notification_outbox x
      union all select 'prefs '    || md5(coalesce(string_agg(x::text, ',' order by x.profile_id, x.type_key), '')) from public.notification_preferences x
      union all select 'identity ' || md5(coalesce(string_agg(x::text, ',' order by x.id), ''))  from auth.users x
      union all select 'vendors '  || md5(coalesce(string_agg(x::text, ',' order by x.code), '')) from public.vendors x
    ) s"
}
targets_present() {
  val "$1" "select count(*) from pg_proc where oid in (
      to_regprocedure('public.resolve_order_charge(text,text,text)'),
      to_regprocedure('public.admin_create_client(text,text,text)'),
      to_regprocedure('public.gcp_raise_order_charge(text,text,numeric)'),
      to_regprocedure('public.gcp_resolve_order_charge(text,text,text)'))"
}
bootstrap() { # db migrations_dir
  ADMIN_USER=cloudsql_owner PGPASSWORD="$OWNER_PW" DB_USER=resolute_app DB_PASS="$APP_PW" \
    DB_NAME="$1" BUCKET_NAME=gcp-test-bucket MIGRATIONS_DIR="$2" bash "$gcp/bootstrap.sh"
}
preflight() { PGUSER="${PF_USER:-cloudsql_owner}" PGPASSWORD="${PF_PW:-$OWNER_PW}" PGDATABASE="$1" bash "$gcp/preflight.sh" "${@:2}"; }
migrate_raw() { PGUSER="${M_USER:-cloudsql_owner}" PGPASSWORD="${M_PW:-$OWNER_PW}" psql -X -q -d "$1" "${@:2}" -f "$MIGRATION"; }
new_db() { as_super -d postgres -c "create database \"$1\" owner cloudsql_owner ${2:+template \"$2\"}"; }
drop_db() { as_super -d postgres -c "drop database if exists \"$1\" with (force)" >/dev/null; }
it() { # db shape
  DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_NAME="$1" DB_USER=resolute_app DB_PASSWORD="$APP_PW" \
    GCP_IT_OWNER_USER=cloudsql_owner GCP_IT_OWNER_PASSWORD="$OWNER_PW" GCP_IT_SHAPE="$2" \
    node "$repo/services/api/__tests__/gcp-migration.integration.mjs"
}
existing_it() { # db file
  DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_NAME="$1" DB_USER=resolute_app DB_PASSWORD="$APP_PW" \
    node "$repo/services/api/__tests__/$2"
}

# ── 1. the platform: what Cloud SQL provides, and what only a superuser can ─
section "platform (Cloud SQL emulation)"
as_super -d postgres -c "create role cloudsql_owner login password '$OWNER_PW' createrole createdb nosuperuser nobypassrls" \
  || die "could not create cloudsql_owner"
ok "cloudsql_owner: LOGIN CREATEROLE CREATEDB, not superuser (Cloud SQL's built-in user attributes)"

new_db resolute_gcp_test_noservice >/dev/null || die "create database"
expect nonzero "bootstrap as a non-superuser stops when service_role cannot be created WITH BYPASSRLS" \
  bootstrap resolute_gcp_test_noservice "$repo/supabase/migrations"
says "  ... with the prerequisite spelled out" "cannot create service_role WITH BYPASSRLS"
drop_db resolute_gcp_test_noservice

as_super -d postgres -c "create role service_role nologin bypassrls" || die "service_role"
ok "service_role NOLOGIN BYPASSRLS created by the platform admin (production prerequisite)"

expect 64 "bootstrap.sh refuses resolute_live before connecting (port 1, nothing listening)" \
  env PGPORT=1 ADMIN_USER=x PGPASSWORD=x DB_USER=resolute_app DB_PASS=x DB_NAME=RESOLUTE_LIVE BUCKET_NAME=b bash "$gcp/bootstrap.sh"
says "  ... naming the rule" "refusing to run against protected database"

# ── 2. build both shapes with the reconstructed bootstrap ──────────────────
section "build (gcp/bootstrap.sh as cloudsql_owner)"
mkdir -p "$WORK/prod-migrations"
for f in "$repo"/supabase/migrations/*.sql; do
  case " $NOT_IN_PROD " in *" $(basename "$f") "*) continue ;; esac
  ln -s "$f" "$WORK/prod-migrations/$(basename "$f")"
done
n_all=$(ls "$repo"/supabase/migrations/*.sql | wc -l); n_prod=$(ls "$WORK"/prod-migrations/*.sql | wc -l)
same "production shape = all migrations minus the four resolute_live lacks" "$n_prod" "$((n_all - 4))"

new_db resolute_gcp_test_prod >/dev/null || die "create database"
expect 0 "prod shape: bootstrap + $n_prod migrations + post-migrate, all on PostgreSQL 15, no superuser" \
  bootstrap resolute_gcp_test_prod "$WORK/prod-migrations"
says "  ... storage stand-in let every migration apply" "done \($n_prod migrations\)"
same "prod shape lacks the four target functions (like resolute_live)" "$(targets_present resolute_gcp_test_prod)" 0

new_db resolute_gcp_test_lineage >/dev/null || die "create database"
expect 0 "lineage shape: bootstrap + all $n_all migrations + post-migrate" \
  bootstrap resolute_gcp_test_lineage "$repo/supabase/migrations"

run env PGUSER=resolute_app PGPASSWORD="$APP_PW" psql -X -Atq -d resolute_gcp_test_prod \
  -c "begin" -c "set local role service_role" -c "select 'lookup ok'" -c "commit"
says "the app login (password with a quote) can SET ROLE service_role -- every sign-in needs it" "lookup ok"

# An untouched copy, for the empty-orders test: schema + identities, no orders.
new_db resolute_gcp_test_empty resolute_gcp_test_prod >/dev/null || die "create database"
# Another, for the account-administration authorization suite (section 9).
new_db resolute_gcp_test_accounts resolute_gcp_test_prod >/dev/null || die "create database"

# ── 3. seed populated data BEFORE any migration ────────────────────────────
section "seed (identities + populated orders, before migrating)"
for db in resolute_gcp_test_prod resolute_gcp_test_lineage; do
  expect 0 "$db: GCP test identities + production-shaped orders" \
    sh -c "PGUSER=cloudsql_owner PGPASSWORD='$OWNER_PW' psql -X -q -v ON_ERROR_STOP=1 -d $db -f '$here/identities.sql' -f '$here/fixtures.sql'"
done
expect 0 "resolute_gcp_test_empty: identities only (no orders)" \
  as_owner -d resolute_gcp_test_empty -f "$here/identities.sql"
same "prod shape now holds populated orders" "$(val resolute_gcp_test_prod "select (count(*) >= 40)::text from public.orders")" true

# ── 4. read-only preflight ─────────────────────────────────────────────────
section "preflight (read-only)"
fp0="$(fingerprint resolute_gcp_test_prod)"
cat0="$(val resolute_gcp_test_prod "select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' order by 1)) from pg_proc p where p.pronamespace = 'public'::regnamespace")"
expect 0 "preflight (pre) passes on the prod shape" preflight resolute_gcp_test_prod
says "  ... and reports the four target functions as missing" "public.gcp_resolve_order_charge.*missing -- the migration creates it"
says "  ... and counts the real orders (owner bypasses RLS)" "OK +data +orders +4[0-9] *$"
same "preflight changed no data" "$(fingerprint resolute_gcp_test_prod)" "$fp0"
same "preflight changed no function" "$(val resolute_gcp_test_prod "select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' order by 1)) from pg_proc p where p.pronamespace = 'public'::regnamespace")" "$cat0"
run env PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" PGOPTIONS="-c default_transaction_read_only=on" \
  psql -X -q -d resolute_gcp_test_prod -c "update public.clients set name = name where false"
says "the session preflight.sh opens refuses writes" "read-only transaction"

as_super -d postgres -c "create role gcp_reviewer login password '$REVIEW_PW'" >/dev/null
PF_USER=gcp_reviewer PF_PW="$REVIEW_PW" expect 0 "preflight as a no-privilege reviewer still completes (catalog only)" \
  preflight resolute_gcp_test_prod
says "  ... and says counts are UNVERIFIED instead of reporting RLS-filtered zeros" "UNVERIFIED: RLS filters orders"

expect 0 "preflight on the empty copy completes" preflight resolute_gcp_test_empty
says "  ... and flags the empty orders table as vacuous" "EMPTY: any data-level verification"

# ── 5. the migration refuses what it must (on throwaway copies) ────────────
section "guarded migration: refusals"
scratch() { drop_db gcp_scratch; new_db gcp_scratch resolute_gcp_test_prod >/dev/null; }

scratch; fps="$(fingerprint gcp_scratch)"
expect 0 "no -v apply: runs fully, then rolls back" migrate_raw gcp_scratch
says "  ... and says so" "DRY RUN -- rolled back"
same "  ... leaving no function behind" "$(targets_present gcp_scratch)" 0
expect nonzero "apply=true without confirm_db is refused" migrate_raw gcp_scratch -v apply=true
says "  ... naming the confirmation" "needs -v confirm_db=gcp_scratch"
expect nonzero "apply=true with the WRONG confirm_db is refused" migrate_raw gcp_scratch -v apply=true -v confirm_db=resolute_live
same "  ... and nothing was created" "$(targets_present gcp_scratch)" 0
same "  ... and no data changed" "$(fingerprint gcp_scratch)" "$fps"

as_owner -d gcp_scratch -c "create function public.resolve_order_charge(p_order_id text, p_charge_id text, p_decision text) returns void language plpgsql security definer set search_path = public as \$\$ begin null; end \$\$"
expect nonzero "a DRIFTED existing definition aborts the run" migrate_raw gcp_scratch -v apply=true -v confirm_db=gcp_scratch
says "  ... naming it" "existing definition differs.*resolve_order_charge"
same "  ... atomically: the other three were not created" "$(targets_present gcp_scratch)" 1

scratch
as_owner -d gcp_scratch -c "create function public.admin_create_client(p text) returns jsonb language sql as \$\$ select '{}'::jsonb \$\$"
expect nonzero "a conflicting overload aborts the run" migrate_raw gcp_scratch -v apply=true -v confirm_db=gcp_scratch
says "  ... naming it" "conflicting overload public.admin_create_client\(text\)"

scratch
as_owner -d gcp_scratch -c "drop function public.intake_resolve_client(text,text,text) cascade"
expect 2 "preflight FAILs when a dependency is missing" preflight gcp_scratch
says "  ... naming it" "FAIL .*function public.intake_resolve_client\(text,text,text\) +missing"
expect nonzero "the migration refuses the same database" migrate_raw gcp_scratch -v apply=true -v confirm_db=gcp_scratch
says "  ... listing the unmet prerequisite" "missing function public.intake_resolve_client"

scratch
as_owner -d gcp_scratch -c "alter table public.orders force row level security"
expect nonzero "FORCE RLS on orders (definer functions would see nothing) is refused" \
  migrate_raw gcp_scratch -v apply=true -v confirm_db=gcp_scratch
says "  ... with the reason" "FORCE ROW LEVEL SECURITY"

scratch
as_super -d postgres -c "create role gcp_outsider login password '$OUT_PW'" >/dev/null
as_super -d gcp_scratch -c "grant create on database gcp_scratch to gcp_outsider" >/dev/null
M_USER=gcp_outsider M_PW="$OUT_PW" expect nonzero "a role that is not the table owner cannot install the functions" \
  migrate_raw gcp_scratch -v apply=true -v confirm_db=gcp_scratch
says "  ... with the reason" "not a member of cloudsql_owner"
same "  ... and nothing was created" "$(targets_present gcp_scratch)" 0
drop_db gcp_scratch

expect 2 "migrate.sh refuses to run a supabase/migrations file against Cloud SQL" \
  env PGDATABASE=resolute_gcp_test_prod bash "$gcp/migrate.sh" "$repo/supabase/migrations/20261105000000_resolve_order_charge.sql"
expect 2 "migrate.sh --apply without CONFIRM_DATABASE is refused" \
  env PGDATABASE=resolute_gcp_test_prod bash "$gcp/migrate.sh" --apply "$MIGRATION"
expect 2 "migrate.sh --apply on a protected database without an approval reference is refused (before connecting)" \
  env PGPORT=1 PGDATABASE=resolute_live CONFIRM_DATABASE=resolute_live bash "$gcp/migrate.sh" --apply "$MIGRATION"
says "  ... naming what is missing" "RESOLUTE_CHANGE_APPROVAL"

# ── 6. apply over populated data ───────────────────────────────────────────
section "guarded migration: apply over populated data"
m() { PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" PGDATABASE="$1" CONFIRM_DATABASE="${CONFIRM:-}" bash "$gcp/migrate.sh" "${@:2}" "$MIGRATION"; }
types0="$(val resolute_gcp_test_prod "select count(*) from public.notification_types")"
expect 0 "migrate.sh dry run (preflight + rolled-back run)" m resolute_gcp_test_prod
same "  ... created nothing" "$(targets_present resolute_gcp_test_prod)" 0
same "  ... changed no data" "$(fingerprint resolute_gcp_test_prod)" "$fp0"

CONFIRM=resolute_gcp_test_prod expect 0 "migrate.sh --apply (preflight, dry run, apply, post-check)" m resolute_gcp_test_prod --apply
says "  ... created all four" "gcp_raise_order_charge\(text,text,numeric\)=create.*gcp_resolve_order_charge\(text,text,text\)=create.*resolve_order_charge\(text,text,text\)=create"
says "  ... and the post-check passed" "preflight phase post -- 0 FAIL"
same "all four target functions now present" "$(targets_present resolute_gcp_test_prod)" 4
same "no existing customer data was modified (orders, clients, profiles, events, outbox, identities ...)" \
  "$(fingerprint resolute_gcp_test_prod)" "$fp0"
same "exactly two notification_types rows were added" \
  "$(val resolute_gcp_test_prod "select count(*) from public.notification_types")" "$((types0 + 2))"

CONFIRM=resolute_gcp_test_prod expect 0 "re-apply is idempotent" m resolute_gcp_test_prod --apply
says "  ... every function identical" "admin_create_client\(text,text,text\)=identical, gcp_raise_order_charge\(text,text,numeric\)=identical, gcp_resolve_order_charge\(text,text,text\)=identical, resolve_order_charge\(text,text,text\)=identical"
same "  ... and still no data changed" "$(fingerprint resolute_gcp_test_prod)" "$fp0"

fpl="$(fingerprint resolute_gcp_test_lineage)"
CONFIRM=resolute_gcp_test_lineage expect 0 "lineage shape: apply where two functions already exist" m resolute_gcp_test_lineage --apply
says "  ... the existing two compare identical (no drift from the Supabase source)" "admin_create_client\(text,text,text\)=identical.*resolve_order_charge\(text,text,text\)=identical"
same "  ... no data changed" "$(fingerprint resolute_gcp_test_lineage)" "$fpl"

CONFIRM=resolute_gcp_test_empty expect 0 "the EMPTY copy migrates fine too -- which is exactly why that proves nothing" \
  m resolute_gcp_test_empty --apply

# ── 7. behaviour over populated data, as the API's own login ───────────────
section "verification suite: prod shape"
expect 0 "gcp-migration suite on the prod shape" it resolute_gcp_test_prod prodshape
printf '%s\n' "$LAST_OUT" | sed 's/^/      /'
section "verification suite: lineage shape"
expect 0 "gcp-migration suite on the lineage shape" it resolute_gcp_test_lineage lineage
printf '%s\n' "$LAST_OUT" | sed 's/^/      /'
section "verification suite: empty orders"
expect 2 "the suite REFUSES an empty orders table (exit 2) instead of passing" it resolute_gcp_test_empty prodshape
says "  ... and says why" "VACUOUS: refusing to verify"

# ── 8. existing services/api integration suites, as resolute_app ───────────
section "existing services/api integration suites (unmodified), as resolute_app"
# Exit 0 alone could hide a suite that asserted nothing; count its own checks.
existing() { # db file label
  expect 0 "$3: $2" existing_it "$1" "$2"
  local okn failn
  okn=$(grep -c '✓' <<<"$LAST_OUT"); failn=$(grep -c '\*\*\* FAIL' <<<"$LAST_OUT")
  if [ "$okn" -gt 0 ] && [ "$failn" -eq 0 ]; then ok "  ... $okn of its own checks passed, 0 failed"
  else bad "  ... its own checks: $okn passed, $failn failed" "$LAST_OUT"; fi
}
for f in charges clients documents; do
  existing resolute_gcp_test_lineage "$f.integration.mjs" lineage
done
# charges on the prod shape is the B1 §6 regression: resolute_live has no
# charge-aware notify trigger, so approval/decline mail must come from the
# API's gcp_resolve_order_charge call alone.
for f in charges clients documents; do
  existing resolute_gcp_test_prod "$f.integration.mjs" "prod shape"
done

# ── 9. account administration: production SQL, real authorization ─────────
# The auth.* account functions exactly as production defines them (verbatim
# extracts, gcp/test/account_functions.sql) on a fresh production-shaped copy,
# exercised by the reference security suite's account series plus R1
# (gcp/test/account_security.sql) through a RESTRICTED login: NOINHERIT, member
# of authenticated + anon only -- no service_role, no BYPASSRLS -- inside
# `set local role authenticated` + claims transactions, as services/api does.
section "account administration (production auth.* SQL, restricted login, RLS)"
ACCT_LOGIN=resolute_acct_app
ACCT_PW="$(rnd)"
expect nonzero "the fixture refuses to run without -v disposable_test_db=1" \
  env PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" PGOPTIONS="-c resolute.app_user=$ACCT_LOGIN" \
  psql -X -q -v ON_ERROR_STOP=1 -d resolute_gcp_test_accounts -f "$here/account_functions.sql"
expect 0 "production account functions and their dependencies applied (verbatim, reference 9d167690)" \
  env PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" PGOPTIONS="-c resolute.app_user=$ACCT_LOGIN" \
  psql -X -q -v ON_ERROR_STOP=1 -v disposable_test_db=1 -d resolute_gcp_test_accounts -f "$here/account_functions.sql"
printf '%s\n' "alter role :\"acct\" with password :'acct_pw';" \
  | PGUSER=cloudsql_owner PGPASSWORD="$OWNER_PW" psql -X -q -v ON_ERROR_STOP=1 -d resolute_gcp_test_accounts \
      -v acct="$ACCT_LOGIN" -v acct_pw="$ACCT_PW" || die "could not set the test login's password"
same "the test login is restricted: login, not superuser, no BYPASSRLS/CREATEROLE, NOINHERIT; member of authenticated + anon only" \
  "$(val resolute_gcp_test_accounts "select format('%s|%s|%s|%s|%s|%s', r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolinherit,
          (select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid))
     from pg_roles r where r.rolname = '$ACCT_LOGIN'")" \
  "t|f|f|f|f|anon,authenticated"
same "  ... and it cannot become service_role" \
  "$(val resolute_gcp_test_accounts "select pg_has_role('$ACCT_LOGIN', 'service_role', 'MEMBER')::text")" false
# The suite \connects to the restricted login itself; both passwords come from a
# throwaway pgpass file, never argv.
printf '%s\n' "127.0.0.1:$PORT:*:cloudsql_owner:$OWNER_PW" "127.0.0.1:$PORT:*:$ACCT_LOGIN:$ACCT_PW" > "$WORK/pgpass"
chmod 600 "$WORK/pgpass"
expect 0 "authorization suite: L0-L3, A1-A3, P1-P14, U1-U2 (reference) + R1" \
  env PGPASSFILE="$WORK/pgpass" PGUSER=cloudsql_owner \
  psql -X -v ON_ERROR_STOP=1 -v disposable_test_db=1 -v app_user="$ACCT_LOGIN" \
       -d resolute_gcp_test_accounts -f "$here/account_security.sql"
printf '%s\n' "$LAST_OUT" | grep -E '^ok ' | sed 's/^/      /'
missing=""
for series in O2-O4 L0 L1 L2 L3 A1 A2 A3 P1 P2 P3-P6 P7 P8 P9 P10 P11 P12 P13 P14 U1 U2 R1; do
  grep -qE "^ok  $series " <<<"$LAST_OUT" || missing="$missing $series"
done
if [ -z "$missing" ]; then ok "  ... all 22 series reported ok"; else bad "  ... series without an ok:$missing" "$LAST_OUT"; fi

# ── 10. database isolation ─────────────────────────────────────────────────
section "database isolation"
as_super -d postgres -c "create table if not exists platform_secret (v text); insert into platform_secret values ('x')" >/dev/null
run env PGUSER=resolute_app PGPASSWORD="$APP_PW" psql -X -Atq -d postgres -c "select count(*) from platform_secret"
says "the app login cannot read another database's tables" "permission denied"
run env PGUSER=resolute_app PGPASSWORD="$APP_PW" psql -X -Atq -d resolute_gcp_test_prod -c "create table public.app_owned(x int)"
says "the app login cannot create objects in the schema" "permission denied"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASSED: $PASS checks (plus the suites' own checks above)"
  exit 0
fi
echo "FAILED: $FAIL of $((PASS + FAIL)) checks"
exit 1
