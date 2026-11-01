# G2 completion — implementation spec (staging)

Source plan: `Marsa_Cloud_Sequential_Execution_Plan` §G2 steps 1–15. Existing design: `docs/online/ARCHITECTURE.md` (read §1–4, §9, §15 and the Security review section first).
Everything here is **staging only** (`organizations.environment = 'staging'`). No production, no real e-mail/WhatsApp sending, no secrets in the repo.

## What already exists (do not rebuild)
organizations / branches / profiles / memberships (user × org × optional branch × role), RLS on every table with `app.is_member / has_role / has_branch_role / is_staff`, column grants (0700), append-only `audit_log` + `transaction_events`, private `documents` bucket with path policy, server refs (`app.next_ref`), admin RPCs `admin_list_members / admin_add_member / admin_set_member_active` (0650), email/password auth with reset (`assets/js/auth.js`), `my_context()`.
Baseline tests: `NODE_PATH=/tmp/pgtest/node_modules node supabase/tests/rls-tests.js --quiet` → 545 pass / 0 fail / 2 warn.

## Conventions (must follow)
- New migrations: `supabase/migrations/20261102000X00_<name>.sql`, additive, re-runnable (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS), header comment in the style of existing files.
- Every `public.*` RPC: `SECURITY DEFINER SET search_path = ''`, first line checks `auth.uid()` (unless deliberately anon), errors only via `app.fail('MRS_<CODE>', '<field>')`, `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` then `GRANT EXECUTE … TO authenticated` (and anon only where stated).
- Changing an existing RPC's signature: `DROP FUNCTION IF EXISTS public.f(<old args>)` first (PostgREST overload ambiguity), recreate, re-grant.
- New tables: RLS enabled, `REVOKE ALL … FROM anon`, audit trigger (`app.tg_audit`) when they hold business state, add to the RLS test catalog (`TENANT_TABLES` / expected RPC lists in `supabase/tests/rls-tests.js`).
- Never take a role from signup metadata. Never reveal whether an e-mail has an account.
- Front end: static HTML/JS, no build. Every `MarsaApi` call returns `{data, error}` and never throws. Script order: `config.js → i18n.js → [assets/i18n/<page>.js] → main.js → supa.js → <page>.js`, all `defer` (page dictionary right after i18n.js, so main.js already sees it).
- Arabic is the default UI; RTL. Code comments in English, matching existing density.

## Idempotency (G2.13) — DONE in `20261102000100_idempotency.sql`
`app.idem_begin(scope, key uuid, payload jsonb, org uuid default null) → jsonb|null` (NULL = do the work; non-NULL = stored response with `replayed:true`; a key is bound to its first user AND org), `app.idem_finish(scope, key, response) → response`, `app.idem_key_from(payload) → uuid` (reads `payload.idempotencyKey`). Errors: `MRS_IDEMPOTENCY_CONFLICT` (same key, different payload/user, or expired), `MRS_IN_PROGRESS`.
Usage pattern inside an RPC:
```sql
v_replay := app.idem_begin('create_org', p_idem_key, p_payload);
IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
... work ...
RETURN app.idem_finish('create_org', p_idem_key, v_result);
```
Secrets returned once (invite tokens, tracking tokens) must NOT be stored in `response`: store the response without the secret and on replay return `{…, token: null, replayed: true, token_shown: true}` — the UI then tells the user the link was already shown and offers "re-issue".

## Roles (G2.7)
| Plan role | Implementation |
|---|---|
| مدير المنصة platform admin | new `public.platform_admins(user_id pk → profiles, note, created_at)`; rows only via SQL Editor (`supabase/make_platform_admin.sql`); `app.is_platform_admin()`. Manages organizations only — **no implicit read of tenant operational data**. |
| مدير المؤسسة org admin | membership role `admin` with `branch_id IS NULL` (enforce: CHECK `role <> 'admin' OR branch_id IS NULL`). |
| مدير الفرع branch manager | **new role `branch_manager`**, `branch_id NOT NULL` required (CHECK). Everywhere `operations_manager` is allowed today, `branch_manager` is allowed too (limited to its branch by `has_branch_role`). Plus: manages members/invitations of its own branch for roles `clearance_staff, transport_staff, accountant` and client-portal invitations. |
| موظف staff | existing staff roles |
| عميل client | existing `client` + `client_users` |
Multi-membership already works in the DB; the UI gets an active-org switcher.

