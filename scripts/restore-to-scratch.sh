#!/usr/bin/env bash
# =====================================================================
# Marsa — restore a backup into a LOCAL scratch database (G2.14).
# docs/online/BACKUP_RESTORE_AR.md §4. Never restores into Supabase.
#
#   ./scripts/restore-to-scratch.sh [--target URL] [--dry-run] <backup-folder>
#     <backup-folder>  a folder written by scripts/backup-staging.sh
#     --target URL     local Postgres, default $SCRATCH_DB_URL or
#                      postgresql://postgres@localhost:54329/postgres
#                      (password, if any: PGPASSWORD in the environment)
#     --dry-run        verify checksums + target and print the plan only
#
#   example throwaway server:
#     docker run --rm -d --name marsa-scratch -e POSTGRES_PASSWORD=<pick one> -p 54329:5432 postgres:15
#
# Steps: verify SHA256SUMS → refuse a non-local or non-empty target →
# supabase/tests/shim.sql (roles anon/authenticated, auth + storage stand-ins)
# → pg_restore pre-data → data → stub auth.users rows for restored profiles
# → storage metadata CSV → post-data (constraints, triggers, policies) →
# storage policies (migration 0500) → compare row counts with the backup,
# print schema version and any table without RLS.
# =====================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${SCRATCH_DB_URL:-postgresql://postgres@localhost:54329/postgres}"
DRY_RUN=0
SRC=""

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() { echo "restore-to-scratch: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) [ $# -ge 2 ] || die "--target needs a URL"; TARGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 1 ;;
    *) [ -z "$SRC" ] || die "only one backup folder"; SRC="$1"; shift ;;
  esac
done
[ -n "$SRC" ] || usage 1
[ -d "$SRC" ] || die "not a folder: $SRC"
SRC="$(cd "$SRC" && pwd -P)"
for f in public_app.dump storage_buckets.csv storage_objects.csv row_counts.txt manifest.txt SHA256SUMS; do
  [ -f "$SRC/$f" ] || die "missing $f in $SRC (not a backup-staging.sh folder?)"
done
( cd "$SRC" && shasum -a 256 -c SHA256SUMS >/dev/null ) || die "checksum mismatch in $SRC — backup is damaged"

# ---- target must be local (localhost / loopback / unix socket)
case "$TARGET" in postgres://*|postgresql://*) ;; *) die "--target must start with postgresql://" ;; esac
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
rest="${TARGET#*://}"
rest="${rest%%\?*}"
authority="${rest%%/*}"
dbname="postgres"
case "$rest" in */*) dbname="${rest#*/}"; [ -n "$dbname" ] || dbname="postgres" ;; esac
userinfo=""
hostport="$authority"
case "$authority" in *@*) userinfo="${authority%@*}"; hostport="${authority##*@}" ;; esac
t_user="${userinfo%%:*}"
t_pass=""
case "$userinfo" in *:*) t_pass="${userinfo#*:}" ;; esac
case "$hostport" in
  \[*\]*) t_host="${hostport%%]*}"; t_host="${t_host#[}"; t_port="${hostport##*]}"; t_port="${t_port#:}" ;;
  *) t_host="${hostport%%:*}"; t_port=""; case "$hostport" in *:*) t_port="${hostport##*:}" ;; esac ;;
esac
[ -n "$t_port" ] || t_port="5432"
t_host="$(printf '%s' "$t_host" | tr 'A-Z' 'a-z')"
case "$t_host" in
  ''|localhost|127.0.0.1|::1) ;;
  *) die "refusing: target host '${t_host}' is not local (localhost / 127.0.0.1 / ::1 / unix socket only)" ;;
esac
case "$t_port" in *[!0-9]*) die "invalid target port" ;; esac

echo "restore-to-scratch: backup   $SRC"
grep -E '^(created_utc|project_ref|schema_version)=' "$SRC/manifest.txt" | sed 's/^/restore-to-scratch:   /'
echo "restore-to-scratch: target   ${t_host:-unix-socket}:${t_port}/$(urldecode "$dbname") (local only)"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "restore-to-scratch: --dry-run: checksums OK, nothing was contacted or written."
  exit 0
fi

