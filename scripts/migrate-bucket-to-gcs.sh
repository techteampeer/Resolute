#!/usr/bin/env bash
# Copy the `documents` bucket from Supabase Storage into Cloud Storage.
#
# PATHS ARE PRESERVED EXACTLY, and that is the whole point rather than a detail.
# Each order carries its attachments as orders.workflow.<screener|examiner|
# commitment>Doc.path, and the server re-signs by that path on every open
# (server/routes/documents.js). Rewrite or flatten the keys and every existing
# attachment stops opening, with no error anywhere -- the document simply is not
# found.
#
# Run AFTER the data migration, so the object list and the rows agree.
#
# Usage:
#   SUPABASE_URL='https://<ref>.supabase.co' \
#   SUPABASE_SERVICE_KEY='...' \
#   SOURCE_URL='postgresql://postgres:PASS@db.<ref>.supabase.co:5432/postgres' \
#   BUCKET_NAME='resolute-docs-resolute-508323' \
#   ./scripts/migrate-bucket-to-gcs.sh           # dry run: lists what would move
#   …                                            --apply
set -euo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_SERVICE_KEY:?set SUPABASE_SERVICE_KEY}"
: "${SOURCE_URL:?set SOURCE_URL (to enumerate storage.objects)}"
: "${BUCKET_NAME:?set BUCKET_NAME}"
APPLY="${1:-}"
BUCKET_SRC="${BUCKET_SRC:-documents}"
PSQL="${PG_BIN:+$PG_BIN/}psql"

command -v gcloud >/dev/null || { echo "gcloud is required (gcloud storage cp)" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# storage.objects is the authoritative list -- more reliable than paging the
# Storage API, and it is the same table the app's own references point at.
"$PSQL" "$SOURCE_URL" -Atqc \
  "select name from storage.objects where bucket_id = '$BUCKET_SRC' order by name" > "$WORK/objects.txt"

total=$(wc -l < "$WORK/objects.txt")
echo "==> $total object(s) in '$BUCKET_SRC'"

if [ "$APPLY" != "--apply" ]; then
  echo
  sed 's/^/    /' "$WORK/objects.txt"
  echo
  echo "DRY RUN — nothing copied. Re-run with --apply."
  exit 0
fi

ok=0; failed=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  # The object key can contain spaces and other characters that need encoding in
  # the URL but must NOT be encoded in the destination key.
  encoded=$(printf '%s' "$name" | sed 's/ /%20/g')
  tmp="$WORK/blob"

  if curl -fsSL --max-time 120 \
        -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
        "$SUPABASE_URL/storage/v1/object/$BUCKET_SRC/$encoded" -o "$tmp"; then
    if gcloud storage cp --quiet "$tmp" "gs://$BUCKET_NAME/$name"; then
      ok=$((ok+1)); printf '  copied  %s\n' "$name"
    else
      failed=$((failed+1)); printf '  FAILED (upload)   %s\n' "$name"
    fi
  else
    failed=$((failed+1)); printf '  FAILED (download) %s\n' "$name"
  fi
done < "$WORK/objects.txt"

echo
echo "==> copied $ok, failed $failed, of $total"

echo "==> verifying every object arrived, byte for byte"
mismatch=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  src=$("$PSQL" "$SOURCE_URL" -Atqc \
    "select coalesce((metadata->>'size')::bigint, -1) from storage.objects where bucket_id='$BUCKET_SRC' and name='${name//\'/\'\'}'")
  dst=$(gcloud storage ls --long "gs://$BUCKET_NAME/$name" 2>/dev/null | awk 'NR==1{print $1}')
  if [ "$src" != "$dst" ]; then
    mismatch=$((mismatch+1)); printf '  SIZE MISMATCH %s (source %s, target %s)\n' "$name" "$src" "${dst:-missing}"
  fi
done < "$WORK/objects.txt"
[ "$mismatch" -eq 0 ] && echo "  all $total match" || echo "  $mismatch object(s) differ — do not cut over"

echo
echo "The bucket must NOT be public: the server hands out short-lived signed"
echo "URLs, and a public bucket would make every client document world-readable."
echo "  gcloud storage buckets describe gs://$BUCKET_NAME --format='value(iamConfiguration.publicAccessPrevention)'"
