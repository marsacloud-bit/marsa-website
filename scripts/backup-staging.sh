#!/usr/bin/env bash
# =====================================================================
# Marsa — STAGING backup (G2.14). docs/online/BACKUP_RESTORE_AR.md §3
#
# Dumps schemas public + app (schema + data, custom format) and the storage
# METADATA (storage.buckets / storage.objects rows as CSV; the files
# themselves stay in Supabase Storage) of the STAGING project.
#
#   read -rs SUPABASE_DB_URL && export SUPABASE_DB_URL   # hidden, not in history
#   ./scripts/backup-staging.sh [--out DIR] [--dry-run] [--force-other]
#   unset SUPABASE_DB_URL
#
# Safety:
#   - The connection URL is read from $SUPABASE_DB_URL only. It is never
#     printed, never written to disk and never put on a command line (it is
#     split into PG* environment variables for libpq).
#   - Refuses any project other than the staging ref in assets/js/config.js
#     unless --force-other is given.
#   - Output goes OUTSIDE the repository (default ~/marsa-backups), directory
#     mode 700, files mode 600. auth.users is NOT dumped (password hashes).
#   - --dry-run checks everything and prints the plan without connecting.
# Needs pg_dump / psql >= the project's Postgres major version.
# =====================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_BASE="${MARSA_BACKUP_DIR:-$HOME/marsa-backups}"
DRY_RUN=0
FORCE_OTHER=0

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() { echo "backup-staging: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT_BASE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force-other) FORCE_OTHER=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

# ---- staging project ref, from the front-end config (single source of truth)
CONFIG="$REPO/assets/js/config.js"
[ -f "$CONFIG" ] || die "cannot find $CONFIG"
STAGING_REF="$(sed -n "s#.*supabaseUrl:[[:space:]]*'https://\([a-z0-9]\{1,40\}\)\.supabase\.co'.*#\1#p" "$CONFIG" | head -n 1)"
[ -n "$STAGING_REF" ] || die "no staging project ref found in assets/js/config.js (supabaseUrl)"

# ---- parse $SUPABASE_DB_URL into libpq environment variables (never echoed)
[ -n "${SUPABASE_DB_URL:-}" ] || die "SUPABASE_DB_URL is not set (read -rs SUPABASE_DB_URL && export SUPABASE_DB_URL)"
url="$SUPABASE_DB_URL"
case "$url" in
  postgres://*|postgresql://*) ;;
  *) die "SUPABASE_DB_URL must start with postgresql://" ;;
esac
# libpq URI rules: only %XX is decoded; '+' and backslashes stay literal (never printf %b on raw input)
urldecode() {
  local s="$1" out="" h
  while [ -n "$s" ]; do
    case "$s" in
      %[0-9A-Fa-f][0-9A-Fa-f]*) h="${s:1:2}"; out+="$(printf "\\x$h")"; s="${s:3}" ;;
      *) out+="${s:0:1}"; s="${s:1}" ;;
    esac
  done
  printf '%s' "$out"
}
rest="${url#*://}"
query=""
case "$rest" in *\?*) query="${rest#*\?}"; rest="${rest%%\?*}" ;; esac
authority="${rest%%/*}"
dbname="postgres"
case "$rest" in */*) dbname="${rest#*/}"; [ -n "$dbname" ] || dbname="postgres" ;; esac
userinfo=""
hostport="$authority"
case "$authority" in *@*) userinfo="${authority%@*}"; hostport="${authority##*@}" ;; esac
db_user="${userinfo%%:*}"
db_pass=""
case "$userinfo" in *:*) db_pass="${userinfo#*:}" ;; esac
db_host="${hostport%%:*}"
db_port="5432"
case "$hostport" in *:*) db_port="${hostport##*:}" ;; esac
db_host="$(printf '%s' "$db_host" | tr 'A-Z' 'a-z')"
[ -n "$db_host" ] || die "SUPABASE_DB_URL has no host"
case "$db_port" in ''|*[!0-9]*) die "SUPABASE_DB_URL has an invalid port" ;; esac

# ---- refuse anything that is not the staging project
is_staging=0
if [ "$db_host" = "db.${STAGING_REF}.supabase.co" ]; then
  is_staging=1
else
  case "$db_host" in
    *.pooler.supabase.com) [ "$db_user" = "postgres.${STAGING_REF}" ] && is_staging=1 ;;
  esac
fi
if [ "$is_staging" -ne 1 ]; then
  [ "$FORCE_OTHER" -eq 1 ] || die "refusing: SUPABASE_DB_URL is not the staging project (${STAGING_REF}). Use --force-other only with a written owner decision."
  echo "backup-staging: WARNING --force-other: host ${db_host} is not the staging project ${STAGING_REF}" >&2
