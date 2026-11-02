# MFA (TOTP) — required for org admins and platform admins (staging spec)

Branch `online-staging`. Builds on G7 (`20261108000100_g7_subscriptions.sql`). Supabase Auth MFA, factor type `totp`
(already enabled on the Supabase project). No new external dependency, no network in tests, no deploy by any agent,
no git commit / push / branch switch, `supabase/make_admin.sql` is never touched or staged.

**Goal.** A session whose JWT claim `aal` is not `aal2` gets **no** org-admin privilege (`memberships.role = 'admin'`)
and **no** platform-admin privilege (`public.platform_admins`). Every other role is unaffected. `public.my_context()`
keeps working at `aal1` and reports the MFA state so the UI can force a challenge or an enrollment. TOTP stays
optional (allowed) for every other signed-in user.

---

## 1. Design in one paragraph

All authorization in the DB funnels through a handful of SECURITY DEFINER helpers that read `public.memberships`
for `auth.uid()` (`app.is_member`, `app.has_role`, `app.has_branch_role`; everything else — `app.is_staff`,
`app.has_tx_role`, `app.has_request_role`, `app.can_read_transaction`, `app.can_manage_member`,
`app.can_manage_invitation`, `app.can_see_profile`, `app.can_read_batch`, `app.fin_*`, `app.msg_*`, RLS policies,
storage policies — calls those three), plus `app.rpt_scope` (G6a, reads memberships directly) and
`app.is_platform_admin()` (every `platform_*` RPC). The migration re-creates exactly these five functions with one
extra predicate: **an `admin` membership row counts only when the session is `aal2`**, and the platform-admin row
counts only when the session is `aal2`. Nothing else in the schema changes. To give a clear error to a caller who
hits a guarded RPC directly, `app.fail()` rewrites `MRS_FORBIDDEN` / `MRS_NOT_FOUND` to `MRS_MFA_REQUIRED` **only**
when the caller is "MFA-pending" (needs MFA, session not `aal2`). `my_context()` gains an additive `mfa` object.

### 1.1 Mixed roles (decision)
Enforcement is **per membership row**, not per user:
- admin in org A + `clearance_staff` in org M, at `aal1`: org A gives nothing (not even `is_member`), org M works
  exactly as before.
- admin + accountant rows in the **same** org at `aal1`: the accountant row still works (accountant powers only).
- The **UI** enforces per user: `my_context().mfa.required` is true as soon as the user holds any active admin
  membership (active org) or a platform-admin row, so every app page sends that user to the challenge / enrollment
  screen before anything else. Rationale: server-side stays the narrowest possible change (no non-admin behaviour
  changes for anyone), while the user experience never shows half-working admin screens.

### 1.2 Missing `aal` claim (decision)
Real Supabase access tokens always carry `aal`. A missing / empty claim is treated as `aal1` (fail closed).
Tests: `supabase/tests/shim.sql` `auth.jwt()` injects `"aal":"aal2"` when the claims have `sub` but no `aal`
(so the 22 existing suites keep their exact baseline with **zero** edits to their JWT minting); setting the GUC
`marsa_test.default_aal` to `none` disables the injection, any other value (`aal1`) is injected instead.
`mfa-tests.js` always sets `aal` explicitly or uses `none`.

---

## 2. Migration `supabase/migrations/20261109000100_mfa.sql`

Header comment in the G7 style (purpose, sections, "replaces these 6 functions + my_context", re-runnable,
down-path = re-paste `20261102000200` bodies is **not** recommended, see §8). Then:

```sql
SELECT set_config('lock_timeout', '5s', true);

-- P. preflight (read-only): G7 must be applied
DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261108000100') THEN
    RAISE EXCEPTION 'MFA preflight: apply G7 first (schema_versions lacks 20261108000100 g7_subscriptions)';
  END IF;
  IF to_regclass('auth.mfa_factors') IS NULL THEN
    RAISE EXCEPTION 'MFA preflight: auth.mfa_factors not found (Supabase Auth MFA schema missing)';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261109000100', 'mfa')
ON CONFLICT (version) DO NOTHING;
```

No table, no column, no policy, no trigger, **no new public function** (rls-tests' "188 documented public RPCs"
and the anon / authenticated catalog checks stay green unchanged).

### 2.1 New app helpers (all `SET search_path = ''`, fully-qualified names)

| function | lang / security | body |
|---|---|---|
| `app.mfa_gated_roles() RETURNS text[]` | sql IMMUTABLE | `SELECT ARRAY['admin']` (single place to extend later, e.g. `branch_manager`) |
| `app.session_aal() RETURNS text` | sql STABLE, invoker | `SELECT coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1')` |
| `app.mfa_ok() RETURNS boolean` | sql STABLE, invoker | `SELECT app.session_aal() = 'aal2'` |
| `app.mfa_factor_verified(p_uid uuid) RETURNS boolean` | sql STABLE **SECURITY DEFINER** | `SELECT p_uid IS NOT NULL AND EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = p_uid AND f.factor_type::text = 'totp' AND f.status::text = 'verified')` (casts: Supabase uses enums `auth.factor_type` / `auth.factor_status`) |
| `app.mfa_required_for(p_uid uuid) RETURNS boolean` | sql STABLE **SECURITY DEFINER** | `p_uid IS NOT NULL AND (EXISTS active membership with role = ANY(app.mfa_gated_roles()) in an active org [branch rule as has_role] OR EXISTS platform_admins row)` |
| `app.mfa_required_reasons(p_uid uuid) RETURNS jsonb` | sql STABLE **SECURITY DEFINER** | array of `'org_admin'` / `'platform_admin'` (same two predicates; `'[]'` when none) |
| `app.mfa_pending() RETURNS boolean` | sql STABLE **SECURITY DEFINER** | `SELECT auth.uid() IS NOT NULL AND NOT app.mfa_ok() AND app.mfa_required_for(auth.uid())` |