## Organizations, branches, invitations (G2.3–G2.7) — migration `20261102000200_orgs_branches_invites.sql`
RPCs (all return jsonb):
- `platform_list_orgs()` → `[{id, slug, name_ar, name_en, ref_prefix, environment, is_active, default_locale, created_at, branches, members, admins, admin_emails_masked, pending_admin_invitations}]` — platform admin only (admin e-mails masked `a***@domain`).
- `platform_create_org(p_payload jsonb)` — payload `{slug, name_ar, name_en?, ref_prefix, default_locale?, branch:{code, name_ar, name_en?, city?}, admin_email, idempotencyKey}` → creates org (environment forced `'staging'`), first branch, and an **admin invitation**; returns `{org_id, slug, branch_id, invitation_id, token, accept_path}`.
- `platform_set_org_active(p_org uuid, p_active boolean)` — suspend/reactivate. Staff helpers ignore inactive orgs; G2 also makes `app.my_client_ids()` (client portal), `public_track` and `my_context().clients` ignore them.
- `admin_update_org(p_org uuid, p_payload jsonb)` — org admin; whitelist: `name_ar, name_en, default_locale, public_intake_enabled, settings.{brand_color (#rrggbb), contact_phone, contact_email, address_ar, address_en, logo_path}`; validate each; unknown keys → `MRS_INVALID`.
- `admin_create_branch(p_org uuid, p_payload jsonb)` / `admin_update_branch(p_branch uuid, p_payload jsonb)` — org admin; fields `code, name_ar, name_en, city, is_active`; code immutable after create; cannot deactivate the last active branch (`MRS_FORBIDDEN 'last_branch'`).
- `public.invitations(id, org_id, email (lowercased), role, branch_id, client_id, token_hash, invited_by, expires_at default +7 days, accepted_at, accepted_by, revoked_at, revoked_by, created_at, updated_at)`; composite FKs `(branch_id, org_id)` / `(client_id, org_id)`; one pending invitation per (org, email, role, branch, client); audit trigger; SELECT policy: org admin (all of org), branch_manager (own branch); no direct writes.
- `admin_invite(p_org uuid, p_payload jsonb)` — payload `{email, role, branch_id?, client_id?, idempotencyKey}`; role `client` requires `client_id`; `branch_manager` requires branch; `admin` forbids branch; who may invite what = Roles table above. A branch manager's client-portal invitation is limited to clients with ≥1 transaction / branch-assigned request, all in branches it manages (`app.bm_client_in_scope`, else `MRS_FORBIDDEN 'client'`), and a non-admin may not invite its own e-mail (`MRS_FORBIDDEN 'email'` — the only `auth.users` read is the caller's own row, so still no oracle). Returns `{invitation_id, email, role, expires_at, token, accept_path:'login.html?invite=<token>'}` — token 256-bit hex, only SHA-256 stored. Does **not** look at `auth.users` (no account oracle).
- `admin_list_invitations(p_org uuid)`, `admin_revoke_invitation(p_invitation uuid)`, `admin_reissue_invitation(p_invitation uuid)` (new token, old one dead; the re-issuer becomes `invited_by`).
- Inviter authority is re-checked at preview / accept time (`app.invitation_authorized`): platform-created admin invite, or `invited_by` still an active org admin, or still the active branch_manager of that branch (staff) / of the client's branches (client). Otherwise `MRS_NOT_FOUND`, like a revoked one. Self-invitations of non-admins → `MRS_FORBIDDEN 'self_invite'`.
- `platform_reissue_admin_invitation(p_org uuid)` — platform admin; only while the org has no active admin; rotates the platform-created pending admin invitation → `{org_id, invitation_id, email, expires_at, token, accept_path}`.
- `invitation_preview(p_token text)` — **anon + authenticated**; returns only `{org_name_ar, org_name_en, role, role_label_ar, role_label_en, branch_name_ar, email_masked, expires_at}`; uniform `MRS_NOT_FOUND` for unknown/expired/revoked/accepted.
- `accept_invitation(p_token text)` — authenticated; caller's `auth.users.email` must equal the invitation email (case-insensitive) and be confirmed (`email_confirmed_at IS NOT NULL`; add that column to `supabase/tests/shim.sql` auth.users); creates/reactivates the membership (or `client_users` link for client invites); marks accepted; idempotent for the same user (second call returns the same result).
- `admin_add_member`: **revoke EXECUTE from authenticated** (keeps working from SQL Editor only) — closes the account-existence oracle (current WARN in rls-tests). UI uses invitations.
- `admin_list_members(p_org)` / `admin_set_member_active(p_membership, p_active)`: allow branch_manager for its own branch's lower roles; keep self/last-admin guards (serialized on the organization row). Deactivation cuts data access immediately (RLS reads `is_active` every query): a `client` membership also switches off its `client_users` links (reactivation restores the invited ones), and the user's pending invitations in the org (addressed to it / issued by it and no longer backed) are revoked → `invitations_revoked`. Branch-scoped memberships of an inactive branch do not count (`is_member / has_role / has_branch_role`).
- `my_context()` adds `is_platform_admin` and `organizations:[{org_id, slug, name_ar, name_en, roles[]}]` (keep existing keys unchanged).
- New error codes: `MRS_EXPIRED`, `MRS_EMAIL_MISMATCH`, `MRS_EMAIL_UNCONFIRMED`, `MRS_IDEMPOTENCY_CONFLICT`, `MRS_IN_PROGRESS`, `MRS_UNKNOWN_RESULT` (front end only).

