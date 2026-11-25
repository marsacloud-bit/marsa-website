-- =====================================================================
-- 20261215000100_team_tiers — three sign-in tiers: the office owner, management, employees (2026-11-25, owner request)
--   Owner: one sign-in page with three tiers (المؤسسة / الإدارة / الموظفون) and separated permissions. The ORGANISATION tier
--   is the office owner: exactly one per org = an active org-wide 'admin' membership flagged is_owner. Only the owner
--   invites / adds / removes / deactivates ADMINS and transfers the ownership; otherwise the owner has every admin power.
--   MANAGEMENT = admin (non-owner), branch_manager, supervisor: a non-owner admin manages the office's EMPLOYEES (and
--   portal clients) but never another admin nor the owner; branch_manager and supervisor keep today's powers. EMPLOYEES =
--   clearance_staff, transport_staff, accountant, accounts_manager, operations_manager. Office clients and platform
--   admins are unchanged.
--   1. public.memberships.is_owner boolean NOT NULL DEFAULT false; CHECK memberships_owner_shape (an owner row is an
--      org-wide admin row); UNIQUE partial index memberships_one_owner_idx (one owner per org). The flag never lingers on
--      an inactive row: trg_auto_owner clears it when the row is deactivated or stops being an org-wide admin (and a re-run
--      clears any stale flag on an inactive row).
--   2. app.is_org_owner(org) (the caller) / app.uid_is_org_owner(uid, org) (an inviter): an active owner row of an active
--      org (has_role / uid_has_branch_role rules, MFA rule included). LEGACY FALLBACK: an org without an ACTIVE owner row
--      keeps today's behaviour (every active org-wide admin counts as the owner) until app.set_org_owner is run — except
--      public.owner_transfer, which always needs a real flagged active owner (no fallback).
--      Unchanged on purpose: app.li_is_owner (legacy import, 20261125000100) and app.daftra_is_owner (Daftra settings,
--      20261123000100; also the mfa_off gate, 20261129000100) still mean ANY active org-wide admin — not this owner flag.
--   3. re-created (latest bodies, only the owner rule added): app.can_manage_member (20261102000200: role 'admin' only
--      for the owner), app.invitation_authorized (20261102000200: an admin invitation stays valid only while its inviter
--      is the owner; the platform first-admin clause unchanged), public.admin_invite (20261102000200: role 'admin' only
--      for the owner, else MRS_FORBIDDEN owner_only), public.admin_set_member_active (20261102000200: the owner row is
--      never deactivated, MRS_FORBIDDEN owner), public.admin_list_members (20261102000200: + 'is_owner'; org admins see
--      every member row, 'can_manage' still from app.can_manage_member and never on the owner row), public.my_context
--      (20261202000100 body verbatim: + 'is_owner' on each memberships[] row = the effective owner status, legacy
--      fallback included).
--   4. public.owner_transfer(org, membership) — the flagged owner only (an active org-wide admin row with is_owner; the
--      legacy fallback does NOT apply, also in the re-check under the locks; MRS_FORBIDDEN owner_only otherwise): moves the
--      flag to another active org-wide admin of the same org (org row + both membership rows locked; audit row). While an
--      org has no owner, only app.set_org_owner (SQL Editor) can name one.
--   5. app.set_org_owner(org, email) — SQL Editor only: flags that user's active org-wide admin membership as the owner
--      (clears any other owner of the org). For the production office (2+ admins) the owner runs it once.
--   6. trigger trg_auto_owner (BEFORE INSERT OR UPDATE OF is_active, role, branch_id ON public.memberships): a flagged row
--      that becomes inactive or stops being an org-wide admin loses the flag (the org falls back to the legacy rule until
--      app.set_org_owner); the first active org-wide admin of an org without an owner and without another active admin
--      becomes the owner (a new office created by platform_create_org → its first admin accepts the invitation → owner).
--   7. backfill: an org with exactly one active org-wide admin and no owner gets that row flagged; orgs with 2+ admins are
--      left to app.set_org_owner (legacy fallback meanwhile). Before it, a stale flag on an inactive row is cleared.
--   Errors (UI): MRS_FORBIDDEN owner_only (only the owner may do this), MRS_FORBIDDEN owner (the owner row).
--   Re-runnable (ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD / CREATE OR REPLACE / DROP TRIGGER IF EXISTS;
--   the backfill skips orgs that already have an owner).
--   Down-path: DROP TRIGGER trg_auto_owner ON public.memberships; DROP FUNCTION app.tg_membership_auto_owner(),
--   app.set_org_owner(uuid, text), public.owner_transfer(uuid, uuid); re-create app.can_manage_member,
--   app.invitation_authorized, public.admin_invite, public.admin_set_member_active, public.admin_list_members from
--   20261102000200 and public.my_context from 20261202000100 (their bodies, verbatim); DROP FUNCTION
--   app.uid_is_org_owner(uuid, uuid), app.is_org_owner(uuid); DROP INDEX public.memberships_one_owner_idx; ALTER TABLE
--   public.memberships DROP CONSTRAINT memberships_owner_shape, DROP COLUMN is_owner; DELETE FROM public.schema_versions
--   WHERE version = '20261215000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261214000100') THEN
    RAISE EXCEPTION 'TEAM TIERS preflight: apply org_ai_keys first (schema_versions lacks 20261214000100)';
  END IF;
  IF to_regclass('public.memberships') IS NULL OR to_regclass('public.invitations') IS NULL
     OR to_regprocedure('app.can_manage_member(uuid, uuid, text)') IS NULL
     OR to_regprocedure('app.uid_has_branch_role(uuid, uuid, uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'TEAM TIERS preflight: memberships / invitations objects (20261102000200) missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261215000100', 'team_tiers')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the owner flag
-- ---------------------------------------------------------------------
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_owner_shape;
ALTER TABLE public.memberships ADD CONSTRAINT memberships_owner_shape
  CHECK (NOT is_owner OR (role = 'admin' AND branch_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_idx ON public.memberships (org_id) WHERE is_owner;
COMMENT ON COLUMN public.memberships.is_owner IS 'The office owner (20261215000100): one org-wide admin row per org. Only the owner manages admins and transfers the ownership (public.owner_transfer; SQL Editor: app.set_org_owner).';

-- ---------------------------------------------------------------------
-- 2. who is the owner
-- ---------------------------------------------------------------------
-- the caller: an active org-wide admin row (has_branch_role with branch NULL = org-wide only; org active, MFA rule) that
-- is the owner row, or — LEGACY FALLBACK — any such admin while the org has no ACTIVE owner row
CREATE OR REPLACE FUNCTION app.is_org_owner(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND p_org IS NOT NULL
     AND app.has_branch_role(p_org, NULL, ARRAY['admin'])
     AND (EXISTS (SELECT 1 FROM public.memberships m
                   WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.is_owner AND m.is_active
                     AND m.role = 'admin' AND m.branch_id IS NULL)
          OR NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.org_id = p_org AND m.is_owner AND m.is_active))
$$;

-- the same rule for an explicit user (the inviter of an invitation, while auth.uid() is the invitee)
CREATE OR REPLACE FUNCTION app.uid_is_org_owner(p_uid uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_uid IS NOT NULL AND p_org IS NOT NULL
     AND app.uid_has_branch_role(p_uid, p_org, NULL, ARRAY['admin'])
     AND (EXISTS (SELECT 1 FROM public.memberships m
                   WHERE m.org_id = p_org AND m.user_id = p_uid AND m.is_owner AND m.is_active
                     AND m.role = 'admin' AND m.branch_id IS NULL)
          OR NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.org_id = p_org AND m.is_owner AND m.is_active))
$$;

-- ---------------------------------------------------------------------
-- 3. re-created access rules (20261102000200 bodies; TEAM TIERS marks the changes)
-- ---------------------------------------------------------------------
-- admin of the org (role 'admin' only for the owner), or branch_manager of p_branch for the lower staff roles
CREATE OR REPLACE FUNCTION app.can_manage_member(p_org uuid, p_branch uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (app.has_role(p_org, ARRAY['admin'])
          AND (p_role IS DISTINCT FROM 'admin' OR app.is_org_owner(p_org)))                              -- TEAM TIERS
      OR (p_branch IS NOT NULL AND p_role = ANY (app.bm_managed_roles())
          AND app.has_branch_role(p_org, p_branch, ARRAY['branch_manager']))
$$;

-- Is the invitation still backed by its inviter's CURRENT authority? Checked at
-- preview / accept time (and after a member is deactivated), so a removed admin or
-- branch manager cannot leave working links behind. Written against invited_by:
-- at accept time auth.uid() is the invitee. TEAM TIERS: an admin invitation needs the inviter to be the owner.
CREATE OR REPLACE FUNCTION app.invitation_authorized(p_inv public.invitations) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p_inv.invited_by IS NOT NULL AND (
       -- first admin of an org created by a platform operator (platform_create_org)
       (p_inv.role = 'admin' AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_inv.invited_by))
    OR (app.uid_has_branch_role(p_inv.invited_by, p_inv.org_id, NULL, ARRAY['admin'])
        AND (p_inv.role <> 'admin' OR app.uid_is_org_owner(p_inv.invited_by, p_inv.org_id)))         -- TEAM TIERS
    OR (p_inv.role = ANY (app.bm_managed_roles()) AND p_inv.branch_id IS NOT NULL
        AND app.uid_has_branch_role(p_inv.invited_by, p_inv.org_id, p_inv.branch_id, ARRAY['branch_manager']))
    OR (p_inv.role = 'client' AND p_inv.client_id IS NOT NULL
        AND app.bm_client_in_scope(p_inv.invited_by, p_inv.org_id, p_inv.client_id)))
$$;

-- payload {email, role, branch_id?, client_id?, idempotencyKey}
-- admin: any role ('admin' only for the owner: TEAM TIERS). branch_manager: clearance_staff / transport_staff /
-- accountant of its own branch, and client-portal invitations. Never looks at auth.users.
CREATE OR REPLACE FUNCTION public.admin_invite(p_org uuid, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key    uuid;
  v_replay jsonb;
  v_admin  boolean;
  v_email  text;
  v_role   text;
  v_branch uuid;
  v_client uuid;
  v_inv    record;
  v_res    jsonb;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','branch_manager']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  v_admin := app.has_role(p_org, ARRAY['admin']);
  PERFORM app.only_keys(p_payload, ARRAY['email','role','branch_id','client_id','idempotencyKey']);
  v_key := app.idem_key_from(p_payload);

  v_email := lower(app.ptext(p_payload, 'email', 160, true));
  IF NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  v_role := app.ptext(p_payload, 'role', 40, true);
  IF NOT (v_role = ANY (app.all_roles())) THEN PERFORM app.fail('MRS_INVALID', 'role'); END IF;
  v_branch := app.puuid(p_payload, 'branch_id');
  v_client := app.puuid(p_payload, 'client_id');

  IF v_role = 'client' THEN
    IF v_client IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'client_id'); END IF;
    IF v_branch IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch'); END IF;
    IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client AND c.org_id = p_org AND c.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'client');
    END IF;
  ELSE
    IF v_client IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'client_id'); END IF;
    IF v_role = 'branch_manager' AND v_branch IS NULL THEN PERFORM app.fail('MRS_BRANCH_REQUIRED'); END IF;
    IF v_role = 'admin' AND v_branch IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'branch'); END IF;
    IF v_branch IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.branches b WHERE b.id = v_branch AND b.org_id = p_org AND b.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'branch');
    END IF;
  END IF;

  -- who may invite what (G2_SPEC "Roles")
  IF v_admin THEN
    -- TEAM TIERS: only the office owner invites another admin
    IF v_role = 'admin' AND NOT app.is_org_owner(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner_only'); END IF;
  ELSE
    -- a branch manager never invites itself (a second membership / a client link
    -- would survive its own deactivation). Reads only the CALLER's own e-mail.
    IF v_email = (SELECT lower(btrim(u.email)) FROM auth.users u WHERE u.id = auth.uid()) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'email');
    END IF;
    IF v_role = 'client' THEN
      -- clients are org-wide: only clients whose transactions / requests all sit in the
      -- caller's branch(es); anything else needs an org admin
      IF NOT app.bm_client_in_scope(auth.uid(), p_org, v_client) THEN PERFORM app.fail('MRS_FORBIDDEN', 'client'); END IF;
    ELSIF NOT (v_role = ANY (app.bm_managed_roles())) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'role');
    ELSIF v_branch IS NULL OR NOT app.has_branch_role(p_org, v_branch, ARRAY['branch_manager']) THEN
      PERFORM app.fail('MRS_FORBIDDEN', 'branch');
    END IF;
  END IF;

  v_replay := app.idem_begin('admin_invite', v_key, p_payload, p_org);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT * INTO v_inv FROM app.create_invitation(p_org, v_email, v_role, v_branch, v_client);
  -- the stored replay copy never holds the token
  v_res := jsonb_build_object('invitation_id', v_inv.id, 'email', v_email, 'role', v_role,
                              'branch_id', v_branch, 'client_id', v_client, 'expires_at', v_inv.expires_at,
                              'token', NULL, 'accept_path', NULL, 'token_shown', true);
  PERFORM app.idem_finish('admin_invite', v_key, v_res);
  RETURN v_res || jsonb_build_object('token', v_inv.token, 'accept_path', 'login.html?invite=' || v_inv.token,
                                     'token_shown', false);
