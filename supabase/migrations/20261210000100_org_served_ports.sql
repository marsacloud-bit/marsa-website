-- =====================================================================
-- 20261210000100_org_served_ports — the ports each office serves, shown on its website (2026-11-22, owner;
-- branch owner/office-home, docs/owner/sections-decisions.md)
--   Owner: some customs brokers work only at certain ports; each office picks the ports it serves, and only those
--   appear on its website. The list of ports is the platform's (public.customs_ports, 20261117000100); offices choose
--   from it. Owner: the land crossings registered in FASAH are two (Salwa, Al Haditha); the airports are four (+ Madinah).
--   1. public.customs_ports: kind 'land' allowed (the kind CHECK re-created with sea / air / dry / land); three ports
--      added: Salwa and Al Haditha customs (land), Prince Mohammad bin Abdulaziz airport, Madinah (air).
--      Their codes follow the table's pattern (5 letters, -AIR for an airport); confirm the official UN/LOCODEs before
--      any integration relies on them.
--   2. public.org_served_ports (org_id, port_code → customs_ports, sort): staff of the org read; writes only through
--      save_served_ports (no direct write grant); audited (app.tg_audit); RLS; nothing for anon.
--   3. public.get_served_ports(p_org) → [{code, kind, name_ar, name_en, served, sort}] — every active platform port
--      with the office's choice; staff of the org.
--   4. public.save_served_ports(p_org, p_codes text[]) → the same list — org admins; the order of p_codes is kept;
--      unknown / inactive codes → MRS_INVALID port_code; at most 50.
--   5. public.site_served_ports(p_org_slug) → [{code, kind, name_ar, name_en}] — anon + authenticated, the public
--      website: only active ports an active office chose; nothing else about the office. Unknown slug → [].
--   6. the in-place conversion keeps the choice (configuration): app.convert_keep_tables = the 20261209000100 body +
--      public.org_served_ports.
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS + CREATE / ON CONFLICT).
--   Data: no office has a choice yet (the website hides the ports block until an admin picks them).
--   Down-path: re-create app.convert_keep_tables (20261209000100 body); DROP FUNCTION public.site_served_ports(text),
--   public.save_served_ports(uuid, text[]), public.get_served_ports(uuid), app.served_ports_json(uuid); DROP TABLE
--   public.org_served_ports; DELETE FROM public.customs_ports WHERE code IN ('SASLW','SAHDT','SAMED-AIR') (only when no
--   row references them); re-create customs_ports_kind_check with sea / air / dry;
--   DELETE FROM public.schema_versions WHERE version = '20261210000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261209000100') THEN
    RAISE EXCEPTION 'SERVED PORTS preflight: apply ai_keys first (schema_versions lacks 20261209000100)';
  END IF;
  IF to_regclass('public.customs_ports') IS NULL OR to_regprocedure('app.is_staff(uuid)') IS NULL
     OR to_regprocedure('app.has_role(uuid,text[])') IS NULL THEN
    RAISE EXCEPTION 'SERVED PORTS preflight: customs_ports / is_staff / has_role missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261210000100', 'org_served_ports')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. land crossings + the Madinah airport
-- ---------------------------------------------------------------------
ALTER TABLE public.customs_ports DROP CONSTRAINT IF EXISTS customs_ports_kind_check;
ALTER TABLE public.customs_ports ADD CONSTRAINT customs_ports_kind_check CHECK (kind IN ('sea','air','dry','land'));

INSERT INTO public.customs_ports (code, unlocode, kind, name_ar, name_en, daftra_value, sort) VALUES
  ('SAMED-AIR','SAMED','air','مطار الأمير محمد بن عبدالعزيز الدولي بالمدينة المنورة','Prince Mohammad bin Abdulaziz International Airport, Madinah',NULL,8),
  ('SASLW','SASLW','land','جمرك سلوى','Salwa Customs',NULL,9),
  ('SAHDT','SAHDT','land','جمرك الحديثة','Al Haditha Customs',NULL,10)
ON CONFLICT (code) DO UPDATE
  SET unlocode = EXCLUDED.unlocode, kind = EXCLUDED.kind, name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, sort = EXCLUDED.sort;

-- ---------------------------------------------------------------------
-- 2. the office's choice
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_served_ports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  port_code   text NOT NULL REFERENCES public.customs_ports(code),
  sort        int  NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 1000),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_served_ports_uniq UNIQUE (org_id, port_code),
  UNIQUE (id, org_id)
);
COMMENT ON TABLE public.org_served_ports IS 'Ports the office serves (20261210000100): chosen by an org admin from public.customs_ports; shown on the office website (site_served_ports). Written only through save_served_ports.';

DROP TRIGGER IF EXISTS trg_touch ON public.org_served_ports;
CREATE TRIGGER trg_touch BEFORE UPDATE ON public.org_served_ports FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
DROP TRIGGER IF EXISTS trg_stamp ON public.org_served_ports;
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.org_served_ports FOR EACH ROW EXECUTE FUNCTION app.tg_stamp_creator();
DROP TRIGGER IF EXISTS trg_guard ON public.org_served_ports;
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.org_served_ports
  FOR EACH ROW EXECUTE FUNCTION app.tg_guard_generic('id', 'org_id', 'port_code', 'created_by', 'created_at');