Privileges: `REVOKE ALL ON FUNCTION <each> FROM PUBLIC, anon, authenticated;` then
`GRANT EXECUTE ON FUNCTION app.mfa_pending(), app.mfa_ok(), app.session_aal(), app.mfa_gated_roles() TO authenticated, service_role;`
(`app.fail` runs as the invoker in invoker triggers, so `mfa_pending` must be executable by the caller; the others
are only reached from SECURITY DEFINER bodies but are harmless booleans). `mfa_factor_verified`,
`mfa_required_for`, `mfa_required_reasons` get **no** API grant (they take an arbitrary uid).

### 2.2 Functions re-created (bodies copied from their latest definition + the MFA predicate)

Predicate `MFA_ROW` = `AND (NOT (m.role = ANY (app.mfa_gated_roles())) OR app.mfa_ok())`

| function | latest body in | change |
|---|---|---|
| `app.is_member(uuid)` | `20261102000200` §2b | add `MFA_ROW` (an admin-only member at aal1 is not a member) |
| `app.has_role(uuid, text[])` | `20261102000200` §2b | add `MFA_ROW` |
| `app.has_branch_role(uuid, uuid, text[])` | `20261102000200` §2b | add `MFA_ROW` |
| `app.rpt_scope(uuid, text[])` | `20261106000100` | add `MFA_ROW` to **both** sub-selects (org-wide EXISTS and the branch array) |
| `app.is_platform_admin()` | `20261102000200` §5 | `... AND app.mfa_ok() AND EXISTS (... platform_admins ...)` |
| `app.fail(text, text)` | `20261031000300` §2 | see below |
| `public.my_context()` | `20261102000200` §13 | see §3 |

Language, volatility, SECURITY DEFINER and `SET search_path = ''` identical to the originals; existing GRANT /
REVOKE re-asserted identically after the re-create (CREATE OR REPLACE keeps ACLs; re-asserting is for a DB where
someone re-pasted an older file).

**Not changed (deliberately):** `app.uid_has_branch_role`, `app.bm_client_in_scope`, `app.invitation_authorized`
(they judge the **inviter's** standing by uid, not the current session — an invitation issued by an admin at aal2
stays valid), `app.my_client_ids` (client role, never gated), `admin_set_member_active` last-admin checks (target
rows, not the caller), G7 counters.

`app.fail` new body:
```sql
CREATE OR REPLACE FUNCTION app.fail(p_code text, p_detail text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_code IN ('MRS_FORBIDDEN', 'MRS_NOT_FOUND') AND app.mfa_pending() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MRS_MFA_REQUIRED', DETAIL = 'aal2';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = coalesce(p_detail, '');
END $$;
```
Safe: the rewrite depends only on the caller's own state (no oracle about other tenants); for every user who does
not need MFA, or who is at aal2, `app.fail` behaves exactly as before; service-role / anon calls have
`auth.uid()` NULL → unchanged. Only error paths pay the extra lookup.

### 2.3 Known coverage limits (documented, accepted)
- Plain RLS denials (empty result sets, Postgres `42501`) cannot carry a code; the UI gate on `my_context().mfa`
  is the primary user experience, the error rewrite is for direct RPC callers.
- Re-pasting `20261102000200` / `20261106000100` / `20261031000300` after this migration silently restores the
  pre-MFA bodies → `MFA_AR.md` says: after re-pasting any older file, re-paste `20261109000100_mfa.sql`
  (re-runnable). `mfa-tests.js` proves the re-paste restores enforcement.

---

## 3. `my_context()` shape additions (additive only; every existing key unchanged)

Works at `aal1` (it never calls `has_role`; `MRS_AUTH_REQUIRED` when signed out, as today).

```jsonc
{
  "user_id": "...", "profile": {...}, "clients": [...], "organizations": [...],   // unchanged
  "memberships": [ { ...unchanged keys..., "mfa_locked": true } ],   // NEW key per row: role gated AND session not aal2
  "is_platform_admin": false,       // EFFECTIVE value = app.is_platform_admin() (false at aal1)
  "mfa": {                          // NEW
    "aal": "aal1",                  // app.session_aal()
    "required": true,               // app.mfa_required_for(uid)
    "reasons": ["org_admin", "platform_admin"],   // app.mfa_required_reasons(uid)
    "enrolled": false,              // app.mfa_factor_verified(uid) (verified TOTP factor exists)
    "satisfied": false              // NOT required OR aal = 'aal2'
  }
}
```
`memberships` / `organizations` still list admin rows at aal1 (the UI must know what the user will get after the
challenge); `mfa_locked` marks them. Front end treats a missing `mfa` key (migration not yet applied) as
`{required:false, satisfied:true}` → front end can ship before the migration (§9 rollout).