END $$;

-- members — branch_manager manages the lower roles of its branch; TEAM TIERS: + 'is_owner' (the owner row), org admins
-- see every member row of the org, 'can_manage' never on the owner row
CREATE OR REPLACE FUNCTION public.admin_list_members(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin','branch_manager']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'user_id', m.user_id, 'email', u.email,
             'full_name', p.full_name, 'phone', p.phone,
             'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
             'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
             'is_active', m.is_active, 'created_at', m.created_at, 'updated_at', m.updated_at,
             'is_me', m.user_id = auth.uid(),
             'is_owner', m.is_owner,                                                                       -- TEAM TIERS
             'can_manage', m.user_id <> auth.uid() AND NOT m.is_owner
                           AND app.can_manage_member(m.org_id, m.branch_id, m.role))
           ORDER BY m.is_active DESC, m.is_owner DESC, s.sort DESC, u.email)
      FROM public.memberships m
      LEFT JOIN auth.users u        ON u.id = m.user_id
      LEFT JOIN public.profiles p   ON p.id = m.user_id
      LEFT JOIN public.branches b   ON b.id = m.branch_id
      LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
     WHERE m.org_id = p_org
       AND (m.user_id = auth.uid() OR app.has_role(p_org, ARRAY['admin'])                               -- TEAM TIERS
            OR app.can_manage_member(m.org_id, m.branch_id, m.role))), '[]'::jsonb);