for b in psql pg_restore; do command -v "$b" >/dev/null 2>&1 || die "$b not found (macOS: brew install libpq && brew link --force libpq)"; done
# no inherited libpq overrides may redirect the connection away from the checked host
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGPASSWORD PGPORT
if [ -n "$t_host" ]; then export PGHOST="$t_host"; fi
export PGPORT="$t_port" PGDATABASE="$(urldecode "$dbname")" PGAPPNAME="marsa-restore-to-scratch"
if [ -n "$t_user" ]; then export PGUSER="$(urldecode "$t_user")"; fi
if [ -n "$t_pass" ]; then export PGPASSWORD="$(urldecode "$t_pass")"; fi
unset t_pass userinfo
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

# ---- the scratch database must be empty (we never merge into existing data)
existing="$("${PSQL[@]}" -A -t -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                     WHERE n.nspname IN ('public','app') AND c.relkind = 'r'")"
[ "$existing" = "0" ] || die "target already has ${existing} table(s) in public/app — use a fresh scratch database"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# CREATE SCHEMA public already exists in every database: drop that one TOC entry
pg_restore -l "$SRC/public_app.dump" | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA|COMMENT) - (SCHEMA )?public ' > "$TMP/toc.list"

echo "restore-to-scratch: 1/6 local stand-ins for Supabase (supabase/tests/shim.sql)"
"${PSQL[@]}" -f "$REPO/supabase/tests/shim.sql" >/dev/null
echo "restore-to-scratch: 2/6 schema (pre-data)"
pg_restore --exit-on-error --no-owner --section=pre-data -L "$TMP/toc.list" -d "$PGDATABASE" "$SRC/public_app.dump"
echo "restore-to-scratch: 3/6 data"
pg_restore --exit-on-error --no-owner --section=data -L "$TMP/toc.list" -d "$PGDATABASE" "$SRC/public_app.dump"
# auth.users is not in the backup (password hashes): stub rows so profiles' foreign key holds
"${PSQL[@]}" -c "INSERT INTO auth.users (id) SELECT p.id FROM public.profiles p ON CONFLICT (id) DO NOTHING"
echo "restore-to-scratch: 4/6 storage metadata"
"${PSQL[@]}" -c "\copy storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at) FROM '$SRC/storage_buckets.csv' WITH (FORMAT csv, HEADER true)"
"${PSQL[@]}" -c "\copy storage.objects (id, bucket_id, name, owner, metadata, created_at) FROM '$SRC/storage_objects.csv' WITH (FORMAT csv, HEADER true)"
echo "restore-to-scratch: 5/6 constraints, indexes, triggers, policies (post-data)"
pg_restore --exit-on-error --no-owner --section=post-data -L "$TMP/toc.list" -d "$PGDATABASE" "$SRC/public_app.dump"
echo "restore-to-scratch: 6/6 storage policies (migration 0500, idempotent)"
"${PSQL[@]}" -f "$REPO/supabase/migrations/20261031000500_storage.sql" >/dev/null

# ---- verification
"${PSQL[@]}" -A -t -F ' ' -o "$TMP/row_counts.txt" -c "
  SELECT table_schema || '.' || table_name,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
    FROM information_schema.tables
   WHERE table_schema IN ('public','app') AND table_type = 'BASE TABLE'
   ORDER BY 1"
STATUS=0
if diff -u "$SRC/row_counts.txt" "$TMP/row_counts.txt" > "$TMP/diff.txt"; then
  echo "restore-to-scratch: row counts identical to the backup ($(wc -l < "$SRC/row_counts.txt" | tr -d ' ') tables)"
else
  echo "restore-to-scratch: ROW COUNT MISMATCH:" >&2; cat "$TMP/diff.txt" >&2; STATUS=1
fi
echo "restore-to-scratch: schema_version $("${PSQL[@]}" -A -t -c "SELECT coalesce(max(version), 'none') FROM public.schema_versions" 2>/dev/null || echo unknown)"
no_rls="$("${PSQL[@]}" -A -t -c "SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity")"
if [ -n "$no_rls" ]; then echo "restore-to-scratch: TABLES WITHOUT RLS: $no_rls" >&2; STATUS=1; else echo "restore-to-scratch: RLS enabled on every public table"; fi
[ "$STATUS" -eq 0 ] && echo "restore-to-scratch: OK" || echo "restore-to-scratch: FAILED" >&2
exit "$STATUS"