DROP TRIGGER IF EXISTS trg_audit ON public.org_served_ports;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.org_served_ports FOR EACH ROW EXECUTE FUNCTION app.tg_audit();

ALTER TABLE public.org_served_ports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_served_ports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.org_served_ports TO authenticated;
SELECT app.drop_policies('org_served_ports');
CREATE POLICY org_served_ports_select ON public.org_served_ports FOR SELECT TO authenticated USING (app.is_staff(org_id));

-- ---------------------------------------------------------------------
-- 3. read the choice (every active port + served flag)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.served_ports_json(p_org uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind, 'name_ar', c.name_ar, 'name_en', c.name_en,
                                               'served', s.id IS NOT NULL, 'sort', s.sort)
                            ORDER BY (s.id IS NULL), s.sort, c.sort, c.code), '[]'::jsonb)
    FROM public.customs_ports c
    LEFT JOIN public.org_served_ports s ON s.org_id = p_org AND s.port_code = c.code
   WHERE c.is_active
$$;
REVOKE ALL ON FUNCTION app.served_ports_json(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_served_ports(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
  RETURN app.served_ports_json(p_org);
END $$;
REVOKE EXECUTE ON FUNCTION public.get_served_ports(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_served_ports(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. save the choice (org admins)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_served_ports(p_org uuid, p_codes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_codes text[] := '{}'; v_c text; i int := 0;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, ARRAY['admin']) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
  IF p_codes IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'port_codes'); END IF;
  IF cardinality(p_codes) > 50 THEN PERFORM app.fail('MRS_INVALID', 'port_codes'); END IF;
  FOREACH v_c IN ARRAY p_codes LOOP
    v_c := upper(btrim(coalesce(v_c, '')));
    IF NOT EXISTS (SELECT 1 FROM public.customs_ports c WHERE c.code = v_c AND c.is_active) THEN
      PERFORM app.fail('MRS_INVALID', 'port_code');
    END IF;
    IF NOT v_c = ANY (v_codes) THEN v_codes := v_codes || v_c; END IF;
  END LOOP;
  DELETE FROM public.org_served_ports s WHERE s.org_id = p_org AND NOT s.port_code = ANY (v_codes);
  FOREACH v_c IN ARRAY v_codes LOOP
    i := i + 1;
    INSERT INTO public.org_served_ports (org_id, port_code, sort) VALUES (p_org, v_c, i)
    ON CONFLICT (org_id, port_code) DO UPDATE SET sort = EXCLUDED.sort
      WHERE public.org_served_ports.sort IS DISTINCT FROM EXCLUDED.sort;
  END LOOP;
  RETURN app.served_ports_json(p_org);
END $$;
REVOKE EXECUTE ON FUNCTION public.save_served_ports(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_served_ports(uuid, text[]) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. the public website: the office's ports only
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_served_ports(p_org_slug text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_org_slug IS NULL OR p_org_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' THEN RETURN '[]'::jsonb; END IF;
  SELECT o.id INTO v_org FROM public.organizations o WHERE o.slug = p_org_slug AND o.is_active;
  IF v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('code', c.code, 'kind', c.kind, 'name_ar', c.name_ar, 'name_en', c.name_en)
                     ORDER BY s.sort, c.sort, c.code)
      FROM public.org_served_ports s JOIN public.customs_ports c ON c.code = s.port_code AND c.is_active
     WHERE s.org_id = v_org), '[]'::jsonb);
END $$;
REVOKE EXECUTE ON FUNCTION public.site_served_ports(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_served_ports(text) TO anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. the in-place conversion (20261115000100) keeps the choice: configuration, not test data
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.convert_keep_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'public.branches', 'public.memberships', 'public.org_counters', 'public.org_usage_counters',
    'public.msg_channels', 'public.msg_settings', 'public.msg_auto_reply_policies', 'public.msg_templates',
    'public.msg_instructions', 'public.daftra_connections', 'public.daftra_item_links', 'public.document_requirements',
    'public.org_subscriptions', 'public.subscription_events', 'app.ai_settings',
    'public.org_service_items',                                                                         -- LEGACY
    'public.tx_stage_sets', 'public.tx_stage_steps',                                                    -- owner stages
    'public.storage_gate_ports',                                                                        -- storage gate (20261206000100)
    'app.ai_provider_keys',                                                                            -- AI keys (20261209000100): configuration, kept
    'public.org_served_ports',                                                                          -- served ports (20261210000100): configuration, kept
    -- append-only / log tables
    'public.audit_log', 'public.report_exports', 'app.ai_usage', 'public.operational_alert_runs', 'public.client_errors'
  ]::text[]
$$;
REVOKE EXECUTE ON FUNCTION app.convert_keep_tables() FROM PUBLIC, anon, authenticated, service_role;