END $$;

-- Deactivation also: switches off the user's client-portal links in the org (role
-- 'client'; reactivation restores only the links from its accepted invitations),
-- revokes the user's pending invitations in the org and the ones it issued that
-- it may no longer grant. The last-admin guard serializes on the organization row.
-- TEAM TIERS: the owner row is never deactivated (MRS_FORBIDDEN owner); an admin row only by the owner.
CREATE OR REPLACE FUNCTION public.admin_set_member_active(p_membership uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m public.memberships; v_admins int; v_email text; v_revoked int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  -- two admins deactivating each other at once: both lock the org row first, so the
  -- second waits and then counts the first one's change (no org left without an admin)
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership;
  IF v_m.id IS NOT NULL AND v_m.role = 'admin' THEN
    PERFORM 1 FROM public.organizations o WHERE o.id = v_m.org_id FOR NO KEY UPDATE;
  END IF;
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership FOR UPDATE;
  -- TEAM TIERS: an org admin (the owner included) is told why the owner row cannot be switched off
  IF v_m.id IS NOT NULL AND v_m.is_owner AND p_active IS FALSE AND app.has_role(v_m.org_id, ARRAY['admin']) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner');
  END IF;
  IF v_m.id IS NULL OR NOT app.can_manage_member(v_m.org_id, v_m.branch_id, v_m.role) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF p_active IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'status'); END IF;
  IF v_m.is_active = p_active THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT p_active THEN
    IF v_m.is_owner THEN PERFORM app.fail('MRS_FORBIDDEN', 'owner'); END IF;                             -- TEAM TIERS
    IF v_m.user_id = auth.uid() THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    IF v_m.role = 'admin' THEN
      SELECT count(*) INTO v_admins FROM public.memberships m
       WHERE m.org_id = v_m.org_id AND m.role = 'admin' AND m.is_active AND m.id <> v_m.id;
      IF v_admins = 0 THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    END IF;
  END IF;
  UPDATE public.memberships m SET is_active = p_active WHERE m.id = v_m.id RETURNING * INTO v_m;

  IF v_m.role = 'client' THEN
    UPDATE public.client_users cu SET is_active = p_active
     WHERE cu.user_id = v_m.user_id AND cu.org_id = v_m.org_id AND cu.is_active <> p_active
       AND (NOT p_active OR cu.client_id IN (
             SELECT i.client_id FROM public.invitations i
              WHERE i.org_id = v_m.org_id AND i.role = 'client' AND i.accepted_by = v_m.user_id));
  END IF;

  IF NOT p_active THEN
    SELECT lower(btrim(u.email)) INTO v_email FROM auth.users u WHERE u.id = v_m.user_id;
    WITH r AS (
      UPDATE public.invitations i SET revoked_at = now(), revoked_by = auth.uid()
       WHERE i.org_id = v_m.org_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
         AND ((v_email IS NOT NULL AND i.email = v_email AND app.can_manage_invitation(i))   -- addressed to the user
              OR (i.invited_by = v_m.user_id AND NOT app.invitation_authorized(i)))           -- no longer backed
      RETURNING 1)
    SELECT count(*) INTO v_revoked FROM r;
  END IF;
  RETURN jsonb_build_object('id', v_m.id, 'is_active', v_m.is_active, 'role', v_m.role,
                            'invitations_revoked', v_revoked);
