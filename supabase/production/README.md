# Marsa — production database (notes)

Production is a **new, separate Supabase project** (paid plan, daily backups). Staging keeps its own project, keys and
demo data. Nothing is ever copied from staging to production.

## Install order (production project)

0. **Before the install**, Database → Extensions: enable `pg_cron` and `pg_trgm`. The migrations schedule
   `marsa_idem_purge`, `marsa_client_errors_purge` and `marsa_refresh_alerts` and build the trigram indexes only when
   the extension already exists; enabling them afterwards does neither.
1. Build the install file **from the repository** and run it once, as one transaction:
   ```sh
   python3 scripts/build-production-sql.py ~/marsa-releases/install.sql
   psql -v ON_ERROR_STOP=1 --single-transaction -f ~/marsa-releases/install.sql   # or paste it into the SQL Editor and Run
   ```
   It holds the encoding guard, an empty-database preflight, every `supabase/migrations` file, the switch
   `set_deploy_environment('production')` and post-install checks that RAISE (the whole install rolls back) on a wrong
   environment / schema version, any organization, RLS off, a missing private bucket, or pg_cron / its three jobs
   missing. Record the `size` / `sha256` it prints **from this run** (any later change to a migration changes them).
   Never paste `supabase/all_migrations.sql` (the staging bundle: no preflight, no switch) or `supabase/seed.sql` (demo
   org `blue-sea`: refused on production, `demo_org_in_production`). `supabase/make_admin.sql` is an untracked owner
   file for staging.
   The switch is SQL Editor only (no API role, not even service_role, can execute it), one-way
   (`MRS_BAD_TRANSITION production_is_one_way`), refused while a demo org or an org created as staging exists, also for
   a direct `UPDATE app.deploy_settings`; the row cannot be deleted or truncated. Re-pasting the migrations keeps
   `production`; re-pasting an older migration that re-creates `health_check` / `public_track` / `platform_create_org`
   brings back a hard-coded 'staging' body → re-paste `20261112000100_deploy_env.sql` right after (`env_body_reverted`).
2. Create the operator in Authentication → Users, run `supabase/make_platform_admin.sql`, sign in and enrol TOTP.
3. Run `post_install_checks.sql` (read-only, safe any time). Ready for real data when `blockers` is `[]`.

## Cutover: the main domain (staging lives on `https://marsacloud.com` today)

Production takes over the domain staging uses now (`docs/online/ENVIRONMENTS_AR.md` §1 / §2.3). In this order:

1. **Move staging off the main domain first**: a subdomain (e.g. `staging.marsacloud.com`, hPanel → Subdomains) with
   the staging files, its own Basic Auth `.htaccess` (copy the current one; it is not in git) and its own `robots.txt`
   (`Disallow: /`). Check it opens with the password prompt.
2. **Auth URLs** (Authentication → URL Configuration): in the STAGING project set Site URL and Redirect URLs to the
   staging subdomain (remove `https://marsacloud.com`); in the PRODUCTION project set Site URL `https://marsacloud.com`
   and Redirect URLs `https://marsacloud.com/**` (no `www.`: the production `.htaccess` redirects `www.` to the apex).
3. **Back up, then empty `public_html`** of the main domain (hPanel File Manager → select all → Compress → download the
   archive; then delete everything, including the dotfiles `.htaccess` and leftovers such as `robots.txt` / `_headers`).
   Extracting over the old files keeps whatever the release does not overwrite (the staging `robots.txt` would block
   search engines).
4. Upload the zip from `scripts/build-release.sh` and extract it into the empty `public_html`. It brings its own
   `.htaccess` (no Basic Auth) and `robots.txt` (`Allow: /`).
5. Visitors' browsers keep the old origin's data: the staging service worker cache, `localStorage` drafts and a staging
   sign-in session (`sb-<staging-ref>-auth-token`). The release's worker uses a new cache name (`…-prod`) and removes
   the old one once it activates; the staging session is ignored (another project ref). Tell testers who used staging
   on the main domain to sign out there first, or use «مسح بياناتي من هذا الجهاز» in the footer after the switch.

## What the switch changes

`health_check().environment`, `public_track().environment` and the `environment` of every **new** organization become
`production` (new orgs no longer get `settings.staging = true`). Existing rows are never rewritten
(`organizations.environment` is immutable). On production an org can never become a demo org (`settings.demo = true` /
slug `blue-sea` refused on INSERT and UPDATE).

## Backups

`scripts/backup-staging.sh` (`docs/online/BACKUP_RESTORE_AR.md` §3) is for the staging project: it refuses any other
project without `--force-other`. Production relies on the paid plan's **daily backups** (Database → Backups; check the
retention there). Before every migration on production take a manual dump as well:
`./scripts/backup-staging.sh --force-other` with the PRODUCTION connection string in `$SUPABASE_DB_URL` (read hidden,
as in the script header), stored outside the repository.

## Not covered here

Edge Function secrets, `pg_net` / Vault jobs, the front-end `assets/js/config.js` (`environment`, `orgSlug`
of the real tenant; `config.production.example.js`, written by `scripts/build-release.sh`). `post_install_checks.sql`
lists the extensions and cron jobs (never a job's command) and the messaging / Daftra connections still in mock mode.
