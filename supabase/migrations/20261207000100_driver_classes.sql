-- =====================================================================
-- 20261207000100_driver_classes — the drivers directory: classification (individual / company or establishment /
-- contractor), the party it belongs to, the truck it works on (2026-11-20, owner stage 3د,
-- docs/owner/transaction-stages-request.md; branch owner/ui-reorg)
--   Owner: one place for the drivers, easy to reach: name, mobile, the truck plate, the classification (individual,
--   belongs to an establishment / company, or to a contractor) and that company's / contractor's details.
--   The tables exist (public.drivers / public.trucks / public.parties, 20261103000100; last_truck_id 20261118000100).
--   1. public.status_labels domain 'driver_class' (settings, not a CHECK): individual · company · contractor.
--   2. public.drivers.driver_class text NULL (NULL = not classified yet, e.g. a driver created from an appointment card).
--      app.tg_drivers_class_before: the class must be a status_labels code; an individual has no party (carrier_id NULL).
--      A company or a contractor is a party with the kind 'carrier' (its details — name, phone, CR, contact — live on the
--      party: «الجهات والناقلون»); no new party kind, so the parties kinds CHECK is untouched.
--   3. public.list_drivers(p_org, p_q) → [{id, full_name, phone, driver_class, license_no, is_active, truck_plate,
--      party {id, name_ar, name_en, phone, cr_number, contact_name}}] — staff of the org; search by name / phone / plate /
--      party name; 500 rows (active first).
--   4. public.save_driver(p_org, p) → the driver row as list_drivers returns it — transport writers of the org.
--      keys: id?, full_name, phone (Saudi mobile, normalised), driver_class (absent / null = keep the driver's class, NULL for
--      a new or unclassified driver: the active toggle never forces a classification), carrier_id (company / contractor;
--      absent = keep the driver's party), truck_plate
--      (found by its normalised plate in the org or created with the driver's party), license_no, is_active.
--      Another active driver with the same mobile → MRS_CONFLICT phone. An inactive truck plate → MRS_INVALID truck_plate.
--   Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS + CREATE / ON CONFLICT).
--   Data: none changed (existing drivers stay unclassified until edited).
--   Down-path: DROP FUNCTION public.save_driver(uuid, jsonb), public.list_drivers(uuid, text), app.driver_json(public.drivers), app.tg_drivers_class_before()
--   (+ DROP TRIGGER trg_class ON public.drivers); ALTER TABLE public.drivers DROP COLUMN driver_class;
--   DELETE FROM public.status_labels WHERE domain = 'driver_class'; DELETE FROM public.schema_versions WHERE version = '20261207000100'.
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261206000100') THEN
    RAISE EXCEPTION 'DRIVER CLASSES preflight: apply storage_gate first (schema_versions lacks 20261206000100)';
  END IF;
  IF to_regclass('public.drivers') IS NULL OR to_regclass('public.trucks') IS NULL OR to_regprocedure('app.norm_sa_phone(text,boolean)') IS NULL
     OR to_regprocedure('app.transport_writer_roles()') IS NULL THEN
    RAISE EXCEPTION 'DRIVER CLASSES preflight: drivers / trucks / norm_sa_phone / transport_writer_roles missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261207000100', 'driver_classes')
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------
-- 1. the classes (settings)
-- ---------------------------------------------------------------------
INSERT INTO public.status_labels (domain, code, sort, label_ar, label_en, client_visible) VALUES
  ('driver_class', 'individual', 1, 'فردي',                    'Individual',                         false),
  ('driver_class', 'company',    2, 'تابع لمؤسسة أو شركة',     'Belongs to an establishment / company', false),
  ('driver_class', 'contractor', 3, 'تابع لمتعهد',             'Belongs to a contractor',            false)
ON CONFLICT (domain, code) DO UPDATE SET sort = EXCLUDED.sort, label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
  client_visible = EXCLUDED.client_visible;

-- ---------------------------------------------------------------------
-- 2. the class of a driver
-- ---------------------------------------------------------------------
ALTER TABLE public.drivers ADD COLUMN IF NOT EXISTS driver_class text;
COMMENT ON COLUMN public.drivers.driver_class IS 'Driver classification (20261207000100): status_labels driver_class; NULL = not classified yet. company / contractor → carrier_id = the party (kind carrier).';

