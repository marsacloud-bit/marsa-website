#!/usr/bin/env python3
"""Build the ONE install file for a FRESH production Supabase project (docs/online/ENVIRONMENTS_AR.md §2.4).

  python3 scripts/build-production-sql.py OUT.sql        # e.g. ~/marsa-releases/marsa-production-install.sql
  python3 scripts/build-production-sql.py --check-seed supabase/seed.sql   # detector self-test: must REFUSE

OUT.sql = encoding guard + empty-database preflight + supabase/migrations/*.sql (sorted, verbatim, each under a
'-- ===== migrations/<file> =====' marker) + "select public.set_deploy_environment('production');" + post-install
checks (they RAISE, so a bad install never looks finished; the last one needs pg_cron enabled BEFORE the run and its
three marsa_* jobs scheduled by the migrations). Never included: supabase/seed.sql (demo org 'blue-sea'),
repair_arabic.sql, make_*.sql, all_migrations.sql, tests/. Run it once, on the new project only:
  psql -v ON_ERROR_STOP=1 --single-transaction -f OUT.sql      (or paste into the SQL Editor: one transaction)
Refuses (exit 1, nothing written) when a migration seeds demo data: an INSERT into organizations naming 'blue-sea'
or an INSERT into auth.users. A migration that must not reach production is listed in EXCLUDED below with its
reason; it is skipped loudly (stdout + the OUT.sql header), never silently. Reads only local files; no network."""
import hashlib, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
MIG_DIR = os.path.join(ROOT, 'supabase', 'migrations')
DEMO_SLUG = 'blue-sea'
# file name → reason. Empty: no migration seeds demo data (checked on every run). Adding a file here also drops its
# schema_versions row, so only a file that later migrations do not build on may be listed.
EXCLUDED = {}
MIG_NAME = re.compile(r'^(\d{14})_([a-z0-9_]+)\.sql$')
SET_ENV = "select public.set_deploy_environment('production');"

def die(msg):
    sys.exit('build-production-sql: ' + msg)

def strip_comments(sql):
    # '--' line comments only (block comments are not used in the migrations); string literals keep their text
    return re.sub(r"--[^\n]*", '', sql)

def demo_seeds(sql):
    """Statements that would put demo data into a database: [(line, text)]."""
    body = strip_comments(sql)
    hits = []
    pats = [r"\bINSERT\s+INTO\s+(?:public\.)?organizations\b[^;]*?'" + re.escape(DEMO_SLUG) + "'",
            r"\bINSERT\s+INTO\s+auth\.users\b"]
    for p in pats:
        for m in re.finditer(p, body, re.I | re.S):
            hits.append((body.count('\n', 0, m.start()) + 1, ' '.join(m.group(0).split())[:100]))
    return hits

def slug_refs(sql):
    """Other (non-seed) mentions of the demo slug, e.g. the orgSlug fallback of the public RPCs: line numbers."""
    body = strip_comments(sql)
    return [body.count('\n', 0, m.start()) + 1 for m in re.finditer("'" + re.escape(DEMO_SLUG) + "'", body)]

GUARD = """DO $guard$
BEGIN
  -- stops immediately if the Arabic text was pasted with the wrong encoding
  IF 'جديد' <> U&'\\062C\\062F\\064A\\062F' THEN
    RAISE EXCEPTION 'ENCODING ERROR: Arabic text was pasted incorrectly (not UTF-8). Nothing was changed.';
  END IF;
END $guard$;
"""

PREFLIGHT = """-- empty-database preflight: this file is a FIRST install only (never the staging project, never twice)
DO $pf$
BEGIN
  IF to_regclass('public.schema_versions') IS NOT NULL OR to_regclass('public.organizations') IS NOT NULL
     OR to_regnamespace('app') IS NOT NULL THEN
    RAISE EXCEPTION 'MRS_PREFLIGHT: this database already has the Marsa schema. The production install file runs on a NEW, empty project only. Nothing was changed.';
  END IF;
END $pf$;
"""