---

## 4. Shim + test-helper changes (DB owner)

`supabase/tests/shim.sql`:
1. `auth.jwt()` default-aal injection (§1.2):
```sql
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c ? 'sub' AND NOT c ? 'aal'
                   AND coalesce(nullif(current_setting('marsa_test.default_aal', true), ''), 'aal2') <> 'none'
              THEN c || jsonb_build_object('aal', coalesce(nullif(current_setting('marsa_test.default_aal', true), ''), 'aal2'))
              ELSE c END
  FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb c) x
$$;
```
2. Minimal `auth.mfa_factors` (created before migrations, because sql-language helper bodies are validated at
   CREATE time):
```sql
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, friendly_name text,
  factor_type text NOT NULL DEFAULT 'totp', status text NOT NULL DEFAULT 'unverified',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
```
   No grant to anon / authenticated (as on Supabase).

`supabase/tests/g7-subscriptions-tests.js` (only existing suite needing an edit): it requires G7 to be the
latest file. Minimal edit: replace the "G7 migration is the latest" stop with
`const LATER = migFiles.filter(f => f > G7_MIGRATION)`; load `migFiles.filter(f => f < G7_MIGRATION)` before,
and after `secPreflightAndApply()` run each `LATER` file (abort on failure) before `fixtures()`. All its checks
(including "re-creates no pre-G7 function" and `health_check` = `20261108000100`) run before `LATER` is loaded and
stay unchanged. Every other suite loads all files sorted → gets MFA with default `aal2` → identical baseline.
`g2-ops-tests` health_check "latest schema version" automatically becomes `20261109000100` (max of rows).

`supabase/all_migrations.sql` regenerated (same header, append the new file section, 19 versions).

---

## 5. UI flows (FRONT owner)

Supabase-js 2.45.4 API used (all through `MarsaApi` in supa.js, never called directly elsewhere):
`auth.mfa.listFactors()` (`all`, `totp` = verified), `auth.mfa.enroll({ factorType: 'totp', friendlyName })`
→ `{ id, totp: { qr_code, secret, uri } }`, `auth.mfa.challengeAndVerify({ factorId, code })`,
`auth.mfa.unenroll({ factorId })`, `auth.mfa.getAuthenticatorAssuranceLevel()` → `{ currentLevel, nextLevel }`.

### 5.1 supa.js additions
- `mfaFactors()` → `{ verified: [...], unverified: [...] }` (from `listFactors().all` by `status`).
- `mfaAal()` → `{ current, next }`.
- `mfaEnroll()`: first unenroll every **unverified** factor of the user (stale half-enrollments, friendly-name
  clashes), then `enroll({ factorType:'totp', friendlyName: 'Marsa ' + ISO timestamp })`; returns
  `{ factorId, qr, secret }` where `qr` is kept **only** if it matches `/^data:image\/svg\+xml[;,]/` (else null).
- `mfaVerify(factorId, code)` → `challengeAndVerify`; on success `ctxCache = null; ctxPending = null`.
- `mfaUnenroll(factorId)`; then `auth.refreshSession()` and drop `ctxCache`.
- `mfaState(ctx)` pure helper: `ctx.mfa || { required:false, satisfied:true, enrolled:false, aal:'aal1', reasons:[] }`.
- Error mapping in `normalizeError`: `MRS_MFA_REQUIRED` (Arabic in `AR.errors`, English in the `err` en register
  block); GoTrue messages `/invalid totp code|invalid code|mfa_verification_failed/i` → `MFA_INVALID_CODE`,
  `/aal2 required|AAL2/i` → `MFA_AAL2_REQUIRED`, `/challenge.*expired/i` → `MFA_INVALID_CODE`.
- Export the 6 names next to the auth group.

### 5.2 New `assets/js/mfa.js` (`window.MarsaMfa`, IIFE, createElement / textContent only)
- `renderChallenge(host, { factorId, onDone, onCancel })`: title, lead, one `input` (`inputmode="numeric"`,
  `autocomplete="one-time-code"`, `pattern="[0-9]{6}"`, `maxlength=6`, `dir="ltr"`, Arabic-Indic digits normalised
  like auth.js `normDigits`), verify button, "lost device" note, cancel = sign out.
- `renderEnroll(host, { required, onDone, onCancel })`: calls `api.mfaEnroll()`; `<img>` with `img.src = qr`
  (`alt` from i18n, width/height 200) — **never** innerHTML; secret shown in a `<code dir="ltr">` with
  `textContent`, grouped in 4s for reading, plus a copy button (`navigator.clipboard.writeText`, guarded); then the
  6-digit verify (`mfaVerify(factorId, code)`). `required` shows the "mandatory for admins" notice and hides
  "skip".