-- definer: the class list (status_labels via app.is_code) is checked whoever writes; not callable directly
CREATE OR REPLACE FUNCTION app.tg_drivers_class_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.driver_class IS NOT NULL AND NOT app.is_code('driver_class', NEW.driver_class) THEN
    PERFORM app.fail('MRS_INVALID', 'driver_class');
  END IF;
  IF NEW.driver_class = 'individual' AND NEW.carrier_id IS NOT NULL THEN
    PERFORM app.fail('MRS_INVALID', 'carrier_id');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.tg_drivers_class_before() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_class ON public.drivers;
CREATE TRIGGER trg_class BEFORE INSERT OR UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION app.tg_drivers_class_before();

-- ---------------------------------------------------------------------
-- 3. the directory
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.driver_json(d public.drivers) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', d.id, 'full_name', d.full_name, 'phone', d.phone, 'driver_class', d.driver_class,
    'license_no', d.license_no, 'is_active', d.is_active, 'updated_at', d.updated_at,
    'truck_plate', (SELECT k.plate_no FROM public.trucks k WHERE k.id = d.last_truck_id),
    'party', (SELECT jsonb_build_object('id', p.id, 'name_ar', p.name_ar, 'name_en', p.name_en, 'phone', p.phone,
                                        'cr_number', p.cr_number, 'contact_name', p.contact_name, 'is_active', p.is_active)
                FROM public.parties p WHERE p.id = d.carrier_id))