## Idempotency rollout + observability + restore (G2.9, G2.12–G2.14) — migration `20261102000300_ops_observability.sql`
- Apply idempotency to: `submit_service_request` + `submit_contact_message` (key in payload `idempotencyKey`; tracking token not stored → on replay return ref + `token:null, token_shown:true`), `convert_request_to_transaction` (new optional last param `p_idem_key uuid DEFAULT NULL`; DROP old signature first), `set_transaction_status` / `set_financial_status` (optional `p_idem_key`), `issue_tracking_token` (optional key, secret not stored).
- `public.schema_versions(version text pk, name, applied_at)` — every new migration (including 0100/0200/0300) inserts its row `ON CONFLICT DO NOTHING`; backfill the existing 9 versions.
- `health_check()` — anon + authenticated → `{ok:true, db_time, schema_version (max), environment:'staging'}`; nothing tenant-specific.
- `public.client_errors(id bigserial, org_id, user_id, page, code, message, ua, created_at)` + `log_client_error(p_payload jsonb)` anon + authenticated: truncate fields (message 500, page 200, ua 200), scrub e-mails / phone numbers / long digit runs / JWT-looking strings, rate limit (≤ 20 per user-or-visitor per 10 min, ≤ 300 for all visitors together and ≤ 500 global → silently drop, return `{logged:false}`; visitor = `cf-connecting-ip` / `x-real-ip` / right-most `X-Forwarded-For` hop, never the client-controlled left-most one), never raises for bad input except size. Read: `admin_recent_errors(p_org)` (org admin) and `platform_recent_errors()` (platform admin).
- `admin_audit_log(p_org uuid, p_filters jsonb)` — org admin (and supervisor, as today's audit_select policy) paginated reader: filters `table_name, actor, from, to, row_id, limit ≤ 200, before_id` → rows with actor email.
- Restore drill: `supabase/tests/restore-drill.js` (PGlite): build schema + seed + sample data for two orgs, take a physical backup (`db.dumpDataDir()`), restore into a fresh PGlite, compare per-table row counts and an md5 of ordered rows for every public table, re-run a short RLS sanity subset on the restored DB, print PASS/FAIL. Plus `scripts/backup-staging.sh` (pg_dump of public+app+storage metadata using `$SUPABASE_DB_URL` from the environment, never written to disk in the repo; refuses to run if URL host is not the staging project ref `cgzhidyxfpksfckwmauq` unless `--force-other`) and `scripts/restore-to-scratch.sh` (restore a dump into a *local* Postgres/scratch DB only).

## Front end
### i18n (G2.11) — `assets/js/i18n.js` (stub exists; replace)
```
MarsaI18n.register(ns, {ar:{k:'…'}, en:{k:'…'}})   // keys become 'ns.k'
MarsaI18n.t('ns.k', {var:…})                        // lang → ar → key fallback; {var} interpolation
MarsaI18n.lang() 'ar'|'en'   .dir() 'rtl'|'ltr'
MarsaI18n.setLang(l)        // html[lang,dir], localStorage 'marsa_lang', re-apply, dispatch window 'marsa:langchange'
MarsaI18n.apply(root?)      // [data-i18n="ns.k"] → textContent; [data-i18n-html] → innerHTML (trusted dict only);
                            // [data-i18n-attr="placeholder:ns.k;title:ns.k;aria-label:ns.k"]
MarsaI18n.label(domain, code, row?) // status_labels: row.label_ar/label_en by lang, else dictionary 'label.<domain>.<code>'
MarsaI18n.fmtDate(d, {time?}) fmtNumber(n, {digits?}) fmtMoney(n, currency='SAR')  // Intl, latin digits
```
Initial lang: `localStorage.marsa_lang` → `MARSA_CONFIG.defaultLocale` → `'ar'`. Must set `html[lang,dir]` synchronously as early as possible to avoid a flash. Language switcher button in the shared header (`[data-lang-toggle]`). Logged-in users: `MarsaApi.setMyLocale(l)` stores `profiles.locale` (UI calls it if present).
Dictionaries: shared chrome in `i18n.js` (`common.*`, `nav.*`, `footer.*`, `banner.*`, `err.*` for every MRS_* code); page dictionaries in `assets/i18n/<page>.js`.
CSS: LTR must not break layout — convert physical left/right to logical properties (or add `[dir="ltr"]` overrides) in `assets/css/style.css` and page CSS.

### MarsaApi additions (`assets/js/supa.js`)
`newIdemKey()`; idempotent wrappers keep the key across retries: on network/timeout error retry up to 2× with the **same** key, then return `{error:{code:'MRS_UNKNOWN_RESULT'}}` (Arabic message: the result is not confirmed; retrying is safe and will not duplicate). Pages keep the key until a definite answer.
`platformListOrgs, platformCreateOrg(payload), platformSetOrgActive(id, active), updateOrg(orgId, payload), createBranch(orgId, payload), updateBranch(id, payload), invite(orgId, payload), listInvitations(orgId), revokeInvitation(id), reissueInvitation(id), invitationPreview(token), acceptInvitation(token), auditLog(orgId, filters), recentErrors(orgId), healthCheck(), setMyLocale(l), signOutEverywhere(), activeOrgId(), setActiveOrg(id)` (localStorage `marsa_active_org`, validated against `my_context`; `orgId()` uses it). Global `window.onerror` / `unhandledrejection` → `log_client_error` (deduped per message, max 5 per page load, online mode only). New `MRS_*` Arabic messages in `i18n.ar` inside supa.js **and** `err.*` keys.

### Pages
- `platform.html` + `assets/js/platform.js` + `assets/css/pages/platform.css` + `assets/i18n/platform.js`: platform admin console — org list, create org form (shows the admin invite link once with copy button), suspend/reactivate, recent client errors, health check. Non-platform users see an access-denied state.
- `admin.html` / `admin.js`: new tabs — المؤسسة (org settings/identity), الفروع (list/add/edit/deactivate), الأعضاء والدعوات (members incl. branch_manager; invite form returns copyable link; list/revoke/reissue pending invitations; deactivate/reactivate member), سجل التدقيق (filters + pagination), أخطاء الواجهة. Active-org switcher in the header when the user has >1 staff org. Keep every existing feature working.
- `login.html` / `auth.js`: `?invite=<token>` → show preview (org, role, masked e-mail); if signed in → accept button; else sign in / sign up with the invited e-mail then accept automatically after sign-in. "Sign out of all devices" in account area (portal/admin header).
- Nav: link to `platform.html` only for platform admins (hidden otherwise; protection is server-side anyway).

## Environments, repo, docs (G2.1, G2.2, G2.14)
`.gitignore` (env files, dumps, `*.local.*`, `node_modules`, `.DS_Store`), `CONTRIBUTING.md` (branches: `online-staging` → feature branches → PR; migration rules; tests to run), `.github/pull_request_template.md`, `assets/js/config.example.js` (documented keys; config.js keeps only the public anon key), `docs/online/ENVIRONMENTS_AR.md` (dev/local-PGlite, staging, future production; secrets handling; Hostinger deploy + rollback by keeping the previous release zip), `docs/online/BACKUP_RESTORE_AR.md`, `docs/online/G2_REPORT_AR.md` (G2 steps 1–15 → status, evidence, test numbers, open owner decisions), ARCHITECTURE.md updated (roles matrix with branch_manager + platform admin, new tables/RPCs, error codes).

## Two-org proof (G2.15)
`supabase/tests/g2-tests.js` (PGlite, same harness style as rls-tests.js): platform admin creates org B through `platform_create_org`, accepts the invite, creates branches, invites a branch_manager and staff, creates comparable clients/transactions/documents in both orgs; then every unauthorized path is attempted: cross-org reads on every tenant table, every public RPC called with the other org's ids, storage object read across orgs, branch_manager outside its branch, deactivated member immediately loses access, revoked/expired/foreign-email invitations, idempotent replays (no duplicate rows), platform admin cannot read tenant operational data.

## As built (2026-11-02) — real deviations from the text above
Only where the implementation differs from a line above that was not reworded. Details and test numbers: `docs/online/G2_REPORT_AR.md`.
- `admin_invite` / "Does **not** look at `auth.users`": it reads the **caller's own** `auth.users` row (to refuse self-invites by non-admins). The invitee's e-mail is never looked up, so there is still no account oracle.
- Roles table, "everywhere `operations_manager` is allowed, `branch_manager` is allowed too": except `client_users` INSERT/UPDATE (a portal link opens transactions in every branch). Branch managers link portal users only through `admin_invite` for clients wholly inside their branch(es).
- Test catalog: only `invitations` was added to `TENANT_TABLES`. `idempotency_keys`, `platform_admins`, `schema_versions`, `client_errors` are in a new `NO_API_TABLES` list, checked for zero `anon` / `authenticated` privileges (they carry no API-readable tenant rows to isolate).
- `MarsaApi.addMembership` is kept for compatibility but returns `MRS_FORBIDDEN 'invite'` without a server call.
- Language switcher: shown only on pages with a page dictionary (`<html data-i18n-page>`: index, login, admin, platform). Other pages render Arabic/RTL for that view (the saved choice is kept) and get no toggle.
- `20261102000200` ends with a guard that drops the 3-argument `set_transaction_status` when the 4-argument one (from 0300) exists, so re-running 0200 alone is safe.
- Not delivered in G2 (outside this spec, listed as known limits): server-side upload hash/size verification (Edge Function), e-mail delivery of invitations, MFA, external health alerting.