- `renderManage(host, { ctx, onChange })`: status badge (on / off), list of verified factors (friendly name +
  created date, `textContent`), "enable" (→ renderEnroll), "add another device" (only at aal2), "disable" per
  factor with `confirm()`; disabling the **last** verified factor is blocked in the UI while `ctx.mfa.required`
  (message `securityDisableBlocked`); at aal1 with a verified factor → renderChallenge first (GoTrue requires
  aal2 to unenroll a verified factor or add a second one).
- Strings via `MarsaI18n.t('login.<k>')` with the Arabic fallback table inside the file (same pattern as auth.js).

### 5.3 login.html / auth.js
- Two new views in the auth card: `<div data-auth-view="mfa" hidden><div data-mfa-host></div></div>` and
  `<div data-auth-view="security" hidden><h3 data-i18n="login.securityTitle">…</h3><div data-security-host></div>
  <button data-go-session …>`; `VIEWS` gains `'mfa', 'security'`. Session view gains a button
  `data-go-security` («أمان الحساب»). Script tag `assets/js/mfa.js` after `supa.js`, before `auth.js`.
- `routeByRole(preferStaff)` gets an MFA step **before** routing (single choke point for password sign-in,
  "continue", PWA start, confirmation link):
  1. `api.myContext(true)` → `st = api.mfaState(ctx)`; also `api.mfaAal()`.
  2. If `aal.current === 'aal1' && aal.next === 'aal2'` (user has a verified factor — required or optional) →
     `showView('mfa')` + `MarsaMfa.renderChallenge`, `onDone` → `routing=false; routeByRole(preferStaff)`.
  3. Else if `st.required && !st.enrolled` → `showView('mfa')` + `renderEnroll({required:true})`, `onDone` → same.
  4. Else route as today. Cancel in 2/3 = `api.signOut()` → tabs view.
- `?mfa=1` (from app-shell / gates, with optional `next`) with a session → `routeByRole(false)` directly;
  without a session → tabs view (staff tab) keeping `next`.
- `?security=1` with a session → security view (`renderManage`); without → tabs.
- `NEXT_PAGES` adds `help.html` (shell may redirect from it).
- Invitation flow: unchanged; after `acceptNow()` the destination page's shell sends a new admin to enrollment.

### 5.4 app-shell.js
- In `loadContext()` after `S.ctx = c.data`: `if (mfa.satisfied === false && PAGE !== 'login' && PAGE !== 'offline')`
  → `S.status = 'mfa'` and `location.replace('login.html?mfa=1&next=' + encodeURIComponent(<page>.html + location.hash))`;
  resolve `ready` with `null` (pages show their loading gate meanwhile).
- User menu gains «أمان الحساب / Account security» → `login.html?security=1` for every signed-in user
  (new shell string key `security`).

### 5.5 admin.js / platform.js gates (defence in depth, in case the shell is absent or the redirect is blocked)
- admin.js `withContext(ctx)`: first line `var st = api.mfaState ? api.mfaState(ctx) : null;
  if (st && st.required && !st.satisfied) { showGate('mfa'); return Promise.resolve(); }`. New `showGate('mfa')`
  kind: icon `lock`/`info`, title `gate_mfa_title`, text `gate_mfa_text`, primary link
  `login.html?mfa=1&next=admin.html` (`gate_mfa_btn`) + sign-out button. Static i18n strings only (escaped like the
  existing kinds). `isForbidden(e)` also treats `MRS_MFA_REQUIRED` → shows the mfa gate instead of a generic error.
- platform.js boot: after `myContext(true)`: if `mfa.required && !mfa.satisfied` → `gate('mfa')` (new
  `<div data-pf-gate="mfa" hidden>` block in platform.html: title, text, `<a class="btn btn-primary"
  href="login.html?mfa=1&next=platform.html">`) **before** the `is_platform_admin` check (which is now false at
  aal1). Any RPC error `MRS_MFA_REQUIRED` mid-session → `gate('mfa')`.

### 5.6 CSS
`assets/css/pages/login.css`: `.mfa-qr` (img, white background, padding, `inline-size: 200px`, centred with
`margin-inline: auto`), `.mfa-secret` (`font-family: monospace`, `letter-spacing`, `overflow-wrap:anywhere`),
`.mfa-code` input (large, centred, `letter-spacing: .3em`), `.mfa-factors` list. Logical properties only. No new
CSS file (so no new precache entry for CSS).

### 5.7 sw.js
`VERSION = '2026-11-09.1'` (prepend "MFA: mfa.js, login / admin / platform gates, supa.js mfa*" to the comment);
add `'assets/js/mfa.js'` to `PRECACHE` next to `auth.js`.

---

## 6. i18n keys (ar default / en)

`assets/i18n/login.js` (`login.*`):