END $$;

-- my_context (20261202000100 body verbatim; TEAM TIERS: + 'is_owner' on each memberships[] row = the effective owner
-- status: the owner row, or an org-wide admin row of an org without an active owner row — the legacy fallback)
CREATE OR REPLACE FUNCTION public.my_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_aal text;
  v_ok  boolean;
  v_req boolean;
BEGIN
  IF v_uid IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  v_aal := app.session_aal();
  v_ok  := app.mfa_ok();
  v_req := app.mfa_required_for(v_uid);
  RETURN jsonb_build_object(
    'user_id', v_uid,
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = v_uid),
    'memberships', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', m.org_id, 'org_slug', o.slug, 'org_name_ar', o.name_ar, 'org_name_en', o.name_en,
               'environment', o.environment,
               'org_logo_path', o.settings ->> 'logo_path',                                                       -- ORG LOGO
               'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
               'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
               'mfa_locked', (m.role = ANY (app.mfa_gated_roles()) AND NOT v_ok),
               'is_owner', (m.role = 'admin' AND m.branch_id IS NULL                                             -- TEAM TIERS
                            AND (m.is_owner OR NOT EXISTS (SELECT 1 FROM public.memberships mo
                                                            WHERE mo.org_id = m.org_id AND mo.is_owner
                                                              AND mo.is_active))))
             ORDER BY o.slug, s.sort DESC)
        FROM public.memberships m
        JOIN public.organizations o ON o.id = m.org_id AND o.is_active
        LEFT JOIN public.branches b ON b.id = m.branch_id
        LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
       WHERE m.user_id = v_uid AND m.is_active), '[]'::jsonb),
    'clients', coalesce((
      SELECT jsonb_agg(jsonb_build_object('client_id', c.id, 'org_id', c.org_id, 'name_ar', c.name_ar, 'link_role', cu.role,
                                          'org_logo_path', o.settings ->> 'logo_path'))                          -- ORG LOGO
        FROM public.client_users cu JOIN public.clients c ON c.id = cu.client_id
        JOIN public.organizations o ON o.id = c.org_id                                                          -- ORG LOGO
       -- same rule as data access: active client + active org + client membership not deactivated
       WHERE cu.user_id = v_uid AND cu.is_active AND cu.client_id IN (SELECT app.my_client_ids())), '[]'::jsonb),
    'is_platform_admin', app.is_platform_admin(),
    'organizations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'org_id', o.id, 'slug', o.slug, 'name_ar', o.name_ar, 'name_en', o.name_en,
               'environment', o.environment, 'default_locale', o.default_locale, 'roles', to_jsonb(x.roles),
               'logo_path', o.settings ->> 'logo_path')                                                           -- ORG LOGO
             ORDER BY o.slug)
        FROM (SELECT m.org_id, array_agg(DISTINCT m.role ORDER BY m.role) roles
                FROM public.memberships m WHERE m.user_id = v_uid AND m.is_active GROUP BY m.org_id) x
        JOIN public.organizations o ON o.id = x.org_id AND o.is_active), '[]'::jsonb),
    'mfa', jsonb_build_object(
      'aal', v_aal,
      'required', v_req,
      'reasons', app.mfa_required_reasons(v_uid),
      'enrolled', app.mfa_factor_verified(v_uid),
      'satisfied', (NOT v_req OR v_ok)));