$$;
REVOKE ALL ON FUNCTION app.driver_json(public.drivers) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_drivers(p_org uuid, p_q text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_q text := nullif(btrim(coalesce(p_q, '')), ''); v_qp text;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.is_staff(p_org) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
  IF v_q IS NOT NULL AND char_length(v_q) > 60 THEN PERFORM app.fail('MRS_INVALID', 'q'); END IF;
  v_qp := app.norm_sa_phone(v_q, false);
  RETURN coalesce((
    SELECT jsonb_agg(app.driver_json(d) ORDER BY d.is_active DESC, d.full_name, d.id)
      FROM (SELECT d.* FROM public.drivers d
             WHERE d.org_id = p_org
               AND (v_q IS NULL
                    OR d.full_name ILIKE '%' || v_q || '%'
                    OR d.phone LIKE '%' || v_q || '%'
                    OR (v_qp IS NOT NULL AND app.norm_sa_phone(d.phone, false) = v_qp)
                    OR EXISTS (SELECT 1 FROM public.trucks k WHERE k.id = d.last_truck_id AND k.plate_no ILIKE '%' || replace(v_q, ' ', '') || '%')
                    OR EXISTS (SELECT 1 FROM public.parties p WHERE p.id = d.carrier_id AND (p.name_ar ILIKE '%' || v_q || '%' OR p.name_en ILIKE '%' || v_q || '%')))
             ORDER BY d.is_active DESC, d.full_name, d.id LIMIT 500) d), '[]'::jsonb);
END $$;
REVOKE EXECUTE ON FUNCTION public.list_drivers(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_drivers(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. save a driver (with its class, party and truck)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_driver(p_org uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_d public.drivers; v_name text; v_phone_raw text; v_phone text; v_class text; v_carrier uuid;
        v_plate_raw text; v_plate text; v_k public.trucks; v_lic text; v_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN PERFORM app.fail('MRS_AUTH_REQUIRED'); END IF;
  IF p_org IS NULL OR NOT app.has_role(p_org, app.transport_writer_roles()) THEN PERFORM app.fail('MRS_FORBIDDEN', 'organization'); END IF;
  PERFORM app.only_keys(p, ARRAY['id','full_name','phone','driver_class','carrier_id','truck_plate','license_no','is_active']);
  v_id := app.puuid(p, 'id');
  IF v_id IS NOT NULL THEN
    SELECT * INTO v_d FROM public.drivers d WHERE d.id = v_id AND d.org_id = p_org FOR UPDATE;
    IF v_d.id IS NULL THEN PERFORM app.fail('MRS_NOT_FOUND', 'driver'); END IF;
  END IF;
  v_name := app.ptext(p, 'full_name', 120);
  IF v_name IS NULL OR char_length(v_name) < 2 THEN PERFORM app.fail('MRS_REQUIRED', 'full_name'); END IF;
  v_phone_raw := app.ptext(p, 'phone', 30);
  IF v_phone_raw IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'phone'); END IF;
  v_phone := app.norm_sa_phone(v_phone_raw, false);
  IF v_phone IS NULL THEN PERFORM app.fail('MRS_INVALID', 'phone'); END IF;
  -- no driver_class in the payload (absent / null / '') keeps the driver's class — NULL for a new or unclassified driver:
  -- activating / deactivating (the directory toggle) or an edit without the class never forces a classification
  v_class := CASE WHEN nullif(btrim(coalesce(p ->> 'driver_class', '')), '') IS NOT NULL THEN app.ptext(p, 'driver_class', 30)
                  ELSE v_d.driver_class END;
  IF v_class IS NOT NULL AND NOT app.is_code('driver_class', v_class) THEN PERFORM app.fail('MRS_INVALID', 'driver_class'); END IF;
  -- no carrier_id key keeps the driver's party
  v_carrier := CASE WHEN p ? 'carrier_id' THEN app.puuid(p, 'carrier_id') ELSE v_d.carrier_id END;
  IF v_class = 'individual' THEN v_carrier := NULL;
  ELSIF v_class IS NOT NULL AND v_carrier IS NULL THEN PERFORM app.fail('MRS_REQUIRED', 'carrier_id');
  END IF;
  IF v_carrier IS NOT NULL AND (p ? 'carrier_id' OR p ? 'driver_class')
     AND NOT EXISTS (SELECT 1 FROM public.parties x WHERE x.id = v_carrier AND x.org_id = p_org AND 'carrier' = ANY (x.kinds)) THEN
    PERFORM app.fail('MRS_INVALID', 'carrier_id');
  END IF;
  v_lic := app.ptext(p, 'license_no', 30);
  v_active := CASE WHEN p ? 'is_active' THEN coalesce((p ->> 'is_active')::boolean, true) ELSE coalesce(v_d.is_active, true) END;
  -- one active driver per mobile in the org (compared normalised: the registry may keep older spellings)
  IF v_active AND EXISTS (SELECT 1 FROM public.drivers o WHERE o.org_id = p_org AND o.is_active AND o.id IS DISTINCT FROM v_id
                            AND (o.phone = v_phone OR app.norm_sa_phone(o.phone, false) = v_phone)) THEN
    PERFORM app.fail('MRS_CONFLICT', 'phone');
  END IF;
  v_plate_raw := app.ptext(p, 'truck_plate', 30);
  IF v_plate_raw IS NOT NULL THEN
    v_plate := app.norm_code(replace(translate(v_plate_raw, 'أإآ', 'ااا'), '-', ''));
    IF v_plate IS NULL OR char_length(v_plate) NOT BETWEEN 2 AND 20 THEN PERFORM app.fail('MRS_INVALID', 'truck_plate'); END IF;
    SELECT * INTO v_k FROM public.trucks k WHERE k.org_id = p_org AND k.plate_no = v_plate;
    IF v_k.id IS NULL THEN
      INSERT INTO public.trucks (org_id, carrier_id, plate_no, created_by) VALUES (p_org, v_carrier, v_plate, auth.uid()) RETURNING * INTO v_k;
    ELSIF NOT v_k.is_active THEN
      PERFORM app.fail('MRS_INVALID', 'truck_plate');
    END IF;
  END IF;
  IF v_d.id IS NULL THEN
    INSERT INTO public.drivers (org_id, carrier_id, full_name, phone, driver_class, license_no, is_active, last_truck_id, created_by)
    VALUES (p_org, v_carrier, v_name, v_phone, v_class, v_lic, v_active, v_k.id, auth.uid()) RETURNING * INTO v_d;
  ELSE
    UPDATE public.drivers d SET carrier_id = v_carrier, full_name = v_name, phone = v_phone, driver_class = v_class, license_no = v_lic,
           is_active = v_active, last_truck_id = CASE WHEN p ? 'truck_plate' THEN v_k.id ELSE d.last_truck_id END
     WHERE d.id = v_d.id RETURNING * INTO v_d;
  END IF;
  RETURN app.driver_json(v_d);
END $$;
REVOKE EXECUTE ON FUNCTION public.save_driver(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_driver(uuid, jsonb) TO authenticated;