| key | ar | en |
|---|---|---|
| mfaChallengeTitle | التحقق بخطوتين | Two-step verification |
| mfaChallengeLead | أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة على جوالك. | Enter the 6-digit code from your authenticator app. |
| mfaCodeLabel | رمز التحقق | Verification code |
| mfaCodeFormat | الرمز 6 أرقام. | The code is 6 digits. |
| mfaVerifyBtn | تحقّق | Verify |
| mfaInvalidCode | الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الحالي من التطبيق. | The code is wrong or expired. Enter the current code from the app. |
| mfaDone | تم التحقق. جارٍ تحويلك… | Verified. Redirecting… |
| mfaEnrollTitle | فعّل التحقق بخطوتين | Set up two-step verification |
| mfaEnrollRequired | حسابك له صلاحيات إدارية، لذلك التحقق بخطوتين إلزامي قبل المتابعة. | Your account has admin rights, so two-step verification is required before you continue. |
| mfaEnrollStep1 | امسح رمز QR بتطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator. | Scan the QR code with an authenticator app such as Google Authenticator or Microsoft Authenticator. |
| mfaQrAlt | رمز QR لإضافة حسابك إلى تطبيق المصادقة | QR code to add your account to the authenticator app |
| mfaSecretLabel | أو أدخل هذا المفتاح يدويًا في التطبيق | Or enter this key manually in the app |
| mfaCopySecret | نسخ المفتاح | Copy key |
| mfaCopied | تم النسخ. | Copied. |
| mfaEnrollStep2 | ثم أدخل الرمز الذي يظهر في التطبيق. | Then enter the code shown in the app. |
| mfaEnrollBtn | تفعيل | Activate |
| mfaEnrolled | تم تفعيل التحقق بخطوتين. | Two-step verification is on. |
| mfaEnrollFail | تعذّر بدء التفعيل. حاول مرة أخرى. | Setup could not start. Try again. |
| mfaLostDevice | فقدت جهازك؟ تواصل مع مالك المنصة لإعادة تعيين التحقق بخطوتين. | Lost your device? Contact the platform owner to reset two-step verification. |
| mfaCancelSignOut | إلغاء وتسجيل الخروج | Cancel and sign out |
| securityOpen | أمان الحساب | Account security |
| securityTitle | أمان الحساب | Account security |
| securityLead | التحقق بخطوتين يحمي حسابك حتى لو عُرفت كلمة المرور. | Two-step verification protects your account even if your password is known. |
| securityStatusOn | التحقق بخطوتين مفعّل | Two-step verification is on |
| securityStatusOff | التحقق بخطوتين غير مفعّل | Two-step verification is off |
| securityRequiredNote | إلزامي لحسابك (مدير مؤسسة أو مشرف منصة). | Required for your account (organization admin or platform admin). |
| securityEnable | تفعيل التحقق بخطوتين | Turn on two-step verification |
| securityAddDevice | إضافة جهاز آخر | Add another device |
| securityDisable | إيقاف | Remove |
| securityDisableConfirm | هل تريد إزالة وسيلة التحقق هذه؟ | Remove this verification method? |
| securityDisableBlocked | لا يمكن إزالة آخر وسيلة تحقق لأن التحقق بخطوتين إلزامي لحسابك. | You cannot remove the last method because two-step verification is required for your account. |
| securityDisabled | أُزيلت وسيلة التحقق. | The verification method was removed. |
| securityFactorAdded | أُضيف في {date} | Added on {date} |
| securityNeedsAal2 | لإدارة وسائل التحقق أدخل رمز التحقق أولًا. | Enter a verification code first to manage your methods. |
| securityBack | العودة | Back |

`err.*` (Arabic in `assets/js/i18n.js` `register('err')` ar + `AR.errors` in supa.js; English in supa.js `err` en block):
`MRS_MFA_REQUIRED` — «هذا الإجراء يتطلب التحقق بخطوتين. أكمل التحقق ثم حاول مرة أخرى.» / "This action requires
two-step verification. Complete it and try again."; `MFA_INVALID_CODE` (= login.mfaInvalidCode text);
`MFA_AAL2_REQUIRED` — «أدخل رمز التحقق أولًا.» / "Enter a verification code first."