def post_checks(versions, last):
    vlist = ', '.join("'" + v + "'" for v in versions)
    return f"""-- =====================================================================
-- post-install checks (RAISE on any failure → the whole install rolls back when run as one transaction)
-- =====================================================================
DO $post$
DECLARE
  v_h jsonb := public.health_check();
  v_missing text;
  v_n int;
BEGIN
  IF v_h ->> 'environment' IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'POST-INSTALL: health_check().environment = % (expected production)', v_h ->> 'environment';
  END IF;
  IF v_h ->> 'schema_version' IS DISTINCT FROM '{last}' THEN
    RAISE EXCEPTION 'POST-INSTALL: health_check().schema_version = % (expected {last})', v_h ->> 'schema_version';
  END IF;
  SELECT string_agg(x, ', ') INTO v_missing FROM unnest(ARRAY[{vlist}]) x
   WHERE NOT EXISTS (SELECT 1 FROM public.schema_versions s WHERE s.version = x);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POST-INSTALL: schema_versions misses %', v_missing; END IF;
  -- no tenant at all: the production organization is created afterwards by the owner (create_organization)
  SELECT count(*) INTO v_n FROM public.organizations;
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST-INSTALL: % organization(s) exist after install (expected none; demo seed?)', v_n; END IF;
  SELECT count(*) INTO v_n FROM auth.users;
  IF v_n <> 0 THEN RAISE WARNING 'POST-INSTALL: % auth user(s) already exist (expected none on a new project)', v_n; END IF;
  SELECT string_agg(c.relname, ', ') INTO v_missing FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POST-INSTALL: RLS is off on public.%', v_missing; END IF;
  SELECT string_agg(b, ', ') INTO v_missing FROM unnest(ARRAY['documents','finance','messages']) b
   WHERE NOT EXISTS (SELECT 1 FROM storage.buckets s WHERE s.id = b AND NOT s.public);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POST-INSTALL: private storage bucket(s) missing: %', v_missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_trgm') THEN
    RAISE WARNING 'POST-INSTALL: pg_trgm is not enabled (search uses the btree fallback; enable it BEFORE the install)';
  END IF;
  -- last: the migrations schedule their jobs only when pg_cron already exists (Database → Extensions → pg_cron first)
  IF NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_cron') THEN
    RAISE EXCEPTION 'POST-INSTALL: pg_cron is not enabled. Enable it (Database → Extensions → pg_cron), then run this file again. Nothing was changed.';
  END IF;
  EXECUTE $q$SELECT string_agg(x, ', ') FROM unnest(ARRAY['marsa_idem_purge', 'marsa_client_errors_purge', 'marsa_refresh_alerts']) x
             WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = x AND j.active)$q$ INTO v_missing;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'POST-INSTALL: pg_cron job(s) missing: %', v_missing; END IF;
  RAISE NOTICE 'POST-INSTALL OK: %', v_h;
END $post$;

SELECT public.health_check();
"""

def check_seed(path):
    hits = demo_seeds(open(path, encoding='utf-8').read())
    if hits:
        for ln, t in hits: print(f'REFUSED  {os.path.relpath(path, ROOT)}:{ln}  {t}')
        sys.exit(1)
    print('no demo seed found in ' + os.path.relpath(path, ROOT))

def main(argv):
    if len(argv) == 2 and argv[0] == '--check-seed':
        return check_seed(argv[1])
    if len(argv) != 1 or argv[0].startswith('-'):
        die('usage: build-production-sql.py OUT.sql   |   build-production-sql.py --check-seed FILE.sql')
    out = os.path.abspath(os.path.expanduser(argv[0]))
    if out == ROOT or out.startswith(ROOT + os.sep):
        die('write OUT.sql outside the repository (e.g. ~/marsa-releases/)')

    names = sorted(os.listdir(MIG_DIR))
    files, refused, skipped, refs = [], [], [], []
    for n in names:
        if not n.endswith('.sql'): continue
        m = MIG_NAME.match(n)
        if not m: die('unexpected file in supabase/migrations: ' + n)
        if n.startswith('make_') or n in ('seed.sql', 'repair_arabic.sql'): die('owner / seed file in migrations: ' + n)
        sql = open(os.path.join(MIG_DIR, n), encoding='utf-8').read()
        if n in EXCLUDED:
            skipped.append((n, EXCLUDED[n])); continue
        for ln, t in demo_seeds(sql): refused.append(f'{n}:{ln}  {t}')
        refs += [f'{n}:{ln}' for ln in slug_refs(sql)]
        files.append((m.group(1), n, sql))
    for n in EXCLUDED:
        if n not in names: die('EXCLUDED names a missing migration: ' + n)
    if refused:
        die("demo seed data in migrations (list the file in EXCLUDED with a reason, or remove the INSERT):\n  "
            + '\n  '.join(refused))
    if not files: die('no migrations found')
    if not any(re.search(r'FUNCTION\s+public\.set_deploy_environment\s*\(', s, re.I) for _, _, s in files):
        die('no migration defines public.set_deploy_environment(text): apply the environment migration first')

    versions = [v for v, _, _ in files]
    last = versions[-1]
    parts = [
        "-- Marsa PRODUCTION: first install of a NEW, empty Supabase project (generated by scripts/build-production-sql.py;\n"
        "-- edit the migrations, never this file). Run ONCE: psql -v ON_ERROR_STOP=1 --single-transaction -f <this file>,\n"
        "-- or paste into the SQL Editor and Run. Contains every supabase/migrations file up to " + last + " and NO seed:\n"
        "-- no demo organization, no users. Ends with set_deploy_environment('production') + post-install checks.\n"
        "-- Excluded migrations: " + (', '.join(f'{n} ({r})' for n, r in skipped) or 'none') + "\n",
        GUARD, PREFLIGHT]
    for _, n, sql in files:
        parts.append(f'-- ===== migrations/{n} =====\n' + sql.rstrip('\n') + '\n')
    parts.append('-- ===== production environment =====\n' + SET_ENV + '\n')
    parts.append(post_checks(versions, last))
    data = '\n'.join(parts).encode('utf-8')

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'wb') as f: f.write(data)
    print(f'wrote {out}')
    print(f'  migrations: {len(files)} ({versions[0]} … {last}); excluded: {len(skipped)}')
    for n, r in skipped: print(f'  EXCLUDED {n}: {r}')
    if refs:
        print(f"  note: '{DEMO_SLUG}' still appears outside seeds (code, not data: orgSlug fallbacks / demo-org guards): " + ', '.join(refs))
    print(f'  size:   {len(data)} bytes')
    print(f'  sha256: {hashlib.sha256(data).hexdigest()}')

if __name__ == '__main__':
    main(sys.argv[1:])
