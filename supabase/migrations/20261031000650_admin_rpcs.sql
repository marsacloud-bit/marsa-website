-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0650 — staff-console admin RPCs (admin.html).
--
-- Why RPCs: emails live in auth.users, which the API roles cannot read.
-- An org admin must be able to (a) see member emails of HIS org only and
-- (b) grant a staff role to an EXISTING account by email. No account is
-- ever created here (users sign up themselves; roles are never taken from
-- signup metadata).
--
--   admin_list_members(p_org)                          admin only
--   admin_add_member(p_org, p_email, p_role, p_branch) admin only, staff roles only
--   admin_set_member_active(p_membership, p_active)    admin only; never self,
--                                                      never the last active admin
-- Role changes = add the new membership + deactivate the old one, so the
-- history stays visible (memberships are also covered by the audit trigger).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.admin_list_members(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', m.id, 'user_id', m.user_id, 'email', u.email,
             'full_name', p.full_name, 'phone', p.phone,
             'role', m.role, 'role_label_ar', s.label_ar, 'role_label_en', s.label_en,
             'branch_id', m.branch_id, 'branch_code', b.code, 'branch_name_ar', b.name_ar,
             'is_active', m.is_active, 'created_at', m.created_at, 'updated_at', m.updated_at,
             'is_me', m.user_id = auth.uid())
           ORDER BY m.is_active DESC, s.sort DESC, u.email)
      FROM public.memberships m
      LEFT JOIN auth.users u        ON u.id = m.user_id
      LEFT JOIN public.profiles p   ON p.id = m.user_id
      LEFT JOIN public.branches b   ON b.id = m.branch_id
      LEFT JOIN public.status_labels s ON s.domain = 'role' AND s.code = m.role
     WHERE m.org_id = p_org), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_add_member(
  p_org uuid, p_email text, p_role text, p_branch uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_m     public.memberships;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN'); END IF;
  IF v_email = '' THEN PERFORM app.fail('MRS_REQUIRED', 'email'); END IF;
  IF char_length(v_email) > 160 OR NOT app.is_email(v_email) THEN PERFORM app.fail('MRS_INVALID', 'email'); END IF;
  -- staff roles only: portal clients are linked through client_users, not here
  IF p_role IS NULL OR NOT (p_role = ANY (app.staff_roles())) THEN PERFORM app.fail('MRS_INVALID', 'role'); END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.branches b WHERE b.id = p_branch AND b.org_id = p_org AND b.is_active) THEN
    PERFORM app.fail('MRS_INVALID', 'branch');
  END IF;

  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;
  IF v_user IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'email'); END IF;

  INSERT INTO public.profiles (id) VALUES (v_user) ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_m FROM public.memberships m
   WHERE m.user_id = v_user AND m.org_id = p_org AND m.role = p_role
     AND m.branch_id IS NOT DISTINCT FROM p_branch
   FOR UPDATE;
  IF v_m.id IS NOT NULL THEN
    IF v_m.is_active THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'membership already exists';
    END IF;
    UPDATE public.memberships m SET is_active = true WHERE m.id = v_m.id RETURNING * INTO v_m;
  ELSE
    INSERT INTO public.memberships (user_id, org_id, branch_id, role, created_by)
    VALUES (v_user, p_org, p_branch, p_role, auth.uid())
    RETURNING * INTO v_m;
  END IF;

  RETURN jsonb_build_object('id', v_m.id, 'user_id', v_m.user_id, 'org_id', v_m.org_id,
                            'branch_id', v_m.branch_id, 'role', v_m.role, 'is_active', v_m.is_active);
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_member_active(p_membership uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m public.memberships; v_admins int;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  SELECT * INTO v_m FROM public.memberships m WHERE m.id = p_membership FOR UPDATE;
  IF v_m.id IS NULL OR NOT app.has_role(v_m.org_id, ARRAY['admin']) THEN PERFORM app.fail('MRS_NOT_FOUND'); END IF;
  IF p_active IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'status'); END IF;
  IF v_m.is_active = p_active THEN PERFORM app.fail('MRS_BAD_TRANSITION', 'same_status'); END IF;
  IF NOT p_active THEN
    IF v_m.user_id = auth.uid() THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    IF v_m.role = 'admin' THEN
      SELECT count(*) INTO v_admins FROM public.memberships m
       WHERE m.org_id = v_m.org_id AND m.role = 'admin' AND m.is_active AND m.id <> v_m.id;
      IF v_admins = 0 THEN PERFORM app.fail('MRS_FORBIDDEN', 'role'); END IF;
    END IF;
  END IF;
  UPDATE public.memberships m SET is_active = p_active WHERE m.id = v_m.id RETURNING * INTO v_m;
  RETURN jsonb_build_object('id', v_m.id, 'is_active', v_m.is_active, 'role', v_m.role);
END $$;

REVOKE EXECUTE ON FUNCTION
  public.admin_list_members(uuid), public.admin_add_member(uuid, text, text, uuid),
  public.admin_set_member_active(uuid, boolean)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.admin_list_members(uuid), public.admin_add_member(uuid, text, text, uuid),
  public.admin_set_member_active(uuid, boolean)
TO authenticated;