`assets/i18n/admin.js`: `gate_mfa_title` «التحقق بخطوتين مطلوب» / "Two-step verification required";
`gate_mfa_text` «لوحة الإدارة تتطلب التحقق بخطوتين لحسابات المديرين. أكمل التحقق للمتابعة.» / "The admin console
requires two-step verification for admin accounts. Complete it to continue."; `gate_mfa_btn` «إكمال التحقق» /
"Complete verification".
`assets/i18n/platform.js`: `platform.gateMfaTitle`, `platform.gateMfaText` («لوحة المنصة تتطلب التحقق بخطوتين.» /
"The platform console requires two-step verification."), `platform.gateMfaBtn` (as admin).
Shell strings (`assets/i18n/app.js`, the namespace app-shell's `t()` reads): `security` «أمان الحساب» / "Account security".

---

## 7. Tests — new `supabase/tests/mfa-tests.js` (PGlite, `--quiet`, fetch trap, harness like g7-subscriptions)

Load: shim → all migrations sorted (MFA included) → seed → fixtures. `asRole(who, aal, fn)` sets claims
`{"sub":…, "role":"authenticated", "aal": aal}`; `aal = null` → `SET marsa_test.default_aal = 'none'` and no `aal`
key (missing claim). Fixtures: `adminA` (admin org A), `plat` (platform_admins), `clrA` (clearance_staff A),
`mixed` (admin A + clearance_staff org M), `same` (admin + accountant in A), `clientA`, `optUser` (clearance_staff
with a **verified** factor row), `pendingUser` (admin with an **unverified** factor row), `oldAdmin` (admin of an
inactive org).

Sections / checks:
1. **Catalog**: schema_versions row `20261109000100 mfa`; health_check reports it; the 7 new + 7 re-created
   functions are SECURITY DEFINER where listed with `search_path=""`; anon cannot execute any `app.mfa_*`;
   authenticated cannot execute `mfa_factor_verified` / `mfa_required_for` / `mfa_required_reasons`; set of public
   functions executable by authenticated unchanged (188); no new table / column / policy (catalog diff vs a
   load without the MFA file).
2. **Preflight**: fresh PGlite with files `< 20261108000100`, run the MFA file → exact message
   `MFA preflight: apply G7 first (schema_versions lacks 20261108000100 g7_subscriptions)`; nothing created
   (no `app.mfa_ok`, no row). Idempotent: applied 3× on the full DB → identical function hashes + one row.
3. **Org admin**: aal1 / missing-aal: `has_role`, `is_member` false via RLS (`organizations`, `transactions`,
   `memberships` of others → 0 rows), `admin_list_members`, `admin_update_org`, `admin_invite`,
   `admin_audit_log`, `org_subscription` → `MRS_MFA_REQUIRED` (detail `aal2`); a G6a report RPC (rpt_scope) →
   empty / MFA_REQUIRED; aal2: every one of these succeeds exactly as in existing suites.
4. **Platform admin**: aal1 → `platform_list_orgs`, `platform_create_org`, `platform_list_plans`,
   `platform_recent_errors` → `MRS_MFA_REQUIRED`; aal2 → ok.
5. **Staff / client unaffected**: `clrA`, `clientA` at aal1 == aal2 (row counts on transactions / documents /
   portal reads equal; `set_transaction_status` permitted transition succeeds at aal1); `clrA` calling an admin
   RPC at aal1 still gets `MRS_FORBIDDEN` (not rewritten).
6. **Mixed**: `mixed` aal1 → org M staff reads + write ok, org A nothing, admin RPC on A → MFA_REQUIRED;
   `same` aal1 → accountant-level finance read in A ok, admin RPC → MFA_REQUIRED; aal2 → full.
7. **my_context**: works at aal1 for every fixture; `mfa` = `{aal, required, reasons, enrolled, satisfied}` exact
   per fixture (adminA aal1 → required, ['org_admin'], enrolled false, satisfied false; plat → ['platform_admin'],
   `is_platform_admin` false at aal1 / true at aal2; clrA → required false, satisfied true; optUser → enrolled true,
   required false; pendingUser → enrolled false (unverified ignored); oldAdmin → required false); admin rows carry
   `mfa_locked` true at aal1, false at aal2; all pre-existing keys still present.
8. **app.fail**: `anon` / service role unaffected; pending user `MRS_NOT_FOUND` → `MRS_MFA_REQUIRED`.
9. **Drift**: re-run `20261102000200` → adminA aal1 regains access (proves the warning), re-run MFA file →
   enforcement back.
10. **Shim**: claims without `aal` → `app.session_aal()` = `aal2` (default), `none` → `aal1`.

Regression gate: all 22 existing suites green (`rls-tests`, `g2*`, `g3*`, `g4*`, `g5*`, `g6a`, `g6b*`, `g7*`,
`restore-drill`) — run each with `cd /tmp/pgtest && NODE_PATH=/tmp/pgtest/node_modules node <suite> --quiet`.
FRONT: `node --check` on every touched JS file; manual review that no `innerHTML` receives server / user data.

---

## 8. Lockout recovery (owner only, SQL Editor) — also in `docs/online/MFA_AR.md` (Arabic)

```sql
-- 1) check (replace the e-mail)
SELECT f.id, f.factor_type, f.status, f.created_at
  FROM auth.mfa_factors f JOIN auth.users u ON u.id = f.user_id
 WHERE lower(u.email) = lower('user@example.com');
-- 2) remove every MFA factor of that ONE user (challenges / amr claims cascade)
DELETE FROM auth.mfa_factors
 WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = lower('user@example.com'));
-- 3) optional: end that user's sessions everywhere
DELETE FROM auth.sessions
 WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = lower('user@example.com'));
```
After it the user signs in with the password, lands on enrollment (admins) and scans a new QR. Identity must be
verified out of band before running it; the run is recorded in the owner's log (date, e-mail, reason). Never run
for more than one user at a time. Also: after re-pasting any older migration file, re-paste
`20261109000100_mfa.sql`. Owner check after applying: `SELECT has_table_privilege('postgres','auth.mfa_factors','SELECT');` → true.

---

## 9. Rollout order & open decisions (defaults chosen)

| # | decision | default |
|---|---|---|
| D1 | mixed roles | per-membership server enforcement; per-user UI enforcement (§1.1) |
| D2 | error code | `app.fail` rewrites `MRS_FORBIDDEN` + `MRS_NOT_FOUND` → `MRS_MFA_REQUIRED` for MFA-pending callers only |
| D3 | missing `aal` claim | treated as `aal1`; shim defaults `aal2` for tests (§1.2) |
| D4 | `my_context.is_platform_admin` | effective (false at aal1); raw need via `mfa.reasons` |
| D5 | last-factor unenroll while required | blocked in the UI only (GoTrue unenroll is not routed through the DB); harmless server-side: without a factor the user cannot reach aal2, so privileges stay off until re-enrolled |
| D6 | accepting an admin invitation at aal1 | allowed (uses no admin privilege); enrollment forced right after |
| D7 | gated roles | `admin` only (`app.mfa_gated_roles()`); branch_manager / supervisor optional for now |
| D8 | inactive org / inactive membership | does not make MFA required |
| D9 | recovery codes | none (Supabase TOTP has none): owner SQL reset (§8); UI lets a user add a second device |
| D10 | rollout | 1) deploy FRONT (treats missing `mfa` as satisfied), 2) backup, 3) paste the migration, 4) owner enrolls own admin / platform account at once (enrollment works at aal1), 5) tell org admins they will be asked to enroll at next page load |

