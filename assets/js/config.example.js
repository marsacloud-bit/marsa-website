/* ==========================================================================
   مرسى | MARSA — runtime configuration TEMPLATE
   --------------------------------------------------------------------------
   Copy this file to assets/js/config.js and fill it for the environment you
   deploy. This file itself is never loaded by any page.

   Environments (see docs/online/ENVIRONMENTS_AR.md):
     demo        supabaseUrl + supabaseAnonKey EMPTY → localStorage only,
                 demo banner, no network requests besides Google Fonts.
     staging     the staging Supabase project (test data only).
     production  does not exist yet; needs owner approval first.

   config.js may contain ONLY public values. The anon / "publishable" key is
   public by design (RLS protects the data). NEVER put the service_role /
   "secret" key (sb_secret_…), the database password or a connection string
   here or anywhere in the frontend — assets/js/supa.js refuses to start if
   it detects a secret key.

   Load order on every page:
     config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js
   ========================================================================== */
window.MARSA_CONFIG = {
  // Project Settings → API → Project URL, e.g. 'https://<project-ref>.supabase.co'.
  // Empty string = demo mode.
  supabaseUrl: '',

  // Project Settings → API → "anon" / "publishable" key (sb_publishable_… or
  // the legacy anon JWT). Empty string = demo mode.
  supabaseAnonKey: '',

  // Slug of the tenant (organizations.slug) that the public forms
  // (request.html, contact.html, tracking.html) submit to.
  orgSlug: 'blue-sea',

  // Shown in the environment banner: 'staging' | 'production'.
  // Informational only; the server decides (organizations.environment).
  environment: 'staging',

  // Optional. Initial UI language when the visitor has not chosen one
  // (localStorage 'marsa_lang' wins): 'ar' (default, RTL) | 'en'.
  defaultLocale: 'ar'
};
