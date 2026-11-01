/* ==========================================================================
   مرسى | MARSA — runtime configuration (STAGING)
   --------------------------------------------------------------------------
   Leave supabaseUrl / supabaseAnonKey EMPTY to keep the site in local DEMO
   mode (localStorage only, demo banner, no network requests besides fonts).

   To connect the STAGING Supabase project (test data only):
     supabaseUrl:     Project Settings → API → Project URL
                      e.g. 'https://<project-ref>.supabase.co'
     supabaseAnonKey: Project Settings → API → "anon" / "publishable" key.
                      This key is public by design; RLS protects the data.

   NEVER put the service_role / "secret" key here (or anywhere in the
   frontend). assets/js/supa.js refuses to start if it detects one.

   orgSlug: the tenant whose public forms this site feeds ('blue-sea').
   Load order on every page:  config.js → i18n.js → [assets/i18n/<page>.js] → main.js → supa.js → <page>.js
   ========================================================================== */
window.MARSA_CONFIG = {
  supabaseUrl: 'https://cgzhidyxfpksfckwmauq.supabase.co',
  supabaseAnonKey: 'sb_publishable_LDvCFb0-OLizS2e62cWsHg_xNSf9U5j',
  orgSlug: 'blue-sea',
  environment: 'staging'
};