---

## 10. OWNS lists (file-disjoint)

**DB**
- `supabase/migrations/20261109000100_mfa.sql` (new)
- `supabase/all_migrations.sql` (regenerate)
- `supabase/tests/shim.sql` (auth.jwt default aal, auth.mfa_factors)
- `supabase/tests/mfa-tests.js` (new)
- `supabase/tests/g7-subscriptions-tests.js` (later-files loading edit only)
- any other `supabase/tests/**` file only if a suite fails for an MFA reason (minimal, documented)
- `docs/online/MFA_AR.md` (new, Arabic: what / who / enrollment steps / lockout SQL / re-paste warning / rollout)
- `docs/online/BACKUP_RESTORE_AR.md` (one pointer line to MFA_AR.md lockout section)

**FRONT**
- `assets/js/supa.js`, `assets/js/mfa.js` (new), `assets/js/auth.js`, `assets/js/app-shell.js`,
  `assets/js/admin.js`, `assets/js/platform.js`, `assets/js/i18n.js`
- `assets/i18n/login.js`, `assets/i18n/admin.js`, `assets/i18n/platform.js`, `assets/i18n/app.js`
- `assets/css/pages/login.css`
- `login.html`, `platform.html` (admin.html only if the gate needs markup)
- `sw.js`

Never touched by either: `supabase/make_admin.sql`, `supabase/migrations/2026110[2-8]*.sql` and older, git state.

---

## 11. As built (2026-11-03, uncommitted on `online-staging`)

### 11.1 Database — `supabase/migrations/20261109000100_mfa.sql`
- **Preflight:** stops before creating anything if `20261108000100` (G7) or `auth.mfa_factors` is missing. It then inserts `schema_versions` row `20261109000100 mfa` (ON CONFLICT DO NOTHING).
- **New helpers (7):** `app.mfa_gated_roles`, `app.session_aal`, `app.mfa_ok`, `app.mfa_factor_verified`,
  `app.mfa_required_for`, `app.mfa_required_reasons`, `app.mfa_pending` (§2.1).
  - The three helpers that take a uid are owner-only; they are also revoked from `authenticated` and `service_role`.
  - `mfa_pending`, `mfa_ok`, `session_aal` and `mfa_gated_roles` are granted to `authenticated` and `service_role`. `app.fail` runs as the invoker and calls them.
- **Re-created with the MFA row predicate (§2.2):** `app.is_member`, `app.has_role`, `app.has_branch_role`, `app.rpt_scope` and `app.is_platform_admin`.
  - `app.fail` turns `MRS_FORBIDDEN` / `MRS_NOT_FOUND` into `MRS_MFA_REQUIRED` (detail `aal2`), but only for an MFA-pending caller.
  - `public.my_context` adds `mfa {aal, required, reasons, enrolled, satisfied}` and `mfa_locked` on each membership row.
- **Review fixes (§2b of the file).** Two ownership paths skipped the role helpers. Both are closed now:
  1. **Import staging.** `app.can_read_batch`, `app.can_edit_batch` and policies `import_batches_select` / `import_batches_update` (DROP POLICY IF EXISTS + CREATE POLICY) change their creator branch from `created_by = auth.uid()` to `(created_by = auth.uid() AND app.is_member(org_id))`.
     - An admin-only creator at aal1 no longer sees or edits their batches, and neither does a deactivated creator.
     - A staff creator is unaffected.
  2. **`public.accept_invitation`.** The self-invitation guard now uses `app.has_branch_role(v_i.org_id, NULL, ARRAY['admin'])`, which is MFA-gated and judges this session, in place of `app.uid_has_branch_role(v_uid, …)`.
     - An aal1 admin who accepts their own self-invitation gets `MRS_MFA_REQUIRED` and no membership is created.
     - The rest of the body is unchanged from 20261102000200 §11.
- **What this changes from §2:**
  - There are now **2 policy re-definitions**. "No policy changed" no longer holds; tables, columns, triggers and the public function set are still unchanged.
  - **10 functions** are re-created. `can_read_batch`, `can_edit_batch` and `accept_invitation` keep their original ACLs (re-asserted).
  - The re-paste warning now also covers 20261031000300 for these two policies. Re-paste the MFA file after any older file.