END $$;

-- ---------------------------------------------------------------------
-- 4. owner_transfer: the owner hands the office to another org-wide admin
--    The caller must be the FLAGGED active owner: no legacy fallback here (an org without an owner names one with
--    app.set_org_owner from the SQL Editor), so no admin of such an org can grab the ownership.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_transfer(p_org uuid, p_membership uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_t public.memberships; v_prev uuid;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_branch_role(p_org, NULL, ARRAY['admin'])
     OR NOT EXISTS (SELECT 1 FROM public.memberships m
                     WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.is_owner AND m.is_active
                       AND m.role = 'admin' AND m.branch_id IS NULL) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  -- serializes with admin_set_member_active (same org-row lock) and with a second transfer
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  PERFORM 1 FROM public.memberships m WHERE m.org_id = p_org AND (m.is_owner OR m.id = p_membership) ORDER BY m.id FOR UPDATE;
  -- re-checked under the locks (a concurrent transfer may have moved the flag; same rule, no legacy fallback)
  IF p_org IS NULL OR NOT app.has_branch_role(p_org, NULL, ARRAY['admin'])
     OR NOT EXISTS (SELECT 1 FROM public.memberships m
                     WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.is_owner AND m.is_active
                       AND m.role = 'admin' AND m.branch_id IS NULL) THEN
    PERFORM app.fail('MRS_FORBIDDEN', 'owner_only');
  END IF;
  SELECT * INTO v_t FROM public.memberships m WHERE m.id = p_membership AND m.org_id = p_org;
  IF v_t.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF v_t.user_id = auth.uid() THEN PERFORM app.fail('MRS_INVALID', 'self'); END IF;
  IF NOT v_t.is_active OR v_t.role <> 'admin' OR v_t.branch_id IS NOT NULL THEN PERFORM app.fail('MRS_INVALID', 'target'); END IF;

  SELECT m.id INTO v_prev FROM public.memberships m WHERE m.org_id = p_org AND m.is_owner;
  -- the flag moves: clear first (one owner per org, memberships_one_owner_idx), then set
  UPDATE public.memberships m SET is_owner = false WHERE m.org_id = p_org AND m.is_owner;
  UPDATE public.memberships m SET is_owner = true WHERE m.id = v_t.id;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changed_fields, old_data, new_data, actor, actor_role)
  VALUES (p_org, 'memberships', v_t.id::text, 'UPDATE', ARRAY['is_owner'],
          jsonb_build_object('owner_membership_id', v_prev),
          jsonb_build_object('owner_transfer', true, 'owner_membership_id', v_t.id, 'owner_user_id', v_t.user_id),
          auth.uid(), auth.jwt() ->> 'role');
  RETURN jsonb_build_object('org_id', p_org, 'owner_membership_id', v_t.id, 'owner_user_id', v_t.user_id,
                            'previous_membership_id', v_prev);