fi

# ---- output directory: must be outside the repository (checked before anything is created)
resolve_dir() {   # physical path of $1, or of its existing parent + basename
  if [ -d "$1" ]; then (cd "$1" && pwd -P)
  else
    local parent; parent="$(dirname "$1")"
    [ -d "$parent" ] || die "parent folder of --out does not exist: $parent"
    echo "$(cd "$parent" && pwd -P)/$(basename "$1")"
  fi
}
OUT_BASE="$(resolve_dir "$OUT_BASE")"
REPO_REAL="$(cd "$REPO" && pwd -P)"
case "$OUT_BASE/" in "$REPO_REAL"/*) die "refusing: output directory is inside the repository ($OUT_BASE)" ;; esac
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ "$is_staging" -eq 1 ]; then OUT="$OUT_BASE/marsa-staging-${STAMP}"; else OUT="$OUT_BASE/marsa-OTHER-${STAMP}"; fi

echo "backup-staging: project ref   ${STAGING_REF}$([ "$is_staging" -eq 1 ] || echo ' (NOT matched: --force-other)')"
echo "backup-staging: host          ${db_host}:${db_port} (password not shown)"
echo "backup-staging: output        ${OUT}"
echo "backup-staging: contents      public + app (schema + data), storage.buckets / storage.objects metadata (CSV)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "backup-staging: --dry-run: nothing was contacted or written."
  exit 0
fi

command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found (macOS: brew install libpq && brew link --force libpq)"
command -v psql >/dev/null 2>&1 || die "psql not found"

# no inherited libpq overrides may redirect the connection away from the checked host
unset PGHOSTADDR PGSERVICE PGSERVICEFILE
export PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$(urldecode "$dbname")" PGUSER="$(urldecode "$db_user")"
export PGPASSWORD="$(urldecode "$db_pass")"
export PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}" PGAPPNAME="marsa-backup-staging"
case "$query" in *sslmode=*) PGSSLMODE="$(printf '%s' "$query" | sed -n 's/.*sslmode=\([a-z-]*\).*/\1/p')"; export PGSSLMODE ;; esac
unset SUPABASE_DB_URL url userinfo db_pass authority rest

mkdir -p "$OUT_BASE"
chmod 700 "$OUT_BASE"
mkdir "$OUT"
chmod 700 "$OUT"
cleanup_on_error() { echo "backup-staging: FAILED — partial output left in $OUT (delete it)" >&2; }
trap cleanup_on_error ERR

echo "backup-staging: pg_dump $(pg_dump --version | awk '{print $NF}') …"
pg_dump --format=custom --no-owner --schema=public --schema=app --file="$OUT/public_app.dump"

psql -X -q -v ON_ERROR_STOP=1 -c "\copy (SELECT id, name, public, file_size_limit, allowed_mime_types, created_at FROM storage.buckets ORDER BY id) TO '$OUT/storage_buckets.csv' WITH (FORMAT csv, HEADER true)"
psql -X -q -v ON_ERROR_STOP=1 -c "\copy (SELECT id, bucket_id, name, owner, metadata, created_at FROM storage.objects ORDER BY bucket_id, name) TO '$OUT/storage_objects.csv' WITH (FORMAT csv, HEADER true)"

# exact row counts (restore-to-scratch.sh compares against these)
psql -X -A -t -q -v ON_ERROR_STOP=1 -F ' ' -o "$OUT/row_counts.txt" -c "
  SELECT table_schema || '.' || table_name,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
    FROM information_schema.tables
   WHERE table_schema IN ('public','app') AND table_type = 'BASE TABLE'
   ORDER BY 1"
SCHEMA_VERSION="$(psql -X -A -t -q -c "SELECT coalesce(max(version), 'none') FROM public.schema_versions" 2>/dev/null || echo 'unknown (no schema_versions)')"

{
  echo "marsa backup"
  echo "created_utc=${STAMP}"
  echo "project_ref=$([ "$is_staging" -eq 1 ] && echo "$STAGING_REF" || echo "OTHER:${db_host}")"
  echo "schema_version=${SCHEMA_VERSION}"
  echo "pg_dump=$(pg_dump --version)"
  echo "files=public_app.dump storage_buckets.csv storage_objects.csv row_counts.txt (checksums: SHA256SUMS)"
} > "$OUT/manifest.txt"
( cd "$OUT" && shasum -a 256 public_app.dump storage_buckets.csv storage_objects.csv row_counts.txt > SHA256SUMS )
chmod 600 "$OUT"/*
trap - ERR

echo "backup-staging: OK — schema_version ${SCHEMA_VERSION}"
ls -l "$OUT"
echo "backup-staging: record the folder name and schema_version in the release notes."