- **Not changed (deliberately):** `app.uid_has_branch_role`, `app.bm_client_in_scope` and `app.invitation_authorized`. They judge the inviter's standing.
- **Mixed roles:** enforcement is per membership row, so admin in A plus staff in M at aal1 gives nothing in A and full staff access in M. The error code is per user, so that caller gets `MRS_MFA_REQUIRED` in place of `MRS_FORBIDDEN` / `MRS_NOT_FOUND` wherever those would apply, M included. The UI enforces MFA per user.
- **Regenerated:** `supabase/all_migrations.sql` (19 versions; its last section is the MFA file).
  - Applying it to an empty PGlite DB gives max version `20261109000100`.
  - Running the MFA file again afterwards succeeds.

### 11.2 Tests
- **`supabase/tests/mfa-tests.js`:** §7 sections 1–10, plus section 11 (review fixes). The import batch and self-invitation checks cover aal1, a missing aal and aal2; one more check confirms a staff creator is unaffected.
  - The catalog-diff check now expects exactly the 10 re-created functions and exactly the two `import_batches` policies re-defined (same names, new qual).
- **`supabase/tests/shim.sql`:**
  - `auth.jwt()` injects `"aal":"aal2"` when a token has `sub` but no `aal`. Setting `marsa_test.default_aal = 'none'` turns this off; any other value is injected instead.
  - Adds a minimal `auth.mfa_factors`.
  - The existing suites are otherwise unedited.
- **`supabase/tests/g7-subscriptions-tests.js`:** loader only. Files after G7 now load after its preflight step.
- **Drift test (§7.9):** re-runs only the four old helper bodies from 20261102000200, not the whole file. Re-running the whole file after G3 would also bring back unrelated old functions.

### 11.3 Front end
- **`assets/js/supa.js`:**
  - Adds `mfaFactors`, `mfaAal`, `mfaEnroll` (removes stale unverified factors first and keeps only an SVG data-URI QR), `mfaVerify`, `mfaUnenroll` and `mfaState`. A context without an `mfa` key counts as satisfied.
  - Adds errors `MRS_MFA_REQUIRED`, `MFA_INVALID_CODE` and `MFA_AAL2_REQUIRED`.
  - Review fix: `normalizeError` maps a lost session (`AuthSessionMissingError`, `session_not_found`, a bad or missing refresh token) to `MRS_AUTH_REQUIRED`; before, it fell through to `UNKNOWN`.
- **`assets/js/mfa.js` (`window.MarsaMfa`):** the challenge, enrollment and manage screens, built with createElement / textContent only. The QR goes in through `img.src` only. Review fixes:
  - **Language switch:** every string node, the QR `alt` and the alert texts are registered and relabelled in place on `marsa:langchange`. A busy button's saved label is updated too. The screens are not rebuilt, so the pending factor, QR, secret and typed code all survive.
  - **Error text:** only `MFA_INVALID_CODE` says "wrong or expired code". Other errors show their own message, and errors that have an `err.<CODE>` string are re-localized on a language switch.
  - **Lost session:** if the session is lost during the challenge, the user is signed out and returned to the sign-in tabs.
  - **Grouped codes:** the code input has `maxlength=12` (was 6), so a pasted grouped code like `123 456` or `123-456` arrives whole. The handler strips separators and keeps 6 digits.
  - **Arabic wording:** the remove button reads `إزالة` (was `إيقاف`), here and in `assets/i18n/login.js`.
- **`assets/js/auth.js` / `login.html`:**
  - Adds views `mfa` and `security`, a pre-routing MFA step and `?mfa=1` / `?security=1`.
  - The signed-in panel has an "أمان الحساب" button.
- **`assets/js/app-shell.js`:** at aal1, a session that needs MFA is sent to `login.html?mfa=1&next=…`. The shell also adds an account-security link and a palette action.
- **`assets/js/admin.js`, `assets/js/platform.js`, `platform.html`:** each page has an MFA gate that runs before the role check. Each also switches to that gate when a call returns `MRS_MFA_REQUIRED` mid-session (admin.js through `apiErr`, platform.js through `errText`).
- **i18n:** `assets/js/i18n.js` (`err.*`), `assets/i18n/login.js`, `assets/i18n/admin.js`, `assets/i18n/platform.js` and `assets/i18n/app.js`.
- **CSS:** `assets/css/pages/login.css` (logical properties).
- **`sw.js`:** `VERSION` is `2026-11-09.1`, and `assets/js/mfa.js` is precached.
- **Verification:**
  - The headless Chrome CDP run against a stubbed `window.supabase` passed 90 of 90 checks, with all external requests blocked. It includes new scenarios for the language switch on enrollment (same secret, no second enroll, typed code kept), relabelling of the challenge alert, a grouped paste, a lost session, and the Arabic remove label.
  - `node --check` passes on every touched JS file.
  - Not covered: a run against real Supabase, and the admin.js mid-session gate for calls that do not go through `apiErr`.

### 11.4 Docs
- `docs/online/MFA_AR.md`: Arabic. Covers how it works, the self-invitation and import-staging notes, rollout, enrollment, the owner lockout SQL (§5, the same as §8 here) and the re-paste warning.
- `docs/online/BACKUP_RESTORE_AR.md`: one pointer line to MFA_AR.md §5.
