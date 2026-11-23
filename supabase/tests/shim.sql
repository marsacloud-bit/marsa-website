-- =====================================================================
-- shim.sql — LOCAL TESTS ONLY (PGlite / plain Postgres 16). NEVER run on Supabase.
-- Recreates the minimum Supabase objects the migrations reference:
--   roles anon / authenticated / service_role, schema auth (users, mfa_factors, uid(), jwt() with default aal2),
--   schema storage (buckets, objects, foldername()) and Supabase-like default grants.
-- Simulate a signed-in user:
--   SET ROLE authenticated;
--   SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', false);
-- Simulate a visitor: SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_confirmed_at timestamptz,          -- NULL until the user confirms the address (Supabase Auth)
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
-- MFA (20261109000100): real Supabase access tokens always carry "aal". The suites written before MFA mint claims
-- without it, so a token with "sub" but no "aal" gets "aal":"aal2" injected (their baseline stays identical).
-- SELECT set_config('marsa_test.default_aal', 'none', false) disables the injection (a missing claim = aal1 in the DB);
-- any other value (e.g. 'aal1') is injected instead.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN c ? 'sub' AND NOT c ? 'aal'
                   AND coalesce(nullif(current_setting('marsa_test.default_aal', true), ''), 'aal2') <> 'none'
              THEN c || jsonb_build_object('aal', coalesce(nullif(current_setting('marsa_test.default_aal', true), ''), 'aal2'))
              ELSE c END
    FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb c) x
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'role'
$$;
-- Supabase Auth MFA factors (minimal: the columns the MFA helpers read; enums are plain text here, the migration
-- compares factor_type::text / status::text). Created before the migrations: sql helper bodies are validated at
-- CREATE time. No grant to anon / authenticated (as on Supabase).
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  friendly_name text,
  factor_type text NOT NULL DEFAULT 'totp',
  status text NOT NULL DEFAULT 'unverified',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt(), auth.role() TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1 : greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;
CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text) TO anon, authenticated, service_role;

-- Supabase grants API roles broad table privileges by default; RLS is what protects data.
-- Reproduce that so tests prove the policies (not missing grants) do the protecting.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Supabase Vault (20261209000100 stores the AI provider keys there). The real Vault encrypts the secret at rest and
-- decrypts it in vault.decrypted_secrets; this stand-in keeps the same names and signatures in plain text (tests only).
-- No API role gets any privilege on it (as on Supabase: only SECURITY DEFINER code reaches it).
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  description text NOT NULL DEFAULT '',
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT s.id, s.name, s.description, s.secret, s.secret AS decrypted_secret, s.created_at, s.updated_at FROM vault.secrets s;
CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '', new_key_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO vault.secrets (secret, name, description) VALUES (new_secret, new_name, coalesce(new_description, '')) RETURNING id
$$;
CREATE OR REPLACE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  UPDATE vault.secrets s SET secret = coalesce(new_secret, s.secret), name = coalesce(new_name, s.name),
         description = coalesce(new_description, s.description), updated_at = now() WHERE s.id = secret_id
$$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid) FROM PUBLIC;