END $$;

-- ---------------------------------------------------------------------
-- 5. app.set_org_owner: SQL Editor only (the office with several admins names its owner once)
--    SELECT app.set_org_owner('<org uuid>', 'owner@example.com');
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_org_owner(p_org uuid, p_email text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_m public.memberships;
BEGIN
  IF p_org IS NULL OR p_email IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'org_email'); END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  SELECT m.* INTO v_m FROM public.memberships m JOIN auth.users u ON u.id = m.user_id
   WHERE m.org_id = p_org AND lower(btrim(u.email)) = lower(btrim(p_email))
     AND m.role = 'admin' AND m.branch_id IS NULL AND m.is_active
   FOR UPDATE OF m;
  IF v_m.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'admin_membership'); END IF;
  UPDATE public.memberships m SET is_owner = false WHERE m.org_id = p_org AND m.is_owner AND m.id <> v_m.id;
  UPDATE public.memberships m SET is_owner = true WHERE m.id = v_m.id AND NOT m.is_owner;
  RETURN jsonb_build_object('org_id', p_org, 'owner_membership_id', v_m.id, 'owner_user_id', v_m.user_id);
END $$;

-- ---------------------------------------------------------------------
-- 6. the first admin of an org without an owner becomes the owner; a row that stops being an active org-wide admin
--    loses the flag (so it never lingers on an inactive row)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_membership_auto_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.is_owner AND (NOT NEW.is_active OR NEW.role <> 'admin' OR NEW.branch_id IS NOT NULL) THEN
    NEW.is_owner := false;
    RETURN NEW;
  END IF;
  IF NEW.is_owner OR NOT NEW.is_active OR NEW.role <> 'admin' OR NEW.branch_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active AND OLD.role = 'admin' AND OLD.branch_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.org_id = NEW.org_id AND m.is_owner)
     AND NOT EXISTS (SELECT 1 FROM public.memberships m
                      WHERE m.org_id = NEW.org_id AND m.id <> NEW.id AND m.is_active
                        AND m.role = 'admin' AND m.branch_id IS NULL) THEN
    NEW.is_owner := true;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_auto_owner ON public.memberships;
