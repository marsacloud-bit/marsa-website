-- Make an existing Supabase Auth user a PLATFORM ADMIN (مدير المنصة) — STAGING.
-- Run in Supabase SQL Editor after creating the user in Authentication → Users
-- and after migration 20261102000200_orgs_branches_invites.sql.
-- Replace <platform-admin-email> below (twice) with the operator's e-mail.
-- A platform admin manages organizations only (platform.html); it is NOT a member of
-- any tenant and gets no access to tenant operational data.
-- To remove: DELETE FROM public.platform_admins WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = lower('<platform-admin-email>'));
DO $$
DECLARE
  v_email text := '<platform-admin-email>';
  v_uid   uuid;
BEGIN
  IF v_email LIKE '<%' THEN
    RAISE EXCEPTION 'Edit the file first: replace <platform-admin-email> with a real address.';
  END IF;
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'User % not found. Create it first in Authentication → Users (tick Auto Confirm).', v_email;
  END IF;
  INSERT INTO public.profiles (id) VALUES (v_uid) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.platform_admins (user_id, note) VALUES (v_uid, 'added from SQL Editor')
  ON CONFLICT (user_id) DO NOTHING;
END $$;

SELECT u.email, pa.created_at
  FROM public.platform_admins pa
  JOIN auth.users u ON u.id = pa.user_id
 WHERE lower(u.email) = lower('<platform-admin-email>');
