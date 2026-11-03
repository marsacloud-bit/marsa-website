/* ==========================================================================
   مرسى | MARSA — runtime configuration TEMPLATE (PRODUCTION)
   --------------------------------------------------------------------------
   Reference only: never loaded by any page, never published. The production
   site gets its assets/js/config.js from scripts/build-release.sh, which
   writes this same shape from the environment variables
     PROD_SUPABASE_URL      → supabaseUrl
     PROD_PUBLISHABLE_KEY   → supabaseAnonKey
     PROD_ORG_SLUG          → orgSlug
   so nothing about production is committed. The repository's own
   assets/js/config.js stays the STAGING one.

   Production is a NEW, separate Supabase project (not the staging ref
   cgzhidyxfpksfckwmauq) whose database was built from
   scripts/build-production-sql.py (all migrations, no seed.sql, no demo
   organization 'blue-sea').

   config.js may contain ONLY public values. The "publishable" key
   (sb_publishable_…) is public by design (RLS protects the data). NEVER put
   the "secret" key (sb_secret_…), a service_role JWT, the database password
   or a connection string here — build-release.sh refuses them, and
   assets/js/supa.js refuses to start if it detects one.

   environment: 'production' hides the environment banner and shows the
   production privacy line (assets/js/main.js); any other value keeps the
   staging chrome.

   Load order on every page:  config.js → i18n.js → [assets/i18n/<page>.js] → main.js → supa.js → <page>.js
   ========================================================================== */
window.MARSA_CONFIG = {
  // Project Settings → API → Project URL of the PRODUCTION project
  supabaseUrl: 'https://<PROD_PROJECT_REF>.supabase.co',
  // Project Settings → API Keys → "publishable" key of the PRODUCTION project
  supabaseAnonKey: '<PROD_PUBLISHABLE_KEY>',
  // organizations.slug of the production tenant that the public forms
  // (request.html, contact.html, tracking.html) submit to — never 'blue-sea'
  orgSlug: '<PROD_ORG_SLUG>',
  environment: 'production'
};