CREATE TRIGGER trg_auto_owner BEFORE INSERT OR UPDATE OF is_active, role, branch_id ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app.tg_membership_auto_owner();

-- ---------------------------------------------------------------------
-- 7. backfill: an org with exactly one active org-wide admin (and no owner yet) → that row is the owner
-- ---------------------------------------------------------------------
-- re-run safety: a flag left on an inactive row (e.g. the trigger was disabled) is cleared first
UPDATE public.memberships m SET is_owner = false WHERE m.is_owner AND NOT m.is_active;
UPDATE public.memberships m SET is_owner = true
 WHERE m.role = 'admin' AND m.branch_id IS NULL AND m.is_active AND NOT m.is_owner
   AND NOT EXISTS (SELECT 1 FROM public.memberships o WHERE o.org_id = m.org_id AND o.is_owner)
   AND (SELECT count(*) FROM public.memberships a
         WHERE a.org_id = m.org_id AND a.role = 'admin' AND a.branch_id IS NULL AND a.is_active) = 1;

-- ---------------------------------------------------------------------
-- 8. privileges (CREATE OR REPLACE keeps each function's ACL; re-asserted)
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.is_org_owner(uuid), app.uid_is_org_owner(uuid, uuid), app.can_manage_member(uuid, uuid, text),
  app.invitation_authorized(public.invitations), app.tg_membership_auto_owner()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_org_owner(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_invite(uuid, jsonb), public.admin_list_members(uuid),
  public.admin_set_member_active(uuid, boolean), public.my_context(), public.owner_transfer(uuid, uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_invite(uuid, jsonb), public.admin_list_members(uuid),
  public.admin_set_member_active(uuid, boolean), public.my_context(), public.owner_transfer(uuid, uuid)
TO authenticated;
